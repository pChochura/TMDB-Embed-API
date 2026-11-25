let showboxResolver = null;
try {
  const sb = require('../Showbox');
  showboxResolver = sb.getStreamsFromTmdbId;
} catch {
  // ignore
}

async function resolveTier4(tmdbId, mediaType = 'movie', season = 1, episode = 1) {
  if (!showboxResolver) return null;
  try {
    const isTv = mediaType === 'tv' || mediaType === 'series';
    const s = isTv ? (season || 1) : null;
    const e = isTv ? (episode || 1) : null;

    const streams = await showboxResolver(tmdbId, mediaType, s, e);
    if (Array.isArray(streams) && streams.length > 0) {
      const first = streams[0];
      return {
        source: 'showbox',
        title: first.title || (isTv ? `TV ${tmdbId} S${season}E${episode}` : `Movie ${tmdbId}`),
        url: first.url,
        quality: first.quality || 'Auto',
        headers: first.headers || {},
        subtitles: first.subtitles || [],
      };
    }
  } catch {
    // cascade
  }
  return null;
}

module.exports = {
  resolveTier4,
};
