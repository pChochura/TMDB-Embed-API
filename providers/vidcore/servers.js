const { siteReferer, userAgent } = require('./config');

const orbit = {
  name: 'Orbit',
  needsProxy: true,
  refererRequired: true,
  abrMaster: false,
  segmentType: 'video/mp2t',
};

const supreme = {
  name: 'Supreme',
  needsProxy: true,
  refererRequired: true,
  abrMaster: true,
};

const prime = {
  name: 'Prime',
  needsProxy: true,
  refererRequired: true,
  abrMaster: true,
};

const premiere = {
  name: 'Premiere 4K',
  needsProxy: false,
  refererRequired: false,
  abrMaster: false,
};

const horizon = {
  name: 'Horizon',
  needsProxy: false,
  refererRequired: false,
  abrMaster: false,
};

const SERVER_ORDER = [
  orbit.name,
  supreme.name,
  prime.name,
  premiere.name,
  horizon.name,
];

const servers = [orbit, supreme, prime, premiere, horizon];

function profileByName(name) {
  return servers.find((s) => s.name === name) || null;
}

function browserHeaders(extra = {}) {
  return {
    'User-Agent': userAgent,
    accept: '*/*',
    'accept-encoding': 'identity',
    Referer: siteReferer,
    ...extra,
  };
}

async function playlistText(url, headers = browserHeaders()) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`playlist ${res.status}`);
  return res.text();
}

function masterSibling(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(\/vd\/[^/]+)\//);
    if (!match) return null;
    parsed.pathname = `${match[1]}/master.m3u8`;
    return parsed.href;
  } catch {
    return null;
  }
}

async function ensureMasterForAbr(url, headers = browserHeaders()) {
  try {
    const text = await playlistText(url, headers);
    if (text.includes('#EXT-X-STREAM-INF:')) return url;

    const master = masterSibling(url);
    if (!master || master === url) return url;

    try {
      const masterText = await playlistText(master, headers);
      if (masterText.includes('#EXT-X-STREAM-INF:')) return master;
    } catch {
      return url;
    }
  } catch {
    return url;
  }
  return url;
}

module.exports = {
  SERVER_ORDER,
  servers,
  profileByName,
  ensureMasterForAbr,
};
