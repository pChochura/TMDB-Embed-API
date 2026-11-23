const axios = require('axios');
const cheerio = require('cheerio');
const { getDetails, getPolishTitle } = require('../utils/tmdb');
const { scoreCandidate } = require('../utils/titleMatch');

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
 * Detect Polish audio tag for stream identification
 * Returns '[PL Lektor]', '[PL Napisy]', or '[PL Dubbing]'
 */
function detectAudioTag(text = '') {
  const str = String(text).toLowerCase();
  if (/\b(dubbing|dub|pl-dubbing|pl dubbing|dubbing pl)\b/i.test(str)) {
    return '[PL Dubbing]';
  }
  if (/\b(napisy|sub|subbed|pl-napisy|pl napisy|napisy pl|pl sub|napisy-pl)\b/i.test(str)) {
    return '[PL Napisy]';
  }
  if (/\b(lektor|lekt|pl-lektor|pl lektor|lektor pl|pl-lekt|pl lekt)\b/i.test(str)) {
    return '[PL Lektor]';
  }
  return '[PL Lektor]';
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
function buildSearchQueries({ title, polishTitle, year, isTv, season, episode }) {
  const queries = new Set();
  const epSuffix = isTv && season != null && episode != null
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : null;

  if (isTv && epSuffix) {
    if (polishTitle) {
      queries.add(`${polishTitle} ${epSuffix} Lektor`);
      queries.add(`${polishTitle} ${epSuffix}`);
    }
    if (title && title !== polishTitle) {
      queries.add(`${title} ${epSuffix} Lektor PL`);
      queries.add(`${title} ${epSuffix}`);
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

  return Array.from(queries).filter(Boolean);
}

/**
 * Parse CDA search result HTML and extract streams
 */
function parseCDASearchResults(html) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const streams = [];
  const seenIds = new Set();

  $('a[href*="/video/"]').each((_, elem) => {
    try {
      const href = $(elem).attr('href') || '';
      // Immediately skip premium /vfilm links
      if (href.includes('/vfilm')) return;

      const idMatch = href.match(/\/video\/([a-zA-Z0-9]+)/);
      if (!idMatch) return;

      const videoId = idMatch[1];
      if (seenIds.has(videoId)) return;

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
      const tag = detectAudioTag(fullText);
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
  const { axiosInstance = axios, timeout = 6000 } = options;
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
    return parseCDASearchResults(res.data);
  } catch (err) {
    console.warn(`[Polish/CDA] Search error for "${query}":`, err.message);
    return [];
  }
}

/**
 * Parse Vider search result HTML and extract streams
 */
function parseViderSearchResults(html) {
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
      const tag = detectAudioTag(fullText);
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
  const { axiosInstance = axios, timeout = 6000 } = options;
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
    return parseViderSearchResults(res.data);
  } catch (err) {
    console.warn(`[Polish/Vider] Search error for "${query}":`, err.message);
    return [];
  }
}

/**
 * Parse and resolve Filman / Obejrzyj aggregator results
 */
function parseFilmanObejrzyjResults(html, hoster = 'vShare') {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const streams = [];

  $('.link-to-video, a[href*="/link/"], tr.item').each((_, elem) => {
    try {
      const rawTitle = $(elem).text() || '';
      const href = $(elem).attr('href') || '';
      if (!href) return;

      const tag = detectAudioTag(rawTitle);
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
        details = await getDetails(tmdbType, effectiveTmdbId);
      } catch (err) {
        console.warn(`[Polish] Could not fetch TMDB details for ${effectiveTmdbId}: ${err.message}`);
      }

      if (!polishTitle) {
        try {
          polishTitle = await getPolishTitle(tmdbType, effectiveTmdbId);
        } catch {
          // ignore error fetching polish title
        }
      }
    }

    const title = (details && (details.title || details.name)) || effectiveCtx.title || null;
    if (!title && !polishTitle) {
      console.log(`[Polish] No title resolved for TMDB ID: ${effectiveTmdbId}`);
      return [];
    }

    const year = (details && (details.release_date || details.first_air_date)
      ? parseInt((details.release_date || details.first_air_date).slice(0, 4), 10)
      : null) || effectiveCtx.year || null;

    const searchQueries = buildSearchQueries({
      title,
      polishTitle: polishTitle || title,
      year,
      isTv,
      season: effectiveSeason != null ? parseInt(effectiveSeason, 10) : null,
      episode: effectiveEpisode != null ? parseInt(effectiveEpisode, 10) : null
    });

    console.log(`[Polish] Searching streams with queries: ${searchQueries.slice(0, 3).join(', ')}`);

    const scrapers = effectiveCtx.scrapers || [scrapeCDA, scrapeVider];
    const timeout = effectiveCtx.timeout || 6000;
    const axiosInstance = effectiveCtx.axiosInstance || axios;

    const scrapeTasks = [];
    for (const query of searchQueries.slice(0, 2)) {
      for (const scraper of scrapers) {
        scrapeTasks.push(
          scraper(query, { timeout, axiosInstance })
            .catch(() => [])
        );
      }
    }

    const targetDuration = (details && (details.runtime ? details.runtime * 60 : (details.episode_run_time && details.episode_run_time[0] * 60))) ||
      (effectiveCtx.runtime ? effectiveCtx.runtime * 60 : null) || null;

    const targetQuery = {
      title: polishTitle || title,
      originalTitle: title,
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
            const tag = detectAudioTag(item.title || '');
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

    // Rank streams: Lektor first, then highest resolution
    combined.sort((a, b) => {
      const aLektor = a.title.includes('[PL Lektor]') ? 1 : 0;
      const bLektor = b.title.includes('[PL Lektor]') ? 1 : 0;
      if (aLektor !== bLektor) return bLektor - aLektor;
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
  buildSearchQueries,
  parseCDASearchResults,
  scrapeCDA,
  parseViderSearchResults,
  scrapeVider,
  parseFilmanObejrzyjResults,
  parseDurationText
};
