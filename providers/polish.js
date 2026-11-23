const axios = require('axios');
const cheerio = require('cheerio');
const { config } = require('../utils/config');
const { getDetails, getPolishTitle } = require('../utils/tmdb');
const { scoreCandidate } = require('../utils/titleMatch');
const { getStremioBridgeStreams } = require('./stremiobridge');
const { searchBajeczki24 } = require('./polish/bajeczki24');
const { searchObejrzyj } = require('./polish/obejrzyj');
const { searchPremiumsmart } = require('./polish/premiumsmart');
const { cleanColonTitle, matchesQuery, pickMatches } = require('../utils/polishMatcher');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const QUALITY_RANKS = {
  '4K': 5,
  '1080p': 4,
  '720p': 3,
  '480p': 2,
  '360p': 1,
  'Auto': 0
};

/**
 * Detect whether the target title is children's, family, or animated content
 */
function isAnimationOrKidsContent({ details, ctx = {} }) {
  if (ctx.isAnimation || ctx.isKids || ctx.isFamily) return true;

  const rawGenres = [
    ...(Array.isArray(ctx.genres) ? ctx.genres : []),
    ...(details && Array.isArray(details.genres) ? details.genres : []),
    ...(details && Array.isArray(details.genre_ids) ? details.genre_ids : [])
  ];

  // TMDB IDs: 16 (Animation), 10751 (Family), 10762 (Kids)
  const KIDS_GENRE_IDS = new Set([16, 10751, 10762]);
  for (const g of rawGenres) {
    if (typeof g === 'number' && KIDS_GENRE_IDS.has(g)) return true;
    if (g && typeof g === 'object') {
      if (KIDS_GENRE_IDS.has(g.id)) return true;
      if (typeof g.name === 'string' && /animation|family|kids|animacja|familijny|dzieci|bajka/i.test(g.name)) return true;
    }
    if (typeof g === 'string') {
      if (/^\d+$/.test(g) && KIDS_GENRE_IDS.has(parseInt(g, 10))) return true;
      if (/animation|family|kids|animacja|familijny|dzieci|bajka/i.test(g)) return true;
    }
  }

  const title = (details && (details.title || details.name)) || ctx.title || '';
  if (/\b(animowany|bajka|bajki|dla dzieci)\b/i.test(title)) return true;

  return false;
}

/**
 * Detect Polish audio tag for stream identification
 * Returns '[PL Lektor]', '[PL Napisy]', or '[PL Dubbing]'
 */
function detectAudioTag(text = '', isKidsOrAnimation = false) {
  const str = String(text).toLowerCase();
  if (/\b(dubbing|dub|pl-dubbing|pl dubbing|dubbing pl|polski dubbing|dubb)\b/i.test(str)) {
    return '[PL Dubbing]';
  }
  if (/\b(napisy|sub|subbed|pl-napisy|pl napisy|napisy pl|pl sub|napisy-pl)\b/i.test(str)) {
    return '[PL Napisy]';
  }
  if (/\b(lektor|lekt|pl-lektor|pl lektor|lektor pl|pl-lekt|pl lekt)\b/i.test(str)) {
    return '[PL Lektor]';
  }
  if (isKidsOrAnimation) {
    return '[PL Dubbing]';
  }
  return '[PL Lektor]';
}

/**
 * Rank audio type depending on whether content is kids/animation (Dubbing first)
 * or general/live-action (Lektor first)
 */
function getAudioRank(title = '', isKidsOrAnimation = false) {
  const str = String(title);
  if (isKidsOrAnimation) {
    if (str.includes('[PL Dubbing]')) return 3;
    if (str.includes('[PL Lektor]')) return 2;
    if (str.includes('[PL Napisy]')) return 1;
    return 0;
  } else {
    if (str.includes('[PL Lektor]')) return 3;
    if (str.includes('[PL Dubbing]')) return 2;
    if (str.includes('[PL Napisy]')) return 1;
    return 0;
  }
}

/**
 * Detect stream video resolution / quality
 */
function detectQuality(text = '') {
  const str = String(text);
  if (/\b(2160p|4k|uhd)\b/i.test(str)) return '4K';
  if (/\b(1080p|fhd)\b/i.test(str)) return '1080p';
  if (/\b(720p|hd)\b/i.test(str)) return '720p';
  if (/\b(480p|sd)\b/i.test(str)) return '480p';
  if (/\b(360p)\b/i.test(str)) return '360p';
  return 'Auto';
}

/**
 * Parse duration string (e.g. "01:42:15" or "45:30") into total seconds
 */
function parseDurationText(text = '') {
  if (!text) return null;
  const match = String(text).match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
  if (!match) return null;
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Clean up title string for presentation
 */
function cleanTitle(title = '') {
  return String(title)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build search queries for Polish scrapers based on metadata
 */
function buildSearchQueries({ title, polishTitle, year, isTv, season, episode, isAnimationOrKids = false }) {
  const queries = new Set();
  const epSuffix = isTv && season != null && episode != null
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : null;

  if (isTv && epSuffix) {
    if (isAnimationOrKids) {
      if (polishTitle) {
        queries.add(`${polishTitle} ${epSuffix} Dubbing PL`);
        queries.add(`${polishTitle} ${epSuffix} Dubbing`);
        queries.add(`${polishTitle} ${epSuffix}`);
      }
      if (title && title !== polishTitle) {
        queries.add(`${title} ${epSuffix} Dubbing PL`);
        queries.add(`${title} ${epSuffix} Dubbing`);
        queries.add(`${title} ${epSuffix}`);
      }
      if (polishTitle) {
        queries.add(`${polishTitle} ${epSuffix} Lektor`);
      }
    } else {
      if (polishTitle) {
        queries.add(`${polishTitle} ${epSuffix} Lektor`);
        queries.add(`${polishTitle} ${epSuffix}`);
      }
      if (title && title !== polishTitle) {
        queries.add(`${title} ${epSuffix} Lektor PL`);
        queries.add(`${title} ${epSuffix}`);
      }
    }
  } else {
    if (isAnimationOrKids) {
      if (polishTitle) {
        queries.add(`${polishTitle} Dubbing PL`);
        if (year) queries.add(`${polishTitle} ${year} Dubbing PL`);
        queries.add(`${polishTitle} Dubbing`);
        queries.add(`${polishTitle}`);
      }
      if (title && title !== polishTitle) {
        queries.add(`${title} Dubbing PL`);
        if (year) queries.add(`${title} ${year} Dubbing PL`);
        queries.add(`${title} Dubbing`);
      }
      if (polishTitle) {
        queries.add(`${polishTitle} Lektor PL`);
        queries.add(`${polishTitle} Napisy PL`);
      }
    } else {
      if (polishTitle) {
        queries.add(`${polishTitle} Lektor PL`);
        if (year) queries.add(`${polishTitle} ${year} Lektor`);
        queries.add(`${polishTitle} Napisy PL`);
        queries.add(`${polishTitle}`);
      }
      if (title && title !== polishTitle) {
        queries.add(`${title} Lektor PL`);
        if (year) queries.add(`${title} ${year} Lektor PL`);
        queries.add(`${title} Napisy PL`);
      }
    }
  }

  return Array.from(queries).filter(Boolean);
}

/**
 * Parse CDA search result HTML and extract streams
 */
function parseCDASearchResults(html, isKidsOrAnimation = false) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const streams = [];
  const seenIds = new Set();

  $('a[href*="/video/"]').each((_, elem) => {
    try {
      const href = $(elem).attr('href') || '';
      // Immediately skip premium /vfilm links and pagination /video/show links
      if (href.includes('/vfilm') || href.includes('/video/show')) return;

      const idMatch = href.match(/\/video\/([a-zA-Z0-9]+)/);
      if (!idMatch) return;

      const videoId = idMatch[1];
      if (videoId === 'show' || seenIds.has(videoId)) return;

      const container = $(elem).closest('.elem-rts, .video-clip, div');

      // Check for CDA premium markers within the card container
      const hasPremiumBadge = container.find('.flag-video-premium, .flag-premium, [class*="flag-premium"]').length > 0;
      const hasVfilmLink = container.find('a[href*="/vfilm"]').length > 0;
      const isPremiumClass = container.hasClass('video-premium') || container.find('.video-premium').length > 0;
      if (hasPremiumBadge || hasVfilmLink || isPremiumClass) {
        return;
      }

      seenIds.add(videoId);

      // Prefer explicit title attribute or link-title-visit anchor if present
      let rawTitle = $(elem).attr('title');
      if (!rawTitle) {
        const titleLink = container.find('a.link-title-visit').first();
        if (titleLink.length > 0) {
          rawTitle = titleLink.attr('title') || titleLink.text() || '';
        }
      }
      if (!rawTitle) {
        rawTitle = $(elem).text() || '';
      }

      const extraText = container.text() || '';
      const fullText = `${rawTitle} ${extraText}`;

      const timeText = container.find('.timeElem, .time, .time-badge, [class*="time"]').text() || '';
      const durationSec = parseDurationText(timeText) || parseDurationText(extraText);

      const qualityBadge = container.find('.quality, .hd-badge, span[class*="quality"]').text() || '';
      const quality = detectQuality(`${qualityBadge} ${fullText}`);
      const tag = detectAudioTag(fullText, isKidsOrAnimation);
      const cleaned = cleanTitle(rawTitle) || `Wideo ${videoId}`;

      streams.push({
        name: 'Polish [CDA]',
        title: `${tag} ${cleaned} - ${quality}`,
        url: `https://ebd.cda.pl/620x368/${videoId}`,
        quality: quality,
        provider: 'polish',
        duration: durationSec || null,
        headers: {
          'User-Agent': DEFAULT_UA,
          'Referer': 'https://www.cda.pl/'
        }
      });
    } catch {
      // ignore individual parsing error
    }
  });

  return streams;
}

/**
 * Scrape CDA for search query
 */
async function scrapeCDA(query, options = {}) {
  const { axiosInstance = axios, timeout = 6000, isKidsOrAnimation = false } = options;
  const searchUrl = `https://www.cda.pl/info/${encodeURIComponent(query)}`;
  try {
    const res = await axiosInstance.get(searchUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.cda.pl/',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
      },
      timeout: timeout,
      responseType: 'text'
    });
    if (!res || !res.data) return [];
    return parseCDASearchResults(res.data, isKidsOrAnimation);
  } catch (err) {
    console.warn(`[Polish/CDA] Search error for "${query}":`, err.message);
    return [];
  }
}

/**
 * Parse Vider search result HTML and extract streams
 */
function parseViderSearchResults(html, isKidsOrAnimation = false) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const streams = [];
  const seenIds = new Set();

  $('a[href*="/vid/"], a[href*="/video/"]').each((_, elem) => {
    try {
      const href = $(elem).attr('href') || '';
      const idMatch = href.match(/\/(?:vid|video)\/([a-zA-Z0-9_-]+)/);
      if (!idMatch) return;

      const videoId = idMatch[1];
      if (seenIds.has(videoId)) return;
      seenIds.add(videoId);

      const rawTitle = $(elem).attr('title') || $(elem).text() || '';
      const container = $(elem).closest('.video-item, .content-box, div');
      const extraText = container.text() || '';
      const fullText = `${rawTitle} ${extraText}`;

      const quality = detectQuality(fullText);
      const tag = detectAudioTag(fullText, isKidsOrAnimation);
      const cleaned = cleanTitle(rawTitle) || `Wideo ${videoId}`;
      const durationSec = parseDurationText(extraText);

      streams.push({
        name: 'Polish [Vider]',
        title: `${tag} ${cleaned} - ${quality}`,
        url: `https://vider.info/embed/video/${videoId}`,
        quality: quality,
        provider: 'polish',
        duration: durationSec || null,
        headers: {
          'User-Agent': DEFAULT_UA,
          'Referer': 'https://vider.info/'
        }
      });
    } catch {
      // ignore individual parsing error
    }
  });

  return streams;
}

/**
 * Scrape Vider for search query
 */
async function scrapeVider(query, options = {}) {
  const { axiosInstance = axios, timeout = 6000, isKidsOrAnimation = false } = options;
  const searchUrl = `https://vider.info/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await axiosInstance.get(searchUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://vider.info/',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
      },
      timeout: timeout,
      responseType: 'text'
    });
    if (!res || !res.data) return [];
    return parseViderSearchResults(res.data, isKidsOrAnimation);
  } catch (err) {
    console.warn(`[Polish/Vider] Search error for "${query}":`, err.message);
    return [];
  }
}

/**
 * Parse and resolve Filman / Obejrzyj aggregator results
 */
function parseFilmanObejrzyjResults(html, hoster = 'vShare', isKidsOrAnimation = false) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const streams = [];

  $('.link-to-video, a[href*="/link/"], tr.item').each((_, elem) => {
    try {
      const rawTitle = $(elem).text() || '';
      const href = $(elem).attr('href') || '';
      if (!href) return;

      const tag = detectAudioTag(rawTitle, isKidsOrAnimation);
      const quality = detectQuality(rawTitle);
      const cleaned = cleanTitle(rawTitle) || `Film (${hoster})`;

      streams.push({
        name: `Polish [${hoster}]`,
        title: `${tag} ${cleaned} - ${quality}`,
        url: href.startsWith('http') ? href : `https://filman.cc${href}`,
        quality: quality,
        provider: 'polish',
        headers: {
          'User-Agent': DEFAULT_UA,
          'Referer': 'https://filman.cc/'
        }
      });
    } catch {
      // ignore
    }
  });

  return streams;
}

/**
 * Scrape Filman aggregator for search query
 */
async function scrapeFilman(query, options = {}) {
  const { axiosInstance = axios, timeout = 6000, isKidsOrAnimation = false } = options;
  const searchUrl = `https://filman.cc/item?q=${encodeURIComponent(query)}`;
  try {
    const res = await axiosInstance.get(searchUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://filman.cc/',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
      },
      timeout: timeout,
      responseType: 'text'
    });
    if (!res || !res.data) return [];
    return parseFilmanObejrzyjResults(res.data, 'Filman', isKidsOrAnimation);
  } catch (err) {
    return [];
  }
}

/**
 * Parse and resolve TVP VOD results (e.g. for classic Polish kids' animations)
 */
function parseTVPResults(data, isKidsOrAnimation = true) {
  if (!data) return [];
  const items = Array.isArray(data) ? data : (data.items || data.results || data.products || data.data || []);
  const streams = [];

  for (const item of items) {
    if (!item) continue;
    const title = item.title || item.name || '';
    const id = item.id || item.external_uid || item.productId;
    if (!id) continue;

    const quality = item.quality || '1080p';
    const tag = detectAudioTag(title, isKidsOrAnimation);
    const cleaned = cleanTitle(title) || `TVP Video ${id}`;
    const url = item.video_url || item.url || `https://vod.tvp.pl/video/${id}`;

    streams.push({
      name: 'Polish [TVP VOD]',
      title: `${tag} ${cleaned} - ${quality}`,
      url: url,
      quality: quality,
      provider: 'polish',
      duration: item.duration || null,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://vod.tvp.pl/'
      }
    });
  }

  return streams;
}

/**
 * Scrape TVP VOD public catalogue for Polish kids / animations
 */
async function scrapeTVP(query, options = {}) {
  const { axiosInstance = axios, timeout = 6000, isKidsOrAnimation = true } = options;
  const searchUrl = `https://vod.tvp.pl/api/products/vods/search?query=${encodeURIComponent(query)}&platform=BROWSER&lang=pl`;
  try {
    const res = await axiosInstance.get(searchUrl, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://vod.tvp.pl/',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: timeout
    });
    if (!res || !res.data) return [];
    return parseTVPResults(res.data, isKidsOrAnimation);
  } catch (err) {
    return [];
  }
}

/**
 * Main provider entry point: getPolishStreams
 */
async function getPolishStreams(tmdbId, mediaType = 'movie', season = null, episode = null, ctx = {}) {
  let effectiveTmdbId = tmdbId;
  let effectiveMediaType = mediaType;
  let effectiveSeason = season;
  let effectiveEpisode = episode;
  let effectiveCtx = ctx || {};

  if (typeof tmdbId === 'object' && tmdbId !== null) {
    effectiveCtx = tmdbId;
    effectiveTmdbId = effectiveCtx.tmdbId;
    effectiveMediaType = effectiveCtx.type || effectiveCtx.mediaType || 'movie';
    effectiveSeason = effectiveCtx.season ?? null;
    effectiveEpisode = effectiveCtx.episode ?? null;
  }

  if (!effectiveTmdbId && !effectiveCtx.title) {
    return [];
  }

  const isTv = effectiveMediaType === 'tv' || effectiveMediaType === 'series' || effectiveMediaType === 'show';
  const tmdbType = isTv ? 'tv' : 'movie';

  // Support direct mock injection for tests
  if (Array.isArray(effectiveCtx.mockStreams)) {
    return effectiveCtx.mockStreams.map(s => {
      const tag = detectAudioTag(s.title || '');
      const quality = s.quality || detectQuality(s.title || '');
      return {
        ...s,
        provider: 'polish',
        quality: quality,
        title: s.title && (s.title.includes('[PL Lektor]') || s.title.includes('[PL Napisy]') || s.title.includes('[PL Dubbing]'))
          ? s.title
          : `${tag} ${cleanTitle(s.title || 'Stream')} - ${quality}`
      };
    });
  }

  try {
    let details = null;
    let polishTitle = effectiveCtx.polishTitle || null;

    if (effectiveTmdbId) {
      try {
        details = await getDetails(tmdbType, effectiveTmdbId, effectiveCtx.language || 'pl-PL');
      } catch (err) {
        console.warn(`[Polish] Could not fetch TMDB details for ${effectiveTmdbId}: ${err.message}`);
      }

      if (!polishTitle) {
        if (effectiveCtx.language && String(effectiveCtx.language).toLowerCase().startsWith('pl') && effectiveCtx.title) {
          polishTitle = effectiveCtx.title;
        } else {
          try {
            polishTitle = await getPolishTitle(tmdbType, effectiveTmdbId);
          } catch {
            // ignore error fetching polish title
          }
        }
      }
    }

    const title = effectiveCtx.title || (details && (details.title || details.name)) || polishTitle || null;
    if (!title && !polishTitle) {
      console.log(`[Polish] No title resolved for TMDB ID: ${effectiveTmdbId}`);
      return [];
    }

    const isKidsOrAnimation = isAnimationOrKidsContent({ details, ctx: effectiveCtx });

    const year = (details && (details.release_date || details.first_air_date)
      ? parseInt((details.release_date || details.first_air_date).slice(0, 4), 10)
      : null) || effectiveCtx.year || null;

    const searchQueries = buildSearchQueries({
      title,
      polishTitle: polishTitle || title,
      year,
      isTv,
      season: effectiveSeason != null ? parseInt(effectiveSeason, 10) : null,
      episode: effectiveEpisode != null ? parseInt(effectiveEpisode, 10) : null,
      isAnimationOrKids: isKidsOrAnimation
    });

    console.log(`[Polish] Searching streams (animation/kids: ${isKidsOrAnimation}) with queries: ${searchQueries.slice(0, 3).join(', ')}`);

    const hasCustomScrapers = Array.isArray(effectiveCtx.scrapers);
    const scrapers = effectiveCtx.scrapers || [scrapeCDA, scrapeVider, scrapeTVP, scrapeFilman];
    const timeout = effectiveCtx.timeout || 6000;
    const axiosInstance = effectiveCtx.axiosInstance || axios;

    const scrapeTasks = [];
    // Check top 3 search queries
    for (const query of searchQueries.slice(0, 3)) {
      for (const scraper of scrapers) {
        scrapeTasks.push(
          scraper(query, { timeout, axiosInstance, isKidsOrAnimation })
            .catch(() => [])
        );
      }
    }

    // If default scrapers are active, run structured high-value scrapers
    if (!hasCustomScrapers) {
      const searchParams = {
        title,
        polishTitle,
        year,
        type: effectiveMediaType,
        season: effectiveSeason != null ? parseInt(effectiveSeason, 10) : null,
        episode: effectiveEpisode != null ? parseInt(effectiveEpisode, 10) : null,
        tmdbId: effectiveTmdbId,
        imdbId: effectiveCtx.imdbId || (details && details.imdb_id)
      };

      // Bajeczki24 (kids & animation authority)
      if (isKidsOrAnimation || effectiveCtx.includeBajeczki) {
        scrapeTasks.push(
          searchBajeczki24(searchParams, { timeout, axiosInstance })
            .catch(() => [])
        );
      }

      // Obejrzyj.to (high-precision IMDb/TMDB/title search)
      scrapeTasks.push(
        searchObejrzyj(searchParams, { timeout, axiosInstance, isKidsOrAnimation })
          .catch(() => [])
      );

      // Premiumsmart.eu (REST API)
      scrapeTasks.push(
        searchPremiumsmart(searchParams, { timeout, axiosInstance, isKidsOrAnimation })
          .catch(() => [])
      );
    }

    const targetDuration = (details && (details.runtime ? details.runtime * 60 : (details.episode_run_time && details.episode_run_time[0] * 60))) ||
      (effectiveCtx.runtime ? effectiveCtx.runtime * 60 : null) || null;

    const targetQuery = {
      title: polishTitle || title,
      originalTitle: effectiveCtx.originalTitle || (details && (details.original_title || details.original_name)) || title,
      year,
      type: isTv ? 'series' : 'movie',
      season: effectiveSeason != null ? parseInt(effectiveSeason, 10) : null,
      episode: effectiveEpisode != null ? parseInt(effectiveEpisode, 10) : null,
      duration: targetDuration,
    };

    const results = await Promise.allSettled(scrapeTasks);
    const combined = [];
    const seenUrls = new Set();

    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        for (const item of r.value) {
          if (item && item.url && !seenUrls.has(item.url)) {
            if (targetQuery.title) {
              const seMatch = (item.title || '').match(/[sS](\d{1,2})[eE](\d{1,2})|(\d{1,2})x(\d{1,2})/);
              const candSeason = seMatch ? parseInt(seMatch[1] || seMatch[3], 10) : null;
              const candEpisode = seMatch ? parseInt(seMatch[2] || seMatch[4], 10) : null;
              const yearMatch = (item.title || '').match(/\b(19\d\d|20\d\d)\b/);
              const candYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

              const candidate = {
                title: item.title,
                year: candYear,
                type: isTv ? 'series' : 'movie',
                season: candSeason,
                episode: candEpisode,
                duration: item.duration || null,
              };

              const scored = scoreCandidate(targetQuery, candidate);
              if (scored.disqualified) {
                console.log(`[Polish] Discarding mismatched stream "${item.title}": ${scored.disqualificationReason}`);
                continue;
              }
            }

            seenUrls.add(item.url);
            const tag = detectAudioTag(item.title || '', isKidsOrAnimation);
            const quality = item.quality || detectQuality(item.title || '');
            const fullTitle = item.title && (item.title.includes('[PL Lektor]') || item.title.includes('[PL Napisy]') || item.title.includes('[PL Dubbing]'))
              ? item.title
              : `${tag} ${cleanTitle(item.title || 'Polish Video')} - ${quality}`;

            combined.push({
              name: item.name || 'Polish',
              title: fullTitle,
              url: item.url,
              quality: quality,
              provider: 'polish',
              headers: item.headers || {
                'User-Agent': DEFAULT_UA
              }
            });
          }
        }
      }
    }

    // Optional Stremio Polish bridge integration
    const polishBridgeUrls = effectiveCtx.polishBridgeUrls ||
      (config && config.polishStremioBridgeUrls && config.polishStremioBridgeUrls.length > 0 ? config.polishStremioBridgeUrls : null) ||
      (process.env.STREMIO_POLISH_BRIDGE_URLS ? [process.env.STREMIO_POLISH_BRIDGE_URLS] : null);

    if (polishBridgeUrls && polishBridgeUrls.length > 0) {
      try {
        const stremioStreams = await getStremioBridgeStreams(effectiveTmdbId, effectiveMediaType, effectiveSeason, effectiveEpisode, {
          ...effectiveCtx,
          bridgeUrls: polishBridgeUrls,
          language: 'pl'
        });
        if (Array.isArray(stremioStreams)) {
          for (const s of stremioStreams) {
            if (s && s.url && !seenUrls.has(s.url)) {
              seenUrls.add(s.url);
              const tag = detectAudioTag(s.title || s.name || '', isKidsOrAnimation);
              const quality = s.quality || detectQuality(s.title || s.name || '');
              combined.push({
                name: s.name && s.name.toLowerCase().includes('polish') ? s.name : `Polish [${s.name || 'Stremio'}]`,
                title: s.title && (s.title.includes('[PL Lektor]') || s.title.includes('[PL Napisy]') || s.title.includes('[PL Dubbing]'))
                  ? s.title
                  : `${tag} ${cleanTitle(s.title || title)} - ${quality}`,
                url: s.url,
                quality: quality,
                provider: 'polish',
                headers: s.headers || { 'User-Agent': DEFAULT_UA }
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[Polish/Stremio] Bridge query error:`, err.message);
      }
    }

    // Rank streams: Dubbing first for kids/animation; Lektor first for general movies
    combined.sort((a, b) => {
      const audioA = getAudioRank(a.title, isKidsOrAnimation);
      const audioB = getAudioRank(b.title, isKidsOrAnimation);
      if (audioA !== audioB) return audioB - audioA;
      const rankA = QUALITY_RANKS[a.quality] ?? 0;
      const rankB = QUALITY_RANKS[b.quality] ?? 0;
      return rankB - rankA;
    });

    console.log(`[Polish] Found ${combined.length} stream(s) for ${title || polishTitle}`);
    return combined.slice(0, 15);
  } catch (err) {
    console.error(`[Polish] Scrape error for TMDB ID ${effectiveTmdbId}:`, err.message);
    return [];
  }
}

module.exports = {
  getPolishStreams,
  detectAudioTag,
  detectQuality,
  cleanTitle,
  cleanColonTitle,
  buildSearchQueries,
  parseCDASearchResults,
  scrapeCDA,
  parseViderSearchResults,
  scrapeVider,
  parseFilmanObejrzyjResults,
  scrapeFilman,
  parseTVPResults,
  scrapeTVP,
  searchBajeczki24,
  searchObejrzyj,
  searchPremiumsmart,
  parseDurationText,
  isAnimationOrKidsContent,
  getAudioRank
};
