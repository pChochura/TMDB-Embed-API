const axios = require('axios');
const { pickMatches, cleanColonTitle } = require('../../utils/polishMatcher');

const BASE_URL = 'https://premiumsmart.eu';
const API_URL = `${BASE_URL}/api/v1`;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let sessionCookieCache = {
  cookie: null,
  timestamp: 0
};
const COOKIE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Capture Laravel XSRF/session cookie from the homepage
 */
async function getSessionCookie({ timeout = 5000, axiosInstance = axios } = {}) {
  const now = Date.now();
  if (sessionCookieCache.cookie && (now - sessionCookieCache.timestamp) < COOKIE_TTL_MS) {
    return sessionCookieCache.cookie;
  }

  try {
    const res = await axiosInstance.get(`${BASE_URL}/`, {
      headers: { 'User-Agent': DEFAULT_UA },
      timeout
    });
    const setCookieHeaders = res.headers['set-cookie'] || [];
    const cookieStr = setCookieHeaders.map((c) => c.split(';')[0]).join('; ');
    if (cookieStr) {
      sessionCookieCache = { cookie: cookieStr, timestamp: now };
    }
    return cookieStr || '';
  } catch (err) {
    return sessionCookieCache.cookie || '';
  }
}

/**
 * Parse and map Premiumsmart videos to standard stream objects
 */
function mapPremiumsmartVideos(videos = [], titleName = '', isKidsOrAnimation = false) {
  const streams = [];
  const seenUrls = new Set();

  for (const v of videos) {
    let src = (v.src || '').trim();
    if (src.startsWith('//')) src = `https:${src}`;
    if (!src.startsWith('http') || seenUrls.has(src)) continue;
    seenUrls.add(src);

    const langType = String(v.language_type || '').toLowerCase();
    let tag = '[PL Lektor]';
    if (langType.includes('dubbing') || isKidsOrAnimation) {
      tag = '[PL Dubbing]';
    } else if (langType.includes('napisy')) {
      tag = '[PL Napisy]';
    }

    const quality = v.quality || '1080p';
    const hosterName = v.name || 'Premiumsmart';

    streams.push({
      name: `Polish [${hosterName}]`,
      title: `${tag} ${titleName} - ${quality}`,
      url: src,
      quality: quality,
      provider: 'polish',
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': BASE_URL
      }
    });
  }

  return streams;
}

/**
 * Scrape Premiumsmart API for matching video streams
 */
async function searchPremiumsmart(params = {}, options = {}) {
  const { timeout = 6000, axiosInstance = axios, isKidsOrAnimation = false } = options;
  const rawTitle = params.polishTitle || params.title || '';
  if (!rawTitle) return [];

  const query = cleanColonTitle(rawTitle);
  const cookie = await getSessionCookie({ timeout, axiosInstance });

  try {
    const searchRes = await axiosInstance.get(`${API_URL}/search/${encodeURIComponent(query)}?limit=25`, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': `${BASE_URL}/`,
        'Accept': 'application/json, text/plain, */*',
        'Cookie': cookie
      },
      timeout
    });

    const results = (searchRes.data?.results || [])
      .filter((r) => r && (r.model_type === 'title' || r.model_type == null) && r.id);

    const isTv = params.type === 'tv' || params.type === 'series';
    const filtered = results.filter((r) => {
      const itemIsSeries = Boolean(r.is_series || r.type === 'series');
      return isTv ? itemIsSeries : !itemIsSeries;
    });

    const matches = pickMatches(filtered, {
      title: query,
      year: params.year ? String(params.year) : undefined
    });

    if (matches.length === 0) return [];
    const matchedItem = matches[0];

    // For movies: fetch title details
    if (!isTv) {
      const titleRes = await axiosInstance.get(`${API_URL}/titles/${matchedItem.id}`, {
        headers: {
          'User-Agent': DEFAULT_UA,
          'Referer': `${BASE_URL}/`,
          'Accept': 'application/json, text/plain, */*',
          'Cookie': cookie
        },
        timeout
      });

      const titleData = titleRes.data?.title || titleRes.data || {};
      const videos = (titleData.videos || []).filter((v) => (v.category || 'full') === 'full');
      return mapPremiumsmartVideos(videos, matchedItem.name || query, isKidsOrAnimation);
    }

    // For TV series: fetch season/episode details
    if (params.season != null && params.episode != null) {
      const epRes = await axiosInstance.get(
        `${API_URL}/titles/${matchedItem.id}/seasons/${params.season}/episodes/${params.episode}`,
        {
          headers: {
            'User-Agent': DEFAULT_UA,
            'Referer': `${BASE_URL}/`,
            'Accept': 'application/json, text/plain, */*',
            'Cookie': cookie
          },
          timeout
        }
      );

      const epData = epRes.data?.episode || epRes.data || {};
      const videos = (epData.videos || []).filter((v) => (v.category || 'full') === 'full');
      return mapPremiumsmartVideos(videos, matchedItem.name || query, isKidsOrAnimation);
    }

    return [];
  } catch (err) {
    console.warn(`[Polish/Premiumsmart] Error for "${query}":`, err.message);
    return [];
  }
}

module.exports = {
  searchPremiumsmart,
  getSessionCookie,
  mapPremiumsmartVideos
};
