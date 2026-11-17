const { extractPlayerStreams } = require('../utils/browserStreams');

async function getHexaStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return extractPlayerStreams({
    provider: 'Hexa',
    baseUrl: 'https://hexa.su',
    tmdbId,
    mediaType,
    season,
    episode,
    seriesPath: (id, s, e) => `/watch/tv/${id}/${s}/${e}`
  });
}

module.exports = { getHexaStreams };
