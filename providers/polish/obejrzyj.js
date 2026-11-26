const axios = require('axios');
const { pickMatches, cleanColonTitle } = require('../../utils/polishMatcher');
const { resolveVidneoStreamUrl } = require('../../utils/resolvers/vidneo');

const BASE_URL = 'https://obejrzyj.to';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Extract window.bootstrapData JSON payload from page HTML
 */
function extractBootstrapData(html = '') {
  if (typeof html !== 'string') return null;
  const match = html.match(/window\.bootstrapData\s*=\s*(\{.*?\});\s*<\/script>/s) ||
    html.match(/window\.bootstrapData\s*=\s*(\{.*?\});/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Detect language tag from Obejrzyj video object metadata
 */
function detectObejrzyjAudioTag(v = {}, isKidsOrAnimation = false) {
  const langType = String(v.language_type || '').toLowerCase();
  const langLabel = String(v.language_label || '').toLowerCase();
  const name = String(v.name || '').toLowerCase();
  const combined = `${langType} ${langLabel} ${name}`;

  if (combined.includes('dubbing') || combined.includes('dub')) {
    return '[PL Dubbing]';
  }
  if (combined.includes('lektor')) {
    return '[PL Lektor]';
  }
  if (combined.includes('napisy') || combined.includes('sub')) {
    return '[PL Napisy]';
  }
  if (isKidsOrAnimation) {
    return '[PL Dubbing]';
  }
  return '[PL Lektor]';
}

/**
 * Parse Obejrzyj search results, matching by TMDB ID, IMDb ID, or title + year
 */
function findBestObejrzyjItem(results = [], params = {}) {
  if (!Array.isArray(results) || results.length === 0) return null;

  const isTv = params.type === 'tv' || params.type === 'series';

  // 1. High precision: match by TMDB ID if present
  if (params.tmdbId) {
    const tmdbStr = String(params.tmdbId);
    const byTmdb = results.find((r) => String(r.tmdb_id) === tmdbStr);
    if (byTmdb) return byTmdb;
  }

  // 2. High precision: match by IMDb ID if present
  if (params.imdbId) {
    const imdbClean = String(params.imdbId).replace(/^tt/, '');
    const byImdb = results.find((r) => {
      const curImdb = String(r.imdb_id || '').replace(/^tt/, '');
      return curImdb && curImdb === imdbClean;
    });
    if (byImdb) return byImdb;
  }

  // 3. Fallback: filter by media type and match title + year
  const filtered = results.filter((r) => {
    const itemIsSeries = Boolean(r.is_series || r.type === 'series');
    return isTv ? itemIsSeries : !itemIsSeries;
  });

  const query = cleanColonTitle(params.polishTitle || params.title || '');
  const matches = pickMatches(filtered, {
    title: query,
    year: params.year ? String(params.year) : undefined
  });

  return matches.length > 0 ? matches[0] : null;
}

/**
 * Scrape Obejrzyj.to for matching video streams
 */
async function searchObejrzyj(params = {}, options = {}) {
  const { timeout = 6000, axiosInstance = axios, isKidsOrAnimation = false } = options;
  const rawTitle = params.polishTitle || params.title || '';
  if (!rawTitle) return [];

  const query = cleanColonTitle(rawTitle);
  const searchUrl = `${BASE_URL}/search/${encodeURIComponent(query)}`;

  try {
    const searchRes = await axiosInstance.get(searchUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': BASE_URL,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout
    });

    const searchData = extractBootstrapData(searchRes.data);
    let results = searchData?.loaders?.searchPage?.results || [];
    let matchedItem = findBestObejrzyjItem(results, params);

    // Fallback search with original title if no match found
    if (!matchedItem && params.originalTitle && params.originalTitle !== query) {
      const origQuery = cleanColonTitle(params.originalTitle);
      try {
        const origRes = await axiosInstance.get(`${BASE_URL}/search/${encodeURIComponent(origQuery)}`, {
          headers: {
            'User-Agent': DEFAULT_UA,
            'Referer': BASE_URL,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout
        });
        const origData = extractBootstrapData(origRes.data);
        const origResults = origData?.loaders?.searchPage?.results || [];
        matchedItem = findBestObejrzyjItem(origResults, { ...params, title: origQuery, polishTitle: query });
      } catch {
        // ignore fallback search error
      }
    }

    if (!matchedItem || !matchedItem.id) return [];

    const isTv = params.type === 'tv' || params.type === 'series';
    const slug = (matchedItem.name || query)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-');

    let targetUrl = `${BASE_URL}/titles/${matchedItem.id}/${slug}`;
    if (isTv && params.season != null && params.episode != null) {
      targetUrl = `${targetUrl}/season/${params.season}/episode/${params.episode}`;
    }

    const pageRes = await axiosInstance.get(targetUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': BASE_URL,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout
    });

    const pageData = extractBootstrapData(pageRes.data);
    const mediaContainer = isTv
      ? (pageData?.loaders?.episodePage?.episode || pageData?.loaders?.titlePage?.title)
      : (pageData?.loaders?.titlePage?.title || pageData?.loaders?.watchPage?.video);

    const rawVideos = mediaContainer?.videos ||
      (mediaContainer?.video ? [mediaContainer.video] : []) ||
      mediaContainer?.alternative_videos ||
      [];

    const streams = [];
    const seenSrcs = new Set();

    for (const v of rawVideos) {
      const src = v?.src;
      if (!src || typeof src !== 'string' || !src.startsWith('http') || seenSrcs.has(src)) {
        continue;
      }
      seenSrcs.add(src);

      const tag = detectObejrzyjAudioTag(v, isKidsOrAnimation);
      const quality = v.quality || '1080p';
      const hosterName = v.name || 'Obejrzyj';

      let streamUrl = src;
      let headers = {
        'User-Agent': DEFAULT_UA,
        'Referer': BASE_URL
      };

      if (src.includes('vidneo.') || hosterName.toLowerCase().includes('vidneo')) {
        try {
          const directUrl = await resolveVidneoStreamUrl(src, { timeout, axiosInstance });
          if (directUrl && directUrl !== src) {
            streamUrl = directUrl;
            headers = {
              'User-Agent': DEFAULT_UA,
              'Referer': 'https://vidneo.cc/'
            };
          }
        } catch {
          // keep embed fallback
        }
      }

      streams.push({
        name: `Polish [${hosterName}]`,
        title: `${tag} ${matchedItem.name || query} - ${quality}`,
        url: streamUrl,
        quality: quality,
        provider: 'polish',
        headers
      });
    }

    return streams;
  } catch (err) {
    console.warn(`[Polish/Obejrzyj] Error for "${query}":`, err.message);
    return [];
  }
}

module.exports = {
  searchObejrzyj,
  extractBootstrapData,
  detectObejrzyjAudioTag,
  findBestObejrzyjItem
};
