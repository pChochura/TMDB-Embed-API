const axios = require('axios');

const API_BASE = process.env.VIDZEE_API_BASE || 'https://core.vidzee.wtf';
const EMBED_ORIGIN = process.env.VIDZEE_EMBED_ORIGIN || 'https://player.vidzee.wtf';
const STREAM_REFERER = `${EMBED_ORIGIN}/`;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_SERVERS = ['dcloud', 'tik', 'ipcloud', 'v6:Hindi'];

function buildStreamUrl({ tmdbId, type, season, episode, sr, apiBase = API_BASE }) {
  const isTv = type === 'tv' || type === 'series';
  const path = isTv
    ? `/streams/tv/${encodeURIComponent(tmdbId)}/${encodeURIComponent(season)}/${encodeURIComponent(episode)}`
    : `/streams/movie/${encodeURIComponent(tmdbId)}`;
  return `${apiBase}${path}?s=${encodeURIComponent(sr)}&e=0`;
}

function normalizeVidzeeStream(data, sr) {
  if (!data || typeof data !== 'object') return [];

  // Ignore encrypted blobs (e=1 format we didn't ask for)
  if (data.c && !data.url && !data.link) return [];

  const rawUrls = [];
  if (typeof data.url === 'string') {
    rawUrls.push({ url: data.url, language: data.language, headers: data.headers });
  } else if (Array.isArray(data.url)) {
    data.url.forEach(item => {
      if (typeof item === 'string') rawUrls.push({ url: item });
      else if (item && typeof item === 'object') rawUrls.push(item);
    });
  } else if (typeof data.link === 'string') {
    rawUrls.push({ url: data.link, language: data.language || data.lang, headers: data.headers });
  }

  const results = [];
  for (const item of rawUrls) {
    const streamUrl = typeof item.url === 'string' ? item.url.trim() : '';
    if (!/^https?:\/\//i.test(streamUrl)) continue;

    const language = item.language || data.language || 'Unknown';
    // VidZee streams are adaptive HLS playlists defaulting to 720p base
    const quality = item.quality || '720p';
    const customHeaders = (item.headers && typeof item.headers === 'object')
      ? item.headers
      : (data.headers && typeof data.headers === 'object' ? data.headers : {});

    results.push({
      name: `VidZee ${sr} - ${quality} - ${language}`,
      title: `VidZee ${sr} - ${quality} - ${language}`,
      url: streamUrl,
      quality,
      provider: 'VidZee',
      headers: { Referer: STREAM_REFERER, ...customHeaders }
    });
  }

  return results;
}

async function getVidzeeStreams(tmdbId, mediaType, season, episode, ctx = {}) {
  if (!tmdbId) {
    console.warn('[VidZee] tmdbId is required');
    return [];
  }

  const isTv = mediaType === 'tv' || mediaType === 'series';
  const isMovie = mediaType === 'movie';

  if (!isMovie && !isTv) {
    console.warn('[VidZee] mediaType must be "movie", "tv" or "series"');
    return [];
  }

  if (isTv) {
    if (!season || !episode) {
      console.warn('[VidZee] season and episode are required for TV series');
      return [];
    }
  }

  const servers = (Array.isArray(ctx?.servers) && ctx.servers.length)
    ? ctx.servers
    : (Array.isArray(ctx?.vidzeeServers) && ctx.vidzeeServers.length)
      ? ctx.vidzeeServers
      : DEFAULT_SERVERS;

  const apiBase = ctx?.apiBase || API_BASE;
  const timeoutMs = typeof ctx?.timeout === 'number' ? ctx.timeout : 8000;

  const serverPromises = servers.map(async (sr) => {
    try {
      const url = buildStreamUrl({ tmdbId, type: isTv ? 'tv' : 'movie', season, episode, sr, apiBase });
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Referer: `${EMBED_ORIGIN}/`,
          Origin: EMBED_ORIGIN
        },
        timeout: timeoutMs
      });
      return normalizeVidzeeStream(resp.data, sr);
    } catch {
      // Individual server failures (e.g. 404, 502, timeout) should not break other servers
      return [];
    }
  });

  const results = await Promise.all(serverPromises);
  const flattened = results.flat();
  if (flattened.length > 0) {
    console.log(`[VidZee] Found ${flattened.length} stream(s) for TMDB ID: ${tmdbId}`);
  }
  return flattened;
}

module.exports = {
  getVidzeeStreams,
  getVidZeeStreams: getVidzeeStreams,
  buildStreamUrl,
  normalizeVidzeeStream,
  DEFAULT_SERVERS,
  API_BASE,
  STREAM_REFERER
};
