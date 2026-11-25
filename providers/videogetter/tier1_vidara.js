const fs = require('fs');
const axios = require('axios');
const JsUnpacker = require('../../utils/jsunpack');
const cfg = require('./config');

let datasetCache = null;
let datasetLoaded = false;

function cleanID(val) {
  if (!val) return '';
  let s = String(val).trim();
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      const parts = u.pathname.replace(/\/+$/, '').split('/');
      s = parts[parts.length - 1];
    } catch {
      // ignore
    }
  }
  return s.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
}

function loadLocalDataset() {
  if (datasetLoaded && datasetCache) return datasetCache;
  try {
    if (fs.existsSync(cfg.localDataPath)) {
      const content = fs.readFileSync(cfg.localDataPath, 'utf8');
      datasetCache = JSON.parse(content);
      datasetLoaded = true;
      return datasetCache;
    }
  } catch (err) {
    console.warn('[VideoGetter:Tier1] Error reading local vidara.json:', err.message);
  }
  datasetCache = [];
  return datasetCache;
}

function findMediaRecord(tmdbId, mediaType = 'movie', season = 1, episode = 1) {
  const data = loadLocalDataset();
  if (!Array.isArray(data) || !data.length) return null;

  const idNum = parseInt(tmdbId, 10);
  const isMovie = mediaType === 'movie';

  for (const item of data) {
    if (item.id === idNum) {
      if (isMovie && (item.type === 'movie' || !item.type)) {
        return {
          title: item.title || `Movie ${idNum}`,
          play: item.play || {},
        };
      }
      if (!isMovie && item.type === 'tv' && Number(item.season) === Number(season)) {
        if (Array.isArray(item.episodes)) {
          const ep = item.episodes.find(e => Number(e.episode) === Number(episode));
          if (ep) {
            return {
              title: item.title || `TV ${idNum} S${season}E${episode}`,
              play: ep.play || {},
            };
          }
        }
      }
    }
  }
  return null;
}

function unpackPackedJS(html) {
  if (!html) return '';
  const unpacker = new JsUnpacker(html);
  if (unpacker.detect()) {
    const unpacked = unpacker.unpack();
    if (unpacked) return unpacked;
  }

  const match = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/);
  if (!match) return '';

  let payload = match[1].replace(/\\'/g, "'");
  const base = parseInt(match[2], 10);
  const count = parseInt(match[3], 10);
  const words = match[4].split('|');

  if (isNaN(base) || isNaN(count) || base <= 0) return '';

  function toBase(num, radix) {
    return num.toString(radix);
  }

  for (let index = count - 1; index >= 0; index--) {
    if (index < words.length && words[index]) {
      const tok = toBase(index, base);
      const re = new RegExp(`\\b${tok}\\b`, 'g');
      payload = payload.replace(re, words[index]);
    }
  }
  return payload;
}

async function extractVidara(urlOrId) {
  const fileCode = cleanID(urlOrId);
  if (!fileCode) return null;

  const apiURL = `${cfg.defaultVidaraBaseURL}/api/stream`;
  const response = await axios.post(
    apiURL,
    { filecode: fileCode, device: 'web' },
    {
      headers: {
        'Content-Type': 'application/json',
        ...cfg.defaultHeaders,
        'Referer': `${cfg.defaultVidaraBaseURL}/`,
        'Origin': cfg.defaultVidaraBaseURL,
      },
      timeout: cfg.requestTimeout,
    }
  );

  const data = response.data;
  if (!data || !data.streaming_url) return null;

  return {
    source: 'vidara',
    title: data.title || '',
    url: data.streaming_url,
    quality: 'Auto',
    headers: {
      'Referer': `${cfg.defaultVidaraBaseURL}/`,
      'Origin': cfg.defaultVidaraBaseURL,
    },
    subtitles: Array.isArray(data.subtitles)
      ? data.subtitles.map(s => ({ url: s.url || s.file, lang: s.lang || s.language || 'en' }))
      : [],
  };
}

async function extractStreamTape(urlOrId) {
  const fileCode = cleanID(urlOrId);
  if (!fileCode) return null;

  const targetURL = `https://streamtape.com/v/${fileCode}/`;
  const response = await axios.get(targetURL, {
    headers: {
      ...cfg.defaultHeaders,
      'Referer': 'https://streamtape.com/',
    },
    timeout: cfg.requestTimeout,
  });

  const html = response.data;
  if (!html || typeof html !== 'string') return null;

  // Search for botlink / robotlink
  let matchExpr = '';
  const lines = html.split('\n');
  for (const line of lines) {
    if (line.includes("botlink').innerHTML")) {
      const idx = line.indexOf(').innerHTML');
      if (idx !== -1) {
        const after = line.slice(idx + ').innerHTML'.length);
        const eqIdx = after.indexOf('=');
        if (eqIdx !== -1) {
          let rawExpr = after.slice(eqIdx + 1);
          const sIdx = rawExpr.indexOf('</script>');
          if (sIdx !== -1) rawExpr = rawExpr.slice(0, sIdx);
          matchExpr = rawExpr.trim().replace(/;+$/, '').trim();
          break;
        }
      }
    }
  }

  if (!matchExpr) {
    const m = html.match(/id=["'](?:robotlink|botlink)["'][^>]*>([^<]+)</) ||
      html.match(/document\.getElementById\(['"](?:botlink|robotlink)['"]\)\.innerHTML\s*=\s*(.*?);/);
    if (m) matchExpr = m[1].trim();
  }

  if (!matchExpr) return null;

  let streamURL = '';
  // Try evaluating safely
  try {
    const parts = matchExpr.match(/'([^']*)'|"([^"]*)"/g);
    if (parts && parts.length > 0) {
      streamURL = parts.map(p => p.slice(1, -1)).join('');
    } else {
      const vm = require('node:vm');
      streamURL = vm.runInNewContext(matchExpr);
    }
  } catch {
    return null;
  }

  if (!streamURL) return null;

  if (streamURL.startsWith('//')) {
    streamURL = 'https:' + streamURL;
  } else if (!streamURL.startsWith('http')) {
    streamURL = 'https://' + streamURL;
  }

  if (!streamURL.includes('&stream=1')) {
    streamURL += '&stream=1';
  }

  streamURL = streamURL
    .replace('/get_xcdvideo?', '/get_video?')
    .replace('xcdd=', 'd=')
    .replace('/get_xcd', '/get_');

  return {
    source: 'streamtape',
    title: 'StreamTape',
    url: streamURL,
    quality: 'Auto',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': targetURL,
    },
    subtitles: [],
  };
}

async function extractStreamHG(urlOrId) {
  const fileCode = cleanID(urlOrId);
  if (!fileCode) return null;

  const mirrors = ['https://hanerix.com', 'https://streamhg.com', 'https://hglink.to', 'https://hgcloud.to'];
  for (const mirror of mirrors) {
    try {
      const pageURL = `${mirror}/e/${fileCode}`;
      const response = await axios.get(pageURL, {
        headers: {
          ...cfg.defaultHeaders,
          'Referer': 'https://hglink.to/',
        },
        timeout: 10000,
      });

      const html = response.data;
      if (!html || typeof html !== 'string') continue;

      const unpacked = unpackPackedJS(html) || html;

      // Match candidate stream URLs (hls4, hls3, hls2 or direct m3u8)
      const candidates = [];
      const linksMatch = unpacked.match(/var\s+links\s*=\s*(\{.*?\});/s);
      if (linksMatch) {
        try {
          const linksObj = JSON.parse(linksMatch[1].replace(/([a-zA-Z0-9_]+):/g, '"$1":').replace(/'/g, '"'));
          for (const k of ['hls4', 'hls3', 'hls2']) {
            if (linksObj[k]) candidates.push(linksObj[k].replace(/\\\//g, '/'));
          }
        } catch {
          // fallback
        }
      }

      if (!candidates.length) {
        const m3u8Matches = [...unpacked.matchAll(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g)].map(m => m[0]);
        candidates.push(...m3u8Matches);
      }

      if (candidates.length > 0) {
        let streamURL = candidates[0];
        if (streamURL.startsWith('/')) {
          streamURL = new URL(streamURL, mirror).href;
        }

        return {
          source: 'streamhg',
          title: 'StreamHG',
          url: streamURL,
          quality: 'Auto',
          headers: {
            'Referer': pageURL,
            'Origin': mirror,
          },
          subtitles: [],
        };
      }
    } catch {
      // try next mirror
    }
  }
  return null;
}

async function extractHubCloud(urlOrId) {
  const clean = String(urlOrId).trim();
  if (!clean) return null;

  const hubBase = cfg.defaultHubCloudBaseURL;
  let realURL = clean;
  if (!realURL.startsWith('http://') && !realURL.startsWith('https://')) {
    const pathPart = clean.startsWith('drive/') ? clean : `drive/${clean}`;
    realURL = `${hubBase}/${pathPart}`;
  }

  try {
    let nextHref = realURL;
    if (!realURL.includes('hubcloud.php')) {
      const res1 = await axios.get(realURL, {
        headers: { ...cfg.defaultHeaders, Referer: hubBase },
        timeout: 10000,
      });
      const html1 = res1.data;
      const m = html1.match(/<a[^>]+id=["']download["'][^>]+href=["']([^"']+)["']/i) ||
        html1.match(/<a[^>]+href=["']([^"']+)["'][^>]+id=["']download["']/i);
      if (!m) return null;
      const rawHref = m[1].trim();
      nextHref = rawHref.startsWith('http') ? rawHref : new URL(rawHref, realURL).href;
    }

    const res2 = await axios.get(nextHref, {
      headers: { ...cfg.defaultHeaders, Referer: realURL },
      timeout: 10000,
    });
    const html2 = res2.data;

    const matches = [...html2.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    let fslv2Link = '';
    let fslLink = '';
    let buzzLink = '';

    for (const match of matches) {
      const href = match[1].trim();
      const text = match[2].replace(/<[^>]+>/g, ' ').toLowerCase();
      if (text.includes('fslv2')) {
        if (!fslv2Link) fslv2Link = href;
      } else if (text.includes('fsl server') && !text.includes('fslv2')) {
        if (!fslLink) fslLink = href;
      } else if (text.includes('buzzserver') || text.includes('buzz server')) {
        if (!buzzLink) buzzLink = href;
      }
    }

    const chosen = fslv2Link || fslLink || buzzLink;
    if (!chosen) return null;

    return {
      source: 'hubcloud',
      title: 'HubCloud',
      url: chosen,
      quality: 'Auto',
      headers: {},
      subtitles: [],
    };
  } catch {
    return null;
  }
}

async function resolveTier1(tmdbId, mediaType = 'movie', season = 1, episode = 1) {
  const record = findMediaRecord(tmdbId, mediaType, season, episode);
  if (!record || !record.play) return null;

  const play = record.play;

  // Direct URL
  const directUrl = play.url || play.play || play.direct_url;
  if (directUrl && typeof directUrl === 'string' && directUrl.startsWith('http')) {
    return {
      source: 'direct',
      title: record.title,
      url: directUrl,
      quality: 'Auto',
      headers: {},
      subtitles: [],
    };
  }

  // Priority 1: Vidara (va)
  if (play.va) {
    try {
      const stream = await extractVidara(play.va);
      if (stream) return stream;
    } catch {
      // continue to next provider
    }
  }

  // Priority 2: StreamHG (sh or sg)
  const shId = play.sh || play.sg;
  if (shId) {
    try {
      const stream = await extractStreamHG(shId);
      if (stream) return stream;
    } catch {
      // continue to next provider
    }
  }

  // Priority 3: StreamTape (st)
  if (play.st) {
    try {
      const stream = await extractStreamTape(play.st);
      if (stream) return stream;
    } catch {
      // continue to next provider
    }
  }

  // Priority 4: HubCloud (hdhub or hubcloud)
  const hubId = play.hdhub || play.hubcloud || play.hubhd || play.hdcloud;
  if (hubId) {
    try {
      const stream = await extractHubCloud(hubId);
      if (stream) return stream;
    } catch {
      // continue
    }
  }

  return null;
}

module.exports = {
  loadLocalDataset,
  findMediaRecord,
  extractVidara,
  extractStreamTape,
  extractStreamHG,
  extractHubCloud,
  resolveTier1,
};
