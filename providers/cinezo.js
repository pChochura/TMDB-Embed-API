const { extractPlayerStreams } = require('../utils/browserStreams');

async function getCinezoStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return extractPlayerStreams({
    provider: 'Cinezo',
    baseUrl: 'https://www.cinezo.st',
    tmdbId,
    mediaType,
    season,
    episode,
    seriesPath: (id, s, e) => `/watch/tv/${id}?season=${s}&episode=${e}`
  });
}

module.exports = { getCinezoStreams };
