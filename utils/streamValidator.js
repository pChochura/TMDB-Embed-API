const axios = require('axios');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 1000;

// In-memory validation cache: url -> { valid, status, reason, checkedAt }
const validationCache = new Map();

/**
 * Clear the validation cache (useful for testing or cache resets)
 */
function clearValidationCache() {
  validationCache.clear();
}

/**
 * Retrieve cache statistics
 */
function getValidationCacheStats() {
  return {
    size: validationCache.size,
    maxSize: MAX_CACHE_SIZE,
    ttlMs: DEFAULT_CACHE_TTL_MS
  };
}

/**
 * Set cache item with size bounds
 */
function setCache(url, result) {
  if (validationCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = validationCache.keys().next().value;
    if (oldestKey) validationCache.delete(oldestKey);
  }
  validationCache.set(url, { ...result, checkedAt: Date.now() });
}

/**
 * Get cached result if still valid
 */
function getFromCache(url, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const cached = validationCache.get(url);
  if (!cached) return null;
  if (Date.now() - cached.checkedAt > ttlMs) {
    validationCache.delete(url);
    return null;
  }
  return cached;
}

/**
 * Check if CDA embed or page indicates premium account requirement or block
 */
function checkCdaHtml(html) {
  if (!html || typeof html !== 'string') {
    return { valid: false, status: 'invalid_content', reason: 'empty_response' };
  }

  // Paywall / Premium indicators
  const isPremium = (
    html.includes('premium.cda.pl') ||
    html.includes('player-prem-bg-text') ||
    html.includes('Ten film jest dostępny dla użytkowników premium') ||
    html.includes('show-login-wrapper') ||
    html.includes('flag-video-premium') ||
    html.includes('Dołącz do CDA Premium')
  );

  if (isPremium) {
    return { valid: false, status: 'blocked', reason: 'premium_required' };
  }

  // Deleted / Removed / Geo-blocked indicators
  const isDeleted = (
    /Ten film zosta[łl] usuni[ęe]ty/i.test(html) ||
    /Materia[łl] zosta[łl] usuni[ęe]ty/i.test(html) ||
    /Materia[łl] niedost[ęe]pny/i.test(html) ||
    /Film niedost[ęe]pny w Twoim kraju/i.test(html) ||
    /Nie znaleziono wideo/i.test(html)
  );

  if (isDeleted) {
    return { valid: false, status: 'unreachable', reason: 'video_removed' };
  }

  return { valid: true, status: 'valid' };
}

/**
 * Check generic embed or web player HTML for common block/takedown patterns
 */
function checkGenericEmbedHtml(html) {
  if (!html || typeof html !== 'string') {
    return { valid: false, status: 'invalid_content', reason: 'empty_response' };
  }

  // Generic paywall / account block
  if (
    /premium (account|membership|subscription) required/i.test(html) ||
    /sign in to (watch|view|access)/i.test(html) ||
    /only for registered users/i.test(html)
  ) {
    return { valid: false, status: 'blocked', reason: 'premium_or_auth_required' };
  }

  // Generic removal / DMCA / 404 indicators
  if (
    /video (has been removed|is unavailable|was deleted|has been deleted)/i.test(html) ||
    /file (not found|was deleted|has been deleted|no longer exists)/i.test(html) ||
    /account (has been suspended|is suspended|banned)/i.test(html) ||
    /copyright (infringement|claim|notice)/i.test(html) ||
    /not available in your (region|country)/i.test(html)
  ) {
    return { valid: false, status: 'unreachable', reason: 'video_unavailable' };
  }

  return { valid: true, status: 'valid' };
}

/**
 * Calculate total duration from an HLS playlist by summing #EXTINF values
 * @param {string} text - M3U8 text
 * @returns {number|null} Total duration in seconds, or null if live / no EXTINF
 */
function parseM3u8Duration(text) {
  if (!text || typeof text !== 'string') return null;
  const regex = /#EXTINF:([\d.]+)/g;
  let match;
  let totalSec = 0;
  let found = false;
  while ((match = regex.exec(text)) !== null) {
    const sec = parseFloat(match[1]);
    if (!isNaN(sec)) {
      totalSec += sec;
      found = true;
    }
  }
  return found ? Math.round(totalSec) : null;
}

/**
 * Check direct HLS playlist (.m3u8) validity
 */
function checkM3u8Content(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return { valid: false, status: 'invalid_media', reason: 'empty_playlist' };
  }

  if (!text.includes('#EXTM3U')) {
    return { valid: false, status: 'invalid_media', reason: 'missing_extm3u_header' };
  }

  const hasPlayableEntries = (
    text.includes('#EXTINF') ||
    text.includes('#EXT-X-STREAM-INF') ||
    text.includes('#EXT-X-TARGETDURATION')
  );

  if (!hasPlayableEntries) {
    return { valid: false, status: 'invalid_media', reason: 'no_stream_segments_or_variants' };
  }

  const durationSec = parseM3u8Duration(text);
  const isVod = text.includes('#EXT-X-ENDLIST');

  // If expected runtime is supplied and this is a complete VOD playlist
  const expectedRuntimeSec = options.expectedRuntimeSec ||
    (options.expectedRuntimeMinutes ? options.expectedRuntimeMinutes * 60 : null) ||
    (options.expectedRuntime ? options.expectedRuntime * 60 : null);

  if (isVod && durationSec !== null && expectedRuntimeSec) {
    // Catch trailers/previews (< 5 min when > 15 min expected)
    if (expectedRuntimeSec > 15 * 60 && durationSec < 5 * 60) {
      return {
        valid: false,
        status: 'invalid_media',
        reason: 'trailer_or_sample_detected',
        durationSec,
        expectedRuntimeSec,
      };
    }

    // Check tolerance window (35% threshold)
    const ratio = durationSec / expectedRuntimeSec;
    if (ratio < 0.65 || ratio > 1.45) {
      return {
        valid: false,
        status: 'invalid_media',
        reason: 'duration_mismatch',
        durationSec,
        expectedRuntimeSec,
      };
    }
  }

  const result = { valid: true, status: 'valid' };
  if (options.includeDuration && durationSec !== null) {
    result.durationSec = durationSec;
  }
  return result;
}

/**
 * Validate an individual stream or URL
 *
 * @param {Object|string} stream - Stream object with { url, headers, provider } or string URL
 * @param {Object} [options]
 * @param {number} [options.timeout=3500] - Timeout in milliseconds
 * @param {boolean} [options.skipCache=false] - Bypass cache
 * @param {number} [options.cacheTtlMs=600000] - Cache TTL in milliseconds
 * @param {Object} [options.axiosInstance] - Optional injected axios instance
 * @returns {Promise<{ valid: boolean, status: string, reason?: string, url: string }>}
 */
async function validateStream(stream, options = {}) {
  const url = typeof stream === 'string' ? stream : stream?.url;
  if (!url || typeof url !== 'string') {
    return { valid: false, status: 'invalid_url', reason: 'missing_or_invalid_url', url: url || '' };
  }

  const {
    timeout = DEFAULT_TIMEOUT_MS,
    skipCache = false,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    axiosInstance = axios
  } = options;

  if (!skipCache) {
    const cached = getFromCache(url, cacheTtlMs);
    if (cached) return cached;
  }

  const streamHeaders = (typeof stream === 'object' && stream !== null && stream.headers)
    ? { ...stream.headers }
    : {};

  const headers = {
    'User-Agent': streamHeaders['User-Agent'] || streamHeaders['user-agent'] || DEFAULT_UA,
    ...streamHeaders
  };

  const isCda = /cda\.pl/i.test(url);
  const isDirectMedia = /\.(m3u8|mp4|mkv|webm|ts)(\?.*)?$/i.test(url);

  try {
    if (isCda) {
      if (!headers['Referer'] && !headers['referer']) {
        headers['Referer'] = 'https://www.cda.pl/';
      }

      const res = await axiosInstance.get(url, {
        headers,
        timeout,
        responseType: 'text',
        validateStatus: status => status < 500
      });

      if (res.status === 404 || res.status === 410) {
        const result = { valid: false, status: 'unreachable', reason: `http_${res.status}`, url };
        setCache(url, result);
        return result;
      }

      if (res.status !== 200) {
        const result = { valid: false, status: 'unreachable', reason: `http_${res.status}`, url };
        setCache(url, result);
        return result;
      }

      const cdaResult = checkCdaHtml(res.data);
      const result = { ...cdaResult, url };
      setCache(url, result);
      return result;
    }

    if (isDirectMedia) {
      // Range request to verify byte stream without full download
      const reqHeaders = { ...headers, Range: 'bytes=0-2048' };
      const res = await axiosInstance.get(url, {
        headers: reqHeaders,
        timeout,
        responseType: 'text',
        validateStatus: status => status < 500
      });

      if (res.status !== 200 && res.status !== 206) {
        const result = { valid: false, status: 'unreachable', reason: `http_${res.status}`, url };
        setCache(url, result);
        return result;
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      // An HTML response for a direct media link is almost always a masqueraded error/paywall page
      if (contentType.includes('text/html')) {
        const result = { valid: false, status: 'invalid_media', reason: 'html_served_for_media_url', url };
        setCache(url, result);
        return result;
      }

      if (url.includes('.m3u8')) {
        const m3u8Check = checkM3u8Content(res.data, options);
        const result = { ...m3u8Check, url };
        setCache(url, result);
        return result;
      }

      const result = { valid: true, status: 'valid', url };
      setCache(url, result);
      return result;
    }

    // Generic embed / iframe validation
    const res = await axiosInstance.get(url, {
      headers,
      timeout,
      responseType: 'text',
      validateStatus: status => status < 500
    });

    if (res.status === 404 || res.status === 410) {
      const result = { valid: false, status: 'unreachable', reason: `http_${res.status}`, url };
      setCache(url, result);
      return result;
    }

    if (res.status >= 400) {
      const result = { valid: false, status: 'unreachable', reason: `http_${res.status}`, url };
      setCache(url, result);
      return result;
    }

    const genericCheck = checkGenericEmbedHtml(res.data);
    const result = { ...genericCheck, url };
    setCache(url, result);
    return result;
  } catch (err) {
    const reason = err.code || err.message || 'network_error';
    const result = { valid: false, status: 'unreachable', reason, url };
    setCache(url, result);
    return result;
  }
}

/**
 * Validate an array of streams with concurrency control
 *
 * @param {Array<Object>} streams - List of stream objects
 * @param {Object} [options]
 * @param {number} [options.concurrency=5] - Maximum parallel validations
 * @param {boolean} [options.filterInvalid=false] - Return only streams that are valid
 * @param {number} [options.timeout=3500] - Request timeout in ms
 * @returns {Promise<Array<Object>>}
 */
async function validateStreams(streams, options = {}) {
  if (!Array.isArray(streams) || streams.length === 0) return [];

  const {
    concurrency = 5,
    filterInvalid = false,
    ...itemOptions
  } = options;

  const results = new Array(streams.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < streams.length) {
      const index = currentIndex++;
      const stream = streams[index];
      if (!stream || !stream.url) {
        results[index] = {
          stream,
          validation: { valid: false, status: 'invalid_url', reason: 'missing_url', url: '' }
        };
        continue;
      }

      try {
        const validation = await validateStream(stream, itemOptions);
        results[index] = { stream, validation };
      } catch (err) {
        results[index] = {
          stream,
          validation: { valid: false, status: 'unreachable', reason: err.message, url: stream.url }
        };
      }
    }
  }

  const workerCount = Math.min(concurrency, streams.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  if (filterInvalid) {
    return results
      .filter(item => item && item.validation && item.validation.valid)
      .map(item => item.stream);
  }

  return results.map(item => ({
    ...item.stream,
    validation: item.validation
  }));
}

module.exports = {
  validateStream,
  validateStreams,
  checkCdaHtml,
  checkGenericEmbedHtml,
  checkM3u8Content,
  parseM3u8Duration,
  clearValidationCache,
  getValidationCacheStats,
  DEFAULT_CACHE_TTL_MS
};
