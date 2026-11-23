const axios = require('axios');
const cheerio = require('cheerio');
const { getDetails } = require('../utils/tmdb');
const { extractKwik, extractPahe } = require('../utils/resolvers/kwik');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_DOMAINS = [
  'https://animepahe.ru',
  'https://animepahe.org',
  'https://animepahe.com',
  'https://animepahe.pw'
];

function extractQuality(text) {
  if (!text) return 'Auto';
  const match = String(text).match(/(\d{3,4}p)/i);
  if (match) return match[1].toLowerCase();
  if (/4k|2160/i.test(text)) return '4K';
  if (/1080/i.test(text)) return '1080p';
  if (/720/i.test(text)) return '720p';
  if (/480/i.test(text)) return '480p';
  if (/360/i.test(text)) return '360p';
  return 'Auto';
}

function cleanTitle(str) {
  if (!str) return '';
  return str
    .replace(/[:!?._\-+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Searches AnimePahe API for anime matching query.
 * @param {string} query
 * @param {object} options
 * @returns {Promise<Array>}
 */
async function searchAnimePahe(query, options = {}) {
  const domains = options.domain ? [options.domain] : DEFAULT_DOMAINS;
  const timeout = Number(options.timeout) || 8000;
  const userAgent = options.userAgent || DEFAULT_UA;

  if (typeof options.fetcher === 'function') {
    const res = await options.fetcher(`/api?m=search&q=${encodeURIComponent(query)}`, { isSearch: true, query });
    if (res && res.data) return res.data;
    if (Array.isArray(res)) return res;
  }

  for (const domain of domains) {
    try {
      const targetUrl = `${domain}/api?m=search&q=${encodeURIComponent(query)}`;
      const res = await axios.get(targetUrl, {
        headers: {
          'User-Agent': userAgent,
          Referer: `${domain}/`,
          Cookie: '__ddg2_=1234567890'
        },
        timeout,
        validateStatus: (status) => status === 200
      });

      if (res.data && Array.isArray(res.data.data)) {
        return res.data.data;
      }
    } catch {
      // Try next domain mirror
    }
  }

  return [];
}

/**
 * Retrieves release list (episodes) for a given anime session.
 * @param {string} session
 * @param {number} page
 * @param {object} options
 * @returns {Promise<object|null>}
 */
async function getReleases(session, page = 1, options = {}) {
  const domains = options.domain ? [options.domain] : DEFAULT_DOMAINS;
  const timeout = Number(options.timeout) || 8000;
  const userAgent = options.userAgent || DEFAULT_UA;

  if (typeof options.fetcher === 'function') {
    const res = await options.fetcher(`/api?m=release&id=${session}&sort=episode_asc&page=${page}`, {
      isRelease: true,
      session,
      page
    });
    if (res) return res;
  }

  for (const domain of domains) {
    try {
      const targetUrl = `${domain}/api?m=release&id=${encodeURIComponent(session)}&sort=episode_asc&page=${page}`;
      const res = await axios.get(targetUrl, {
        headers: {
          'User-Agent': userAgent,
          Referer: `${domain}/`
        },
        timeout,
        validateStatus: (status) => status === 200
      });

      if (res.data) return res.data;
    } catch {
      // Try next domain mirror
    }
  }

  return null;
}

/**
 * Retrieves and parses play page HTML for streams.
 * @param {string} animeSession
 * @param {string} episodeSession
 * @param {object} options
 * @returns {Promise<string>}
 */
async function getPlayPageHtml(animeSession, episodeSession, options = {}) {
  const domains = options.domain ? [options.domain] : DEFAULT_DOMAINS;
  const timeout = Number(options.timeout) || 8000;
  const userAgent = options.userAgent || DEFAULT_UA;

  if (typeof options.fetcher === 'function') {
    const res = await options.fetcher(`/play/${animeSession}/${episodeSession}`, {
      isPlay: true,
      animeSession,
      episodeSession
    });
    if (typeof res === 'string') return res;
    if (res && res.html) return res.html;
  }

  for (const domain of domains) {
    try {
      const targetUrl = `${domain}/play/${encodeURIComponent(animeSession)}/${encodeURIComponent(episodeSession)}`;
      const res = await axios.get(targetUrl, {
        headers: {
          'User-Agent': userAgent,
          Referer: `${domain}/`
        },
        timeout,
        validateStatus: (status) => status === 200
      });

      if (typeof res.data === 'string') return res.data;
    } catch {
      // Try next domain mirror
    }
  }

  return '';
}

/**
 * Core scraping implementation for AnimePahe.
 * Resolves TMDB ID to AnimePahe anime session, identifies episode session,
 * extracts Kwik/Pahe embeds and unpacks them into playable streams.
 *
 * @param {string|number} tmdbId
 * @param {string} mediaType 'movie' or 'tv'
 * @param {number|null} season
 * @param {number|null} episode
 * @param {object} ctx Optional context (title, year, timeout, custom fetcher)
 * @returns {Promise<Array>} Array of stream objects conforming to TMDB-Embed-API schema
 */
async function getAnimepaheStreams(tmdbId, mediaType = 'movie', season = null, episode = null, ctx = {}) {
  console.log(`[AnimePahe] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

  try {
    const isTv = mediaType === 'tv' || mediaType === 'series';
    const tmdbType = isTv ? 'tv' : 'movie';

    let details = null;
    if (tmdbId && (!ctx?.title || !ctx?.originalTitle)) {
      try {
        details = await getDetails(tmdbType, tmdbId, ctx?.language);
      } catch (err) {
        console.warn(`[AnimePahe] Could not fetch TMDB details for ${tmdbId}: ${err.message}`);
      }
    }

    const title = ctx?.title || (details && (details.name || details.title)) || '';
    const originalTitle = ctx?.originalTitle || (details && (details.original_name || details.original_title)) || '';

    if (!title && !originalTitle) {
      console.log(`[AnimePahe] No title found for TMDB ID: ${tmdbId}`);
      return [];
    }

    const targetEpisode = isTv ? (parseInt(episode ?? ctx?.episode ?? 1, 10) || 1) : 1;
    const timeout = Number(ctx?.timeout) || 10000;
    const options = {
      domain: ctx?.animepaheDomain,
      fetcher: ctx?.fetcher || ctx?.customFetcher,
      timeout
    };

    // 1. Search for matching anime on AnimePahe
    const searchQueries = [];
    if (title) searchQueries.push(cleanTitle(title));
    if (originalTitle && cleanTitle(originalTitle) !== cleanTitle(title)) {
      searchQueries.push(cleanTitle(originalTitle));
    }

    let searchResults = [];
    for (const q of searchQueries) {
      searchResults = await searchAnimePahe(q, options);
      if (searchResults && searchResults.length > 0) break;
    }

    if (!searchResults || searchResults.length === 0) {
      console.log(`[AnimePahe] No search results on AnimePahe for: ${title}`);
      return [];
    }

    // Match best candidate from results
    const normTitle = title.toLowerCase().trim();
    const normOrig = originalTitle.toLowerCase().trim();
    let bestMatch = searchResults.find(
      (item) =>
        item.title &&
        (item.title.toLowerCase().trim() === normTitle ||
          item.title.toLowerCase().trim() === normOrig)
    );

    if (!bestMatch) {
      // Substring match
      bestMatch = searchResults.find(
        (item) =>
          item.title &&
          (normTitle.includes(item.title.toLowerCase().trim()) ||
            item.title.toLowerCase().trim().includes(normTitle))
      );
    }

    // Fallback to first result
    const chosenAnime = bestMatch || searchResults[0];
    const animeSession = chosenAnime.session;
    const resolvedTitle = chosenAnime.title || title;

    if (!animeSession) {
      console.log(`[AnimePahe] No session found for anime: ${title}`);
      return [];
    }

    // 2. Fetch releases (episodes list)
    const firstPageData = await getReleases(animeSession, 1, options);
    if (!firstPageData || !Array.isArray(firstPageData.data) || firstPageData.data.length === 0) {
      console.log(`[AnimePahe] No releases found for session: ${animeSession}`);
      return [];
    }

    const perPage = firstPageData.per_page || 30;
    const targetPage = Math.ceil(targetEpisode / perPage) || 1;

    let targetPageData = firstPageData;
    if (targetPage > 1) {
      const pageResult = await getReleases(animeSession, targetPage, options);
      if (pageResult && Array.isArray(pageResult.data)) {
        targetPageData = pageResult;
      }
    }

    let episodeSession = null;
    const foundEp = targetPageData.data.find(
      (e) => Math.floor(Number(e.episode)) === targetEpisode
    );
    if (foundEp) {
      episodeSession = foundEp.session;
    } else {
      // Fallback search across first page data
      const fallbackEp = firstPageData.data.find(
        (e) => Math.floor(Number(e.episode)) === targetEpisode
      );
      if (fallbackEp) episodeSession = fallbackEp.session;
    }

    if (!episodeSession) {
      console.log(`[AnimePahe] Episode ${targetEpisode} not found for ${resolvedTitle}`);
      return [];
    }

    // 3. Fetch play page HTML
    const playHtml = await getPlayPageHtml(animeSession, episodeSession, options);
    if (!playHtml) {
      console.log(`[AnimePahe] Could not load play page for ${resolvedTitle} Ep ${targetEpisode}`);
      return [];
    }

    // 4. Parse resolution buttons and download links
    const $ = cheerio.load(playHtml);
    const streams = [];
    const extractPromises = [];

    // Resolution menu buttons (#resolutionMenu button)
    $('#resolutionMenu button').each((_, el) => {
      const $btn = $(el);
      const kwikUrl = $btn.attr('data-src');
      const btnText = $btn.text();
      const quality = extractQuality(btnText);
      const audioType = /eng|dub/i.test(btnText) ? 'Dub' : 'Sub';

      if (kwikUrl && kwikUrl.includes('kwik')) {
        const kwikOpts = { ...options, referer: `${options.domain || DEFAULT_DOMAINS[0]}/` };
        extractPromises.push(
          extractKwik(kwikUrl, kwikOpts)
            .then((res) => {
              if (res) {
                if (res.m3u8) {
                  streams.push({
                    name: `AnimePahe [HLS] (${quality} ${audioType})`,
                    title: `${resolvedTitle} - Ep ${targetEpisode} (${quality} ${audioType})`,
                    url: res.m3u8,
                    quality,
                    provider: 'animepahe',
                    headers: res.headers || {}
                  });
                }
                if (res.mp4) {
                  streams.push({
                    name: `AnimePahe [MP4] (${quality} ${audioType})`,
                    title: `${resolvedTitle} - Ep ${targetEpisode} (${quality} ${audioType})`,
                    url: res.mp4,
                    quality,
                    provider: 'animepahe',
                    headers: {
                      ...(res.headers || {}),
                      Referer: kwikUrl
                    }
                  });
                }
              }
            })
            .catch(() => {})
        );
      }
    });

    // Download menu links (#pickDownload a or div#pickDownload a)
    $('#pickDownload a, div#pickDownload a').each((_, el) => {
      const $link = $(el);
      const paheUrl = $link.attr('href');
      const linkText = $link.text();
      const quality = extractQuality(linkText);
      const audioType = /eng|dub/i.test(linkText) ? 'Dub' : 'Sub';

      if (paheUrl && (paheUrl.includes('pahe') || paheUrl.includes('kwik'))) {
        extractPromises.push(
          extractPahe(paheUrl, options)
            .then((res) => {
              if (res && res.url) {
                streams.push({
                  name: `AnimePahe [Direct] (${quality} ${audioType})`,
                  title: `${resolvedTitle} - Ep ${targetEpisode} (${quality} ${audioType})`,
                  url: res.url,
                  quality,
                  provider: 'animepahe',
                  headers: res.headers || {}
                });
              }
            })
            .catch(() => {})
        );
      }
    });

    await Promise.all(extractPromises);

    // Sort by quality preference
    const qualityWeight = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1.5, '360p': 1, Auto: 0 };
    streams.sort(
      (a, b) => (qualityWeight[b.quality] || 0) - (qualityWeight[a.quality] || 0)
    );

    console.log(`[AnimePahe] Resolved ${streams.length} stream(s) for ${resolvedTitle} Ep ${targetEpisode}`);
    return streams;
  } catch (err) {
    console.error(`[AnimePahe] Provider error for TMDB ID ${tmdbId}:`, err.message);
    return [];
  }
}

module.exports = {
  getAnimepaheStreams,
  getStreams: getAnimepaheStreams,
  extractQuality,
  cleanTitle,
  searchAnimePahe,
  getReleases,
  getPlayPageHtml
};
