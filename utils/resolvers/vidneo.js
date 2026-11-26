const axios = require('axios');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const vidneoDirectCache = new Map();
const VIDNEO_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Resolve direct HLS m3u8 stream from a Vidneo embed URL
 * @param {string} embedUrl Vidneo embed URL (e.g. https://vidneo.cc/e/PWpcHW7wVgO)
 * @param {object} options
 * @returns {Promise<string>} Direct m3u8 URL or original embedUrl if failed
 */
async function resolveVidneoStreamUrl(embedUrl, options = {}) {
  if (!embedUrl || typeof embedUrl !== 'string') return embedUrl;
  if (embedUrl.includes('.m3u8')) return embedUrl;

  const idMatch = embedUrl.match(/\/(?:e|embed|v)\/([a-zA-Z0-9_-]+)/);
  const videoId = idMatch ? idMatch[1] : embedUrl;

  const cached = vidneoDirectCache.get(videoId);
  if (cached && (Date.now() - cached.ts < VIDNEO_CACHE_TTL_MS)) {
    return cached.url;
  }

  const { timeout = 3500, axiosInstance = axios } = options;

  try {
    const res = await axiosInstance.get(embedUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://vidneo.cc/',
        'RSC': '1',
        'Accept': '*/*'
      },
      timeout
    });

    if (!res || !res.data) return embedUrl;
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    // Look for Next.js App Router player props or HTML source
    const match = body.match(/(?:\\?"|")src(?:\\?"|")\s*:\s*(?:\\?"|")([^"\\\\]*(?:\.m3u8|\.mp4|\/hls\/)[^"\\\\]*)(?:\\?"|")/i);
    let streamUrl = match ? match[1] : null;

    if (!streamUrl) {
      const fallback = body.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*|\/hls\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/i);
      if (fallback) streamUrl = fallback[1];
    }

    if (streamUrl) {
      if (streamUrl.startsWith('/')) {
        streamUrl = new URL(streamUrl, embedUrl).href;
      }
      vidneoDirectCache.set(videoId, { url: streamUrl, ts: Date.now() });
      return streamUrl;
    }

    vidneoDirectCache.set(videoId, { url: embedUrl, ts: Date.now() });
    return embedUrl;
  } catch (err) {
    return embedUrl;
  }
}

/**
 * Extract streaming details from a Vidneo embed URL
 * @param {string} embedUrl
 * @param {object} options
 * @returns {Promise<{m3u8?: string, headers: object}|null>}
 */
async function extractVidneo(embedUrl, options = {}) {
  const directUrl = await resolveVidneoStreamUrl(embedUrl, options);
  if (!directUrl || directUrl === embedUrl) return null;
  return {
    m3u8: directUrl,
    headers: {
      'User-Agent': DEFAULT_UA,
      'Referer': 'https://vidneo.cc/'
    }
  };
}

module.exports = {
  resolveVidneoStreamUrl,
  extractVidneo,
  vidneoDirectCache,
  VIDNEO_CACHE_TTL_MS
};
