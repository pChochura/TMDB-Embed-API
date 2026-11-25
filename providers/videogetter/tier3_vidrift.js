const axios = require('axios');
const cfg = require('./config');

const reEmbedMeta = /embedMeta\s*=\s*(\{.*?\});\s*(?:<\/script>|var\s+|const\s+|let\s+|\n)/s;

async function resolveCineTV(tmdbId, mediaType = 'movie', season = 1, episode = 1) {
  const cinetvBase = (process.env.CINETV_BASE_URL || cfg.defaultCineTVBaseURL).replace(/\/+$/, '');
  const endpoint = mediaType === 'movie'
    ? `${cinetvBase}/movie/${tmdbId}`
    : `${cinetvBase}/tv/${tmdbId}/${season}/${episode}`;

  try {
    const res = await axios.get(endpoint, {
      headers: cfg.defaultHeaders,
      timeout: 10000,
    });
    const data = res.data;
    if (data && data.url && !data.error) {
      return {
        source: 'cinetv',
        title: data.name || (mediaType === 'movie' ? `Movie ${tmdbId}` : `TV ${tmdbId} S${season}E${episode}`),
        url: data.url,
        quality: 'Auto',
        headers: {},
        subtitles: [],
      };
    }
  } catch {
    // cascade
  }
  return null;
}

async function resolveVidrift(tmdbId, mediaType = 'movie', season = 1, episode = 1) {
  const vidriftBase = (process.env.VIDRIFT_BASE_URL || cfg.defaultVidriftBaseURL).replace(/\/+$/, '');
  const mediaPath = mediaType === 'movie' ? `movie/${tmdbId}` : `tv/${tmdbId}/${season}/${episode}`;
  const embedURL = `${vidriftBase}/embed/${mediaPath}`;

  try {
    const res = await axios.get(embedURL, {
      headers: {
        ...cfg.defaultHeaders,
        'Referer': `${vidriftBase}/`,
      },
      timeout: 12000,
    });

    const html = res.data;
    if (!html || typeof html !== 'string') return null;

    const m = html.match(reEmbedMeta);
    if (!m) return null;

    let meta = null;
    try {
      meta = JSON.parse(m[1]);
    } catch {
      return null;
    }
    if (!meta) return null;

    // 1. Evion URL
    if (meta.evionUrl && typeof meta.evionUrl === 'string' && meta.evionUrl.trim()) {
      return {
        source: 'vidrift-evion',
        title: `Vidrift Evion`,
        url: meta.evionUrl.trim(),
        quality: '1080p',
        headers: {
          'Origin': vidriftBase,
          'Referer': `${vidriftBase}/`,
        },
        subtitles: [],
      };
    }

    // 2. Fallback to API providers: atlas -> vela
    const token = meta.playbackToken ? String(meta.playbackToken).trim() : '';
    if (token) {
      for (const prov of ['atlas', 'vela']) {
        try {
          const apiURL = `${vidriftBase}/api/source/${mediaPath}?token=${encodeURIComponent(token)}&provider=${prov}`;
          const apiRes = await axios.get(apiURL, {
            headers: {
              ...cfg.defaultHeaders,
              'Referer': embedURL,
              'Origin': vidriftBase,
            },
            timeout: 8000,
          });

          const apiData = apiRes.data;
          if (apiData && Array.isArray(apiData.streams) && apiData.streams.length > 0) {
            const first = apiData.streams[0];
            const streamURL = first.proxyUrl || first.url;
            if (streamURL) {
              return {
                source: `vidrift-${prov}`,
                title: `Vidrift (${prov})`,
                url: streamURL,
                quality: 'Auto',
                headers: {
                  'Origin': vidriftBase,
                  'Referer': `${vidriftBase}/`,
                },
                subtitles: [],
              };
            }
          }
        } catch {
          // try next
        }
      }
    }

    // 3. Orion Streams
    if (Array.isArray(meta.orionStreams) && meta.orionStreams.length > 0) {
      const first = meta.orionStreams[0];
      let candidate = first.proxyUrl || first.url;
      if (candidate) {
        if (candidate.startsWith('/')) {
          candidate = `${vidriftBase}${candidate}`;
        }
        return {
          source: 'vidrift-orion',
          title: `Vidrift (Orion)`,
          url: candidate,
          quality: 'Auto',
          headers: {
            'Origin': vidriftBase,
            'Referer': `${vidriftBase}/`,
          },
          subtitles: [],
        };
      }
    }
  } catch {
    // cascade
  }
  return null;
}

async function resolveTier3(tmdbId, mediaType = 'movie', season = 1, episode = 1) {
  // 1. CineTV
  try {
    const cinetvStream = await resolveCineTV(tmdbId, mediaType, season, episode);
    if (cinetvStream) return cinetvStream;
  } catch {
    // fallback to vidrift
  }

  // 2. Vidrift
  try {
    const vidriftStream = await resolveVidrift(tmdbId, mediaType, season, episode);
    if (vidriftStream) return vidriftStream;
  } catch {
    // cascade
  }

  return null;
}

module.exports = {
  resolveCineTV,
  resolveVidrift,
  resolveTier3,
};
