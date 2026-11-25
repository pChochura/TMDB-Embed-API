const axios = require('axios');
const { config } = require('../utils/config');
const { resolveVidcoreInProcess } = require('./vidcore/resolver');

/**
 * Resolves base URL dynamically from context, user-config, or environment.
 * If unset or 'internal', returns null indicating in-process resolution.
 */
function getBaseUrl(ctx = {}) {
  const custom = ctx?.vidcoreResolverBase || (config && config.vidcoreResolverBase) || process.env.VIDCORE_RESOLVER_BASE;
  if (!custom || custom === 'internal') {
    return null;
  }
  return custom.replace(/\/+$/, '');
}

/**
 * Parses NDJSON or JSON response from vidcore resolver into raw stream items.
 *
 * @param {string|Object} rawData
 * @returns {Array<Object>}
 */
function parseResolverPayload(rawData) {
  if (!rawData) return [];

  // If already parsed JSON object/array
  if (typeof rawData === 'object') {
    if (Array.isArray(rawData)) return rawData;
    if (Array.isArray(rawData.streams)) return rawData.streams;
    if (Array.isArray(rawData.sources)) return rawData.sources;
    if (rawData.url || rawData.file || rawData.play || rawData.stream) return [rawData];
  }

  // If string, handle NDJSON (newline-delimited JSON) or JSON string
  if (typeof rawData === 'string') {
    const trimmed = rawData.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        return parseResolverPayload(parsed);
      } catch {
        // Fall through to NDJSON parsing
      }
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        // Fall through to NDJSON parsing
      }
    }

    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const extracted = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'server' && evt.server && evt.server.status === 'ok') {
          extracted.push({
            server: evt.server.name,
            name: evt.server.name,
            url: evt.server.url,
            play: evt.server.play,
            quality: 'Auto',
            headers: {
              ...(evt.server.userAgent ? { 'User-Agent': evt.server.userAgent } : {}),
              'Referer': evt.server.refererUrl || 'https://vidcore.io/',
              'Origin': 'https://vidcore.io'
            }
          });
        }
      } catch {
        // ignore unparseable line
      }
    }
    return extracted;
  }

  return [];
}

/**
 * Resolves VidCore streams either natively in-process or via configured upstream base URL.
 *
 * @param {string|number|Object} tmdbId TMDB ID or context object
 * @param {'movie'|'series'|'tv'} [mediaType='movie']
 * @param {number|string} [season]
 * @param {number|string} [episode]
 * @param {Object} [ctx]
 * @returns {Promise<Array<Object>>}
 */
async function getVidcoreStreams(tmdbId, mediaType = 'movie', season = null, episode = null, ctx = {}) {
  let effectiveCtx = ctx || {};
  let effectiveTmdbId = tmdbId;
  let effectiveMediaType = mediaType;
  let effectiveSeason = season;
  let effectiveEpisode = episode;

  if (typeof tmdbId === 'object' && tmdbId !== null) {
    effectiveCtx = tmdbId;
    effectiveTmdbId = effectiveCtx.tmdbId;
    effectiveMediaType = effectiveCtx.type || effectiveCtx.mediaType || 'movie';
    effectiveSeason = effectiveCtx.season ?? null;
    effectiveEpisode = effectiveCtx.episode ?? null;
  }

  if (!effectiveTmdbId) {
    return [];
  }

  const baseUrl = getBaseUrl(effectiveCtx);

  // If no external base URL is configured, resolve natively inside this application!
  if (!baseUrl) {
    try {
      return await resolveVidcoreInProcess(
        effectiveTmdbId,
        effectiveMediaType,
        effectiveSeason,
        effectiveEpisode
      );
    } catch (err) {
      console.error(`[VidCore] In-process extraction failed for ${effectiveMediaType} ${effectiveTmdbId}:`, err.message);
      return [];
    }
  }

  // Fallback to HTTP resolver if an external URL is explicitly supplied
  try {
    const isMovie = effectiveMediaType === 'movie';
    const s = effectiveSeason || 1;
    const e = effectiveEpisode || 1;

    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://vidcore.io/',
      'Origin': 'https://vidcore.io'
    };

    let rawStreams = [];

    // Attempt 1: Standard REST route (/movie/:id or /tv/:id/:season/:episode)
    const endpoint = isMovie
      ? `${baseUrl}/movie/${effectiveTmdbId}`
      : `${baseUrl}/tv/${effectiveTmdbId}/${s}/${e}`;

    try {
      const response = await axios.get(endpoint, {
        timeout: 12000,
        headers: { 'Accept': 'application/json, text/plain, */*' }
      });
      rawStreams = parseResolverPayload(response.data);
    } catch (restErr) {
      // If REST route is not present or failed, attempt direct NDJSON /api/resolve
      const resolveEndpoint = `${baseUrl}/api/resolve`;
      const queryType = isMovie ? 'movie' : 'tv';
      const response = await axios.get(resolveEndpoint, {
        params: {
          type: queryType,
          id: effectiveTmdbId,
          server: 'Orbit',
          ...(isMovie ? {} : { season: s, episode: e })
        },
        timeout: 12000,
        headers: { 'Accept': 'application/x-ndjson, text/plain, */*' },
        responseType: 'text'
      });
      rawStreams = parseResolverPayload(response.data);
    }

    if (!rawStreams.length) return [];

    return rawStreams
      .filter(item => item && (item.url || item.file || item.stream || item.play))
      .map((item, idx) => {
        const streamUrl = item.url || item.file || item.stream || item.play;
        const serverLabel = item.server || item.name || `Server ${idx + 1}`;
        const quality = item.quality || item.label || 'Auto';

        const mergedHeaders = {
          ...defaultHeaders,
          ...(item.headers || {})
        };

        const subtitles = Array.isArray(item.subtitles || item.tracks)
          ? (item.subtitles || item.tracks).map(sub => ({
              url: sub.url || sub.file,
              lang: sub.lang || sub.language || sub.label || 'en'
            }))
          : [];

        return {
          name: `VidCore (${serverLabel})`,
          title: `${quality} [VidCore - ${serverLabel}]`,
          url: streamUrl,
          quality: String(quality),
          provider: 'vidcore',
          headers: mergedHeaders,
          subtitles
        };
      });
  } catch (err) {
    console.error(`[VidCore] Extraction failed for ${effectiveMediaType} ${effectiveTmdbId}:`, err.message);
    return [];
  }
}

module.exports = { getVidcoreStreams, getBaseUrl, parseResolverPayload, resolveVidcoreInProcess };
