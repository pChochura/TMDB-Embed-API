const { resolveTier1 } = require('./tier1_vidara');
const { resolveTier2 } = require('./tier2_extractor');
const { resolveTier3 } = require('./tier3_vidrift');
const { resolveTier4 } = require('./tier4_showbox');

/**
 * Resolves streams across Tier 1 -> Tier 2 -> Tier 3 -> Tier 4 natively in-process.
 *
 * @param {string|number} tmdbId
 * @param {'movie'|'series'|'tv'} [mediaType='movie']
 * @param {number|string} [season]
 * @param {number|string} [episode]
 * @returns {Promise<Array<Object>>}
 */
async function resolveVideogetterInProcess(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  const s = season ? Number(season) : 1;
  const e = episode ? Number(episode) : 1;

  const foundStreams = [];

  // Tier 1: Vidara, StreamHG, StreamTape, HubCloud
  try {
    const t1Res = await resolveTier1(tmdbId, normType, s, e);
    if (t1Res && t1Res.url) {
      foundStreams.push(t1Res);
    }
  } catch (err) {
    // continue to next tier
  }

  // Tier 2: VidFast Extractor
  if (!foundStreams.length) {
    try {
      const t2Res = await resolveTier2(tmdbId, normType, s, e);
      if (t2Res && t2Res.url) {
        foundStreams.push(t2Res);
      }
    } catch (err) {
      // continue to next tier
    }
  }

  // Tier 3: CineTV & Vidrift Engine
  if (!foundStreams.length) {
    try {
      const t3Res = await resolveTier3(tmdbId, normType, s, e);
      if (t3Res && t3Res.url) {
        foundStreams.push(t3Res);
      }
    } catch (err) {
      // continue to next tier
    }
  }

  // Tier 4: ShowBox
  if (!foundStreams.length) {
    try {
      const t4Res = await resolveTier4(tmdbId, normType, s, e);
      if (t4Res && t4Res.url) {
        foundStreams.push(t4Res);
      }
    } catch (err) {
      // finish
    }
  }

  return foundStreams.map((item, idx) => {
    const sourceLabel = item.source || `Tier ${idx + 1}`;
    const quality = item.quality || 'Auto';
    const streamTitle = item.title ? `${quality} [${item.title}]` : `${quality} [VideoGetter #${idx + 1}]`;

    return {
      name: `VideoGetter (${sourceLabel})`,
      title: streamTitle,
      url: item.url,
      quality: String(quality),
      provider: 'videogetter',
      headers: item.headers && typeof item.headers === 'object' && Object.keys(item.headers).length > 0
        ? { ...item.headers }
        : {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
      subtitles: Array.isArray(item.subtitles) ? item.subtitles : [],
    };
  });
}

module.exports = {
  resolveVideogetterInProcess,
};
