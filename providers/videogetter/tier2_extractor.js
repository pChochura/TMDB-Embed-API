const axios = require('axios');
const cfg = require('./config');

let cachedExtractorUrl = null;
let extractorExpiresAt = 0;

async function getExtractorBaseUrl() {
  if (cachedExtractorUrl && Date.now() < extractorExpiresAt) {
    return cachedExtractorUrl;
  }

  try {
    const workerURL = process.env.APP_URL_WORKER || cfg.defaultAppURLWorker;
    const response = await axios.get(workerURL, {
      headers: {
        'User-Agent': 'vidara-api/1.0',
        'Accept': 'application/json',
        'X-Pinggy-No-Screen': 'true',
      },
      timeout: 8000,
    });

    const data = response.data;
    if (data && data.url) {
      cachedExtractorUrl = String(data.url).trim().replace(/\/+$/, '');
      const ttlSec = data.expires_at ? (data.expires_at * 1000 - Date.now()) : 300000;
      extractorExpiresAt = Date.now() + Math.max(ttlSec, 60000);
      return cachedExtractorUrl;
    }
  } catch (err) {
    // If worker request fails, return cached if any exists
    if (cachedExtractorUrl) return cachedExtractorUrl;
  }
  return null;
}

async function resolveTier2(tmdbId, mediaType = 'movie', season = 1, episode = 1) {
  const extractorBase = await getExtractorBaseUrl();
  if (!extractorBase) return null;

  const vidfastBase = (process.env.VIDFAST_BASE_URL || cfg.defaultVidFastBaseURL).replace(/\/+$/, '');
  const targetURL = mediaType === 'movie'
    ? `${vidfastBase}/movie/${tmdbId}`
    : `${vidfastBase}/tv/${tmdbId}/${season}/${episode}`;

  try {
    const extractURL = `${extractorBase}/extract?url=${encodeURIComponent(targetURL)}&timeout=20`;
    const response = await axios.get(extractURL, {
      timeout: 22000,
      headers: { 'Accept': 'application/json' },
    });

    const data = response.data;
    if (data && (data.url || (data.success && data.url))) {
      return {
        source: 'vidfast-extractor',
        title: `VidFast Extractor`,
        url: data.url,
        quality: 'Auto',
        headers: {
          'Referer': `${vidfastBase}/`,
          'Origin': vidfastBase,
        },
        subtitles: [],
      };
    }
  } catch {
    // cascade
  }
  return null;
}

module.exports = {
  getExtractorBaseUrl,
  resolveTier2,
};
