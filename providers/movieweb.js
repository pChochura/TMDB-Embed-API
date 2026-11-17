const { makeProviders, makeStandardFetcher, targets } = require('@movie-web/providers');
const { getDetails, resolveImdbId } = require('../utils/tmdb');

let providerControls = null;

function getProvidersInstance(customFetcher) {
  if (customFetcher) {
    return makeProviders({
      fetcher: makeStandardFetcher(customFetcher),
      target: targets.NATIVE
    });
  }
  if (!providerControls) {
    const fetchFn = typeof globalThis.fetch === 'function'
      ? globalThis.fetch
      : (...args) => import('node-fetch').then(m => m.default(...args));
    providerControls = makeProviders({
      fetcher: makeStandardFetcher(fetchFn),
      target: targets.NATIVE
    });
  }
  return providerControls;
}

function formatQuality(qual) {
  if (!qual) return 'Auto';
  const qStr = String(qual).trim().toLowerCase();
  if (qStr === 'unknown' || qStr === 'auto') return 'Auto';
  if (qStr === '4k' || qStr === '2160' || qStr === '2160p') return '4K';
  if (/^\d+$/.test(qStr)) return `${qStr}p`;
  if (/^\d+p$/.test(qStr)) return qStr;
  return qual;
}

function mapStreamToStandard(runResult) {
  if (!runResult) return [];

  if (Array.isArray(runResult)) {
    return runResult.flatMap(item => mapStreamToStandard(item));
  }

  const sourceId = runResult.sourceId || runResult.source || '';
  const embedId = runResult.embedId || runResult.embed || '';
  const labelPart = [sourceId, embedId].filter(Boolean).join('/') || 'default';
  const stream = runResult.stream || runResult;

  if (!stream) return [];

  const headers = stream.preferredHeaders || stream.headers || {};
  const streams = [];

  // Case 1: HLS playlist stream
  if (stream.type === 'hls' || stream.playlist) {
    const playlistUrl = stream.playlist || stream.url;
    if (playlistUrl) {
      streams.push({
        name: `MovieWeb [${labelPart}]`,
        title: `MovieWeb (${labelPart}) - Auto`,
        url: playlistUrl,
        quality: 'Auto',
        provider: 'movieweb',
        headers: { ...headers }
      });
    }
  }

  // Case 2: File-based stream with qualities map
  if (stream.type === 'file' && stream.qualities && typeof stream.qualities === 'object') {
    for (const [qualKey, fileObj] of Object.entries(stream.qualities)) {
      if (fileObj && fileObj.url) {
        const quality = formatQuality(qualKey);
        streams.push({
          name: `MovieWeb [${labelPart}] ${quality}`,
          title: `MovieWeb (${labelPart}) - ${quality}`,
          url: fileObj.url,
          quality,
          provider: 'movieweb',
          headers: { ...headers }
        });
      }
    }
  }

  // Case 3: Direct URL stream (fallback/custom)
  if (streams.length === 0 && stream.url) {
    const quality = formatQuality(stream.quality);
    streams.push({
      name: `MovieWeb [${labelPart}]`,
      title: `MovieWeb (${labelPart}) - ${quality}`,
      url: stream.url,
      quality,
      provider: 'movieweb',
      headers: { ...headers }
    });
  }

  return streams;
}

async function getMovieWebStreams(tmdbId, mediaType = 'movie', season = null, episode = null, ctx = {}) {
  console.log(`[MovieWeb] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

  try {
    const isTv = mediaType === 'tv' || mediaType === 'series';
    const tmdbType = isTv ? 'tv' : 'movie';

    let details = null;
    try {
      details = await getDetails(tmdbType, tmdbId);
    } catch (err) {
      console.warn(`[MovieWeb] Could not fetch TMDB details for ${tmdbId}: ${err.message}`);
    }

    const title = (details && (details.title || details.name)) || ctx?.title || '';
    if (!title) {
      console.log(`[MovieWeb] No title resolved for TMDB ID: ${tmdbId}`);
      return [];
    }

    const rawDate = (details && (details.release_date || details.first_air_date)) || (ctx?.year ? String(ctx.year) : '');
    const releaseYear = rawDate ? parseInt(rawDate.slice(0, 4), 10) : (parseInt(ctx?.year, 10) || 0);

    let imdbId = ctx?.imdbId || (details && details.imdb_id) || null;
    if (!imdbId) {
      try {
        imdbId = await resolveImdbId(tmdbType, tmdbId);
      } catch {
        // ignore
      }
    }

    let media;
    if (isTv) {
      const sNum = parseInt(season ?? ctx?.season ?? 1, 10) || 1;
      const eNum = parseInt(episode ?? ctx?.episode ?? 1, 10) || 1;
      media = {
        type: 'show',
        title,
        releaseYear: releaseYear || 0,
        tmdbId: String(tmdbId),
        ...(imdbId ? { imdbId } : {}),
        season: {
          number: sNum,
          tmdbId: ''
        },
        episode: {
          number: eNum,
          tmdbId: ''
        }
      };
    } else {
      media = {
        type: 'movie',
        title,
        releaseYear: releaseYear || 0,
        tmdbId: String(tmdbId),
        ...(imdbId ? { imdbId } : {})
      };
    }

    const runnerOps = {
      media,
      ...(ctx?.sourceOrder ? { sourceOrder: ctx.sourceOrder } : {}),
      ...(ctx?.embedOrder ? { embedOrder: ctx.embedOrder } : {})
    };

    const providers = ctx?.providersInstance || getProvidersInstance();
    const timeoutMs = Number(ctx?.timeout) || 15000;

    let timeoutTimer = null;
    const scrapePromise = providers.runAll(runnerOps);
    const timeoutPromise = new Promise((resolve) => {
      timeoutTimer = setTimeout(() => {
        console.warn(`[MovieWeb] Scrape timed out after ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs);
    });

    const runOutput = await Promise.race([scrapePromise, timeoutPromise]);
    if (timeoutTimer) clearTimeout(timeoutTimer);

    if (!runOutput) {
      console.log(`[MovieWeb] No streams found for ${title} (${releaseYear})`);
      return [];
    }

    const mapped = mapStreamToStandard(runOutput);
    console.log(`[MovieWeb] Resolved ${mapped.length} stream(s) from ${runOutput.sourceId || 'movieweb'}`);
    return mapped;

  } catch (err) {
    console.error(`[MovieWeb] Scrape error for TMDB ID ${tmdbId}:`, err.message);
    return [];
  }
}

module.exports = {
  getMovieWebStreams,
  mapStreamToStandard,
  formatQuality,
  getProvidersInstance
};
