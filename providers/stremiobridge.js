const axios = require('axios');
const { config } = require('../utils/config');
const { resolveImdbId } = require('../utils/tmdb');

function getBridgeUrls(ctx = {}, language = null) {
  const isPl = language === 'pl' || ctx?.language === 'pl' || ctx?.isPolish;
  const ctxUrls = ctx?.bridgeUrls || ctx?.stremioBridgeUrls || (isPl ? ctx?.polishBridgeUrls : null);
  const polishConfigUrls = isPl && config && Array.isArray(config.polishStremioBridgeUrls) && config.polishStremioBridgeUrls.length > 0
    ? config.polishStremioBridgeUrls
    : null;
  const configUrls = (config && Array.isArray(config.stremioBridgeUrls) && config.stremioBridgeUrls.length > 0)
    ? config.stremioBridgeUrls
    : (config && typeof config.stremioBridgeUrls === 'string' && config.stremioBridgeUrls.trim().length > 0)
      ? config.stremioBridgeUrls
      : null;
  const raw = ctxUrls || polishConfigUrls || (isPl && process.env.STREMIO_POLISH_BRIDGE_URLS) || configUrls || process.env.STREMIO_BRIDGE_URLS;
  if (!raw) return [];

  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = trimmed.split(/[\s,]+/);
      }
    } else {
      list = trimmed.split(/[\s,]+/);
    }
  }

  return list
    .map(u => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean)
    .map(u => {
      let cleaned = u.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(cleaned)) {
        cleaned = `http://${cleaned}`;
      }
      return cleaned;
    });
}

function extractQuality(stream) {
  if (stream.quality) {
    const qStr = String(stream.quality).trim();
    if (/^\d+$/.test(qStr)) return `${qStr}p`;
    return qStr;
  }
  const text = `${stream.name || ''} ${stream.title || ''}`;
  const match4k = text.match(/\b(4k|2160p)\b/i);
  if (match4k) return '4K';
  const matchRes = text.match(/\b(\d{3,4})p\b/i);
  if (matchRes) return matchRes[0].toLowerCase();
  return 'Auto';
}

async function fetchStreamsFromEndpoint(baseUrl, streamPath) {
  const targetUrl = `${baseUrl}/${streamPath}`;
  console.log(`[stremiobridge] Querying ${targetUrl}`);
  try {
    const response = await axios.get(targetUrl, {
      timeout: 8000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; TMDB-Embed-API/1.3.0)'
      }
    });

    const data = response.data;
    if (!data || !Array.isArray(data.streams)) {
      return [];
    }

    return data.streams
      .filter(s => s && typeof s.url === 'string' && s.url.startsWith('http'))
      .map(s => {
        const mapped = {
          name: s.name ? s.name.trim() : 'Stremio',
          title: s.title ? s.title.trim() : (s.name ? s.name.trim() : 'Stream'),
          url: s.url,
          quality: extractQuality(s),
          provider: 'stremiobridge'
        };
        const reqHeaders = s.behaviorHints?.proxyHeaders?.request;
        if (reqHeaders && typeof reqHeaders === 'object' && Object.keys(reqHeaders).length > 0) {
          mapped.headers = reqHeaders;
        }
        return mapped;
      });
  } catch (err) {
    console.warn(`[stremiobridge] Failed to fetch streams from ${targetUrl}:`, err.message);
    return [];
  }
}

async function getStremioBridgeStreams(tmdbId, mediaType = 'movie', season = null, episode = null, ctx = {}) {
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

  const bridgeUrls = getBridgeUrls(effectiveCtx);
  if (bridgeUrls.length === 0) {
    return [];
  }

  const isSeries = effectiveMediaType === 'tv' || effectiveMediaType === 'series';
  const tmdbType = isSeries ? 'tv' : 'movie';

  let imdbId = effectiveCtx?.imdbId;
  if (!imdbId && effectiveTmdbId) {
    try {
      imdbId = await resolveImdbId(tmdbType, effectiveTmdbId);
    } catch (err) {
      console.warn(`[stremiobridge] Error resolving IMDb ID for TMDB ${effectiveTmdbId}:`, err.message);
    }
  }

  if (!imdbId) {
    console.log(`[stremiobridge] No IMDb ID available for TMDB ${effectiveTmdbId}`);
    return [];
  }

  const formattedImdbId = String(imdbId).startsWith('tt') ? String(imdbId) : `tt${imdbId}`;
  const streamPath = isSeries
    ? `stream/series/${formattedImdbId}:${effectiveSeason || 1}:${effectiveEpisode || 1}.json`
    : `stream/movie/${formattedImdbId}.json`;

  const results = await Promise.allSettled(
    bridgeUrls.map(url => fetchStreamsFromEndpoint(url, streamPath))
  );

  const streams = [];
  for (const res of results) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      streams.push(...res.value);
    }
  }

  return streams;
}

module.exports = { getStremioBridgeStreams, getBridgeUrls };
