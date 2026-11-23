const axios = require('axios');
const cheerio = require('cheerio');
const { pickMatches, cleanColonTitle } = require('../../utils/polishMatcher');

const BASE_URL = 'https://bajeczki24.pl';
const SEARCH_API = 'https://api.bajeczki24.pl/radar/v1/multi-search';
const SEARCH_KEY = '118b6cd0fd246c02d4fe6465a1e5c16d7ce09fb67935180da44a060db68855c2';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Parse Bajeczki24 Meilisearch API response into site matches
 */
function parseSearchResponse(data) {
  const hits = data?.hits || [];
  const results = [];
  const seen = new Set();

  for (const hit of hits) {
    const path = hit.path || '';
    const title = (hit.title || '').trim();
    if (!path || !title || seen.has(path)) continue;

    let type;
    if (path.startsWith('/filmy/')) {
      type = 'movie';
    } else if (path.startsWith('/seriale/') || path.startsWith('/bajki/')) {
      type = 'tv';
    } else {
      continue;
    }

    seen.add(path);
    const year = hit.releaseYear ? String(hit.releaseYear).trim() : '';
    results.push({
      title: year ? `${title} (${year})` : title,
      name: title,
      url: `${BASE_URL}${path}`,
      path,
      type,
      year,
      categories: hit.categories || []
    });
  }
  return results;
}

/**
 * Detect language / audio tag for Bajeczki24 streams
 */
function detectBajeczkiAudioTag(item = {}, isKidsOrAnimation = false) {
  const path = String(item.path || '').toLowerCase();
  const name = String(item.name || item.title || '').toLowerCase();
  const categories = (item.categories || []).map((c) => String(c).toLowerCase());

  if (name.includes('dubbing') || name.includes('dub')) return '[PL Dubbing]';
  if (name.includes('lektor')) return '[PL Lektor]';
  if (name.includes('napisy') || name.includes('sub')) return '[PL Napisy]';

  if (
    isKidsOrAnimation ||
    path.startsWith('/bajki/') ||
    path.includes('/animowane/') ||
    categories.includes('animowane') ||
    categories.includes('animacja') ||
    categories.includes('dla dzieci') ||
    categories.includes('familijne')
  ) {
    return '[PL Dubbing]';
  }

  return '[PL Lektor]';
}

/**
 * Extract player iframe embed URLs from page HTML
 */
function parseEmbedUrls(html) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const urls = [];

  $('iframe[src]').each((_, el) => {
    let src = ($(el).attr('src') || '').replace(/&amp;/g, '&').trim();
    if (src.startsWith('//')) src = `https:${src}`;
    if (src.startsWith('http') && !urls.includes(src)) {
      urls.push(src);
    }
  });

  return urls;
}

/**
 * Execute Meilisearch query on Bajeczki24
 */
async function apiSearch(query, { timeout = 6000, axiosInstance = axios } = {}) {
  const res = await axiosInstance.post(
    SEARCH_API,
    {
      queries: [
        { indexUid: 'movies-v2', q: query },
        { indexUid: 'tv-shows-v2', q: query }
      ],
      federation: { offset: 0, limit: 30 }
    },
    {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${SEARCH_KEY}`,
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`
      },
      timeout
    }
  );
  return res.data;
}

/**
 * Scrape Bajeczki24 for matching movie or episode embed streams
 */
async function searchBajeczki24(params = {}, options = {}) {
  const { timeout = 6000, axiosInstance = axios, isKidsOrAnimation = false } = options;
  const rawTitle = params.title || params.polishTitle || '';
  if (!rawTitle) return [];

  const query = cleanColonTitle(rawTitle);
  const mediaType = (params.type === 'tv' || params.type === 'series') ? 'tv' : 'movie';

  try {
    const data = await apiSearch(query, { timeout, axiosInstance });
    const allMatches = parseSearchResponse(data);
    const typeMatches = allMatches.filter((item) => item.type === mediaType);

    const matches = pickMatches(typeMatches, {
      title: query,
      year: params.year ? String(params.year) : undefined
    });

    if (matches.length === 0) return [];

    let targetPageUrl = matches[0].url;

    // For TV series, navigate season and episode if provided
    if (mediaType === 'tv' && params.season != null && params.episode != null) {
      targetPageUrl = targetPageUrl.replace(/\/+$/, '') + `/${params.season}/${params.episode}/`;
    }

    const pageRes = await axiosInstance.get(targetPageUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': BASE_URL,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout
    });

    const embeds = parseEmbedUrls(pageRes.data);
    const streams = [];
    const audioTag = detectBajeczkiAudioTag(matches[0], isKidsOrAnimation);

    for (const embedUrl of embeds) {
      streams.push({
        name: 'Polish [Bajeczki24]',
        title: `${audioTag} ${matches[0].name || query} - 1080p`,
        url: embedUrl,
        quality: '1080p',
        provider: 'polish',
        headers: {
          'User-Agent': DEFAULT_UA,
          'Referer': BASE_URL
        }
      });
    }

    return streams;
  } catch (err) {
    console.warn(`[Polish/Bajeczki24] Error for "${query}":`, err.message);
    return [];
  }
}

module.exports = {
  searchBajeczki24,
  detectBajeczkiAudioTag,
  parseSearchResponse,
  parseEmbedUrls,
  apiSearch
};
