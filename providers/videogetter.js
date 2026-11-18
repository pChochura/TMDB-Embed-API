const axios = require('axios');
const { config } = require('../utils/config');

/**
 * Resolves base URL dynamically from context, user-config, or environment.
 */
function getBaseUrl(ctx = {}) {
  const custom = ctx?.videogetterApiBase || (config && config.videogetterApiBase) || process.env.VIDEOGETTER_API_BASE;
  return (custom || 'http://127.0.0.1:8088').replace(/\/+$/, '');
}

function getAuthHeaders(ctx = {}) {
  const origin = ctx?.videogetterOrigin || (config && config.videogetterOrigin) || process.env.VIDEOGETTER_ORIGIN || 'https://api.kineflex.site';
  const referer = ctx?.videogetterReferer || (config && config.videogetterReferer) || process.env.VIDEOGETTER_REFERER || 'https://api.kineflex.site/';
  const apiKey = ctx?.videogetterApiKey || (config && config.videogetterApiKey) || process.env.VIDEOGETTER_API_KEY || 'lakshya9310081539@';

  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': origin,
    'Referer': referer,
    'X-Api-Key': apiKey,
    'Accept': 'application/json'
  };
}

/**
 * Fetches and normalizes streams from api.videogetter for TMDB-Embed-API.
 *
 * @param {string|number|Object} tmdbId TMDB ID or context object
 * @param {'movie'|'series'|'tv'} [mediaType='movie']
 * @param {number|string} [season]
 * @param {number|string} [episode]
 * @param {Object} [ctx]
 * @returns {Promise<Array<Object>>}
 */
async function getVideogetterStreams(tmdbId, mediaType = 'movie', season = null, episode = null, ctx = {}) {
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

  try {
    const isMovie = effectiveMediaType === 'movie';
    const s = effectiveSeason || 1;
    const e = effectiveEpisode || 1;

    const baseUrl = getBaseUrl(effectiveCtx);
    const apiPrefix = baseUrl.endsWith('/api') ? '' : '/api';
    const endpoint = isMovie
      ? `${baseUrl}${apiPrefix}/movie/${effectiveTmdbId}`
      : `${baseUrl}${apiPrefix}/tv/${effectiveTmdbId}/${s}/${e}`;

    const headers = getAuthHeaders(effectiveCtx);

    const response = await axios.get(endpoint, {
      headers,
      timeout: 15000,
      maxRedirects: 5
    });

    const data = response.data;
    if (!data) return [];

    let rawList = [];
    if (Array.isArray(data)) {
      rawList = data;
    } else if (typeof data === 'object') {
      if (Array.isArray(data.streams)) {
        rawList = data.streams;
      } else if (Array.isArray(data.sources)) {
        rawList = data.sources;
      } else if (data.url || data.file || data.streamUrl || data.direct_url) {
        rawList = [data];
      }
    }

    return rawList
      .filter(item => item && (item.url || item.file || item.streamUrl || item.direct_url))
      .map((item, idx) => {
        const streamUrl = item.url || item.file || item.streamUrl || item.direct_url;
        const quality = item.quality || item.label || 'Auto';
        const sourceLabel = item.source || item.server || (item.tier ? `Tier ${item.tier}` : '');
        const serverName = sourceLabel ? ` (${sourceLabel})` : '';

        return {
          name: `VideoGetter${serverName}`,
          title: item.title ? `${quality} [${item.title}]` : `${quality} [VideoGetter #${idx + 1}]`,
          url: streamUrl,
          quality: String(quality),
          provider: 'videogetter',
          headers: item.headers && typeof item.headers === 'object' && Object.keys(item.headers).length > 0
            ? { ...item.headers }
            : {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(item.referer ? { Referer: item.referer } : {}),
                ...(item.origin ? { Origin: item.origin } : {})
              },
          subtitles: Array.isArray(item.subtitles)
            ? item.subtitles.map(sub => ({
                url: sub.url || sub.file,
                lang: sub.lang || sub.language || sub.label || 'en'
              }))
            : []
        };
      });
  } catch (error) {
    console.error(`[VideoGetter] Failed for ${effectiveMediaType} ${effectiveTmdbId}:`, error.message);
    return [];
  }
}

module.exports = { getVideogetterStreams, getBaseUrl };
