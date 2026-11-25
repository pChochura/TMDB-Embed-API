const vm = require('node:vm');
const { siteOrigin, userAgent } = require('./config');
const {
  extractHexSeed,
  extractXorTableConsts,
  scanAhSealMaterial,
  scanAzDecryptMaterial,
  setCatalogDecryptMaterial,
  setSealMaterial,
} = require('./crypto');

const scraperHeaders = {
  'user-agent': userAgent,
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

function absoluteUrl(input) {
  return typeof input === 'string' && input.startsWith('/') ? `${siteOrigin}${input}` : input;
}

function mergeHeaders(referer, initHeaders, jar) {
  const headers = new Headers(scraperHeaders);
  headers.set('referer', referer);
  headers.set('origin', siteOrigin);
  if (jar) {
    const cookies = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    if (cookies) headers.set('cookie', cookies);
  }
  if (initHeaders) {
    new Headers(initHeaders).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function parseSetCookie(header, jar) {
  if (!header) return;
  for (const part of header.split(/,(?=\s*[^;,]+=[^;,]+)/)) {
    const segment = part.split(';')[0].trim();
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    jar.set(segment.slice(0, eq), segment.slice(eq + 1));
  }
}

function storeCookies(response, jar) {
  parseSetCookie(
    response.headers.getSetCookie?.()?.join(',') ?? response.headers.get('set-cookie'),
    jar,
  );
}

function collectCookies(response, jar = new Map()) {
  storeCookies(response, jar);
  return jar;
}

function createScraperFetch(referer, jar) {
  return async (input, init = {}) => {
    const headers = mergeHeaders(referer, init.headers, jar);
    headers.set('accept', headers.get('accept') || '*/*');
    headers.set('x-requested-with', 'XMLHttpRequest');
    const response = await fetch(absoluteUrl(input), {
      ...init,
      method: init.method || 'POST',
      headers,
      body: init.body,
    });
    storeCookies(response, jar);
    return response;
  };
}

const EN_PATTERN = /\\"en\\":\\"([^\\"]+)\\"/;
const PROPS_PATTERN = /\\"en\\":\\"[^\\"]+\\"(.+?\\"server\\":\\"[^\\"]*\\"})/;

function parseNextPropsObject(raw) {
  const normalized = raw.replace(/\\"/g, '"').replace(/"\\\$undefined"/g, 'null');
  const json = normalized.startsWith('{') ? normalized : `{${normalized}`;
  return JSON.parse(json);
}

function extractEmbedProps(html) {
  const match = html.match(PROPS_PATTERN);
  if (!match?.[0]) {
    const en = html.match(EN_PATTERN)?.[1];
    if (!en) throw new Error('en token not found in page payload');
    return { en };
  }
  return parseNextPropsObject(match[0]);
}

function embedPath(kind, id, { season, episode } = {}) {
  return kind === 'tv' ? `/tv/${id}/${season}/${episode}` : `/movie/${id}`;
}

async function scrapeEmbedPage(kind, id, options = {}) {
  const path = embedPath(kind, id, options);
  const jar = new Map();
  const response = await fetch(`${siteOrigin}${path}`, {
    headers: { ...scraperHeaders, accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) throw new Error(`page fetch failed: ${response.status} ${response.statusText}`);
  collectCookies(response, jar);
  const html = await response.text();
  const props = extractEmbedProps(html);
  return {
    en: props.en,
    meta: { title: props.title, year: props.year },
    referer: `${siteOrigin}${path}`,
    jar,
    html,
  };
}

let cachedPlayerMaterial = null;
let cachedAt = 0;
const TTL_MS = 300_000;

function extractFn(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`missing ${startMarker}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${startMarker}`);
}

function loadSandbox(chunk) {
  const aT = extractFn(chunk, 'function aT()');
  const aQ = extractFn(chunk, 'function aQ(');
  const c6 = extractFn(chunk, 'function c6(');
  const shuffleStart = chunk.indexOf('!function(t,e){let o=c6,W=c6,n=c6,r=aQ');
  if (shuffleStart < 0) throw new Error('missing aT shuffle');
  const shuffleEnd = chunk.indexOf('}(aT,', shuffleStart);
  if (shuffleEnd < 0) throw new Error('unterminated aT shuffle');
  const shuffleClose = chunk.indexOf(')', shuffleEnd + 5);
  const shuffle = chunk.slice(shuffleStart, shuffleClose + 2);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext([aT, c6, aQ, 'globalThis.aT=aT;globalThis.c6=c6;globalThis.aQ=aQ;', shuffle].join('\n'), sandbox);
  return sandbox;
}

function decodeXor(src, enc, x) {
  const b = Buffer.from(src, enc);
  for (let i = 0; i < b.length; i++) b[i] ^= x;
  return b;
}

function shiftMinus4(s) {
  return [...s].map((ch) => String.fromCharCode(ch.charCodeAt(0) - 4)).join('');
}

function parseCall(expr) {
  const m = expr.match(/([a-zA-Z_$][\w$]*)\((\d+)(?:,\s*"([^"]*)")?\)/);
  if (!m) throw new Error('bad call ' + expr);
  return { fn: m[1], n: Number(m[2]), salt: m[3] };
}

function resolveString(sb, call) {
  const { fn, n, salt } = parseCall(call);
  if (fn.startsWith('c') && fn.length <= 2 && salt !== undefined) return sb.c6(n, salt);
  return sb.aQ(n);
}

function buildAz(sb, chunk) {
  const aJDef = chunk.match(/var aJ=([a-zA-Z_$][\w$]*)\((\d+),"([^"]+)"\)/);
  const aRDef = chunk.match(/var aR=([a-zA-Z_$][\w$]*)\((\d+)\)/);
  const aP = chunk.match(/var aP=function\(t,e\)\{[^}]*\^=(\d+);return o\}\(([a-zA-Z_$][\w$]*\(\d+,"[^"]*"\))/);
  const ap = chunk.match(/var ap=function\(t,e\)\{[^}]*\^=(\d+);return o\}\(([a-zA-Z_$][\w$]*\(\d+,"[^"]*"\))/);
  const ax = chunk.match(/var ax=cV\[[^\]]+\]\(([a-zA-Z_$][\w$]*\(\d+\)),/);
  if (!aJDef || !aRDef || !aP || !ap || !ax) throw new Error('aZ blob recipes missing');
  const aJ = shiftMinus4(sb.c6(Number(aJDef[2]), aJDef[3]));
  const aR = shiftMinus4(sb.aQ(Number(aRDef[2])));
  return Buffer.concat([
    Buffer.from(resolveString(sb, ax[1]), aR),
    decodeXor(resolveString(sb, ap[2]), aJ, Number(ap[1])),
    decodeXor(resolveString(sb, aP[2]), aJ, Number(aP[1])),
  ]);
}

function buildAh(sb, chunk) {
  const ar = chunk.match(/var ar=cV\[[^\]]+\]\(([a-zA-Z_$][\w$]*\(\d+\)),/);
  const an = chunk.match(/var an=function\(t,e\)\{[^}]*\^=(\d+);return o\}\(([a-zA-Z_$][\w$]*\(\d+,"[^"]*"\))/);
  const am = chunk.match(/var am=function\(t,e\)\{[^}]*\^=(\d+);return o\}\(([a-zA-Z_$][\w$]*\(\d+\))/);
  const al = chunk.match(/var al=function\(t,e\)\{[^}]*\^=(\d+);return o\}\(([a-zA-Z_$][\w$]*\(\d+\))/);
  const aa = chunk.match(/var aa=cV\[[^\]]+\]\(([a-zA-Z_$][\w$]*\(\d+,"[^"]*"\)),/);
  const aRDef = chunk.match(/var aR=([a-zA-Z_$][\w$]*)\((\d+)\)/);
  const acStart = chunk.indexOf('var ac=new Uint8Array([');
  if (!ar || !an || !am || !al || !aa || !aRDef || acStart < 0) throw new Error('ah blob recipes missing');
  const acEnd = chunk.indexOf(']);', acStart);
  if (acEnd < 0) throw new Error('unterminated ac');
  const ac = Buffer.from(
    JSON.parse('[' + chunk.slice(acStart + 'var ac=new Uint8Array(['.length, acEnd) + ']')
  );
  const aaEnc = shiftMinus4(sb.aQ(Number(aRDef[2])));
  return Buffer.concat([
    Buffer.from(resolveString(sb, ar[1]), 'base64'),
    ac,
    decodeXor(resolveString(sb, al[2]), 'base64', Number(al[1])),
    decodeXor(resolveString(sb, an[2]), 'base64', Number(an[1])),
    decodeXor(resolveString(sb, am[2]), 'base64', Number(am[1])),
    Buffer.from(resolveString(sb, aa[1]), aaEnc),
  ]);
}

function mintRoutes(sb, chunk, listAction) {
  const fetchAt = chunk.indexOf('fetch(""');
  if (fetchAt < 0) throw new Error('catalog fetch missing');
  const fetchCtx = chunk.slice(fetchAt, fetchAt + 320);
  const baseCall = fetchCtx.match(/([a-zA-Z_$][\w$]*\(\d+,\s*"[^"]*"\))/);
  const streamCall = fetchCtx.match(/"\/"\)\[[^\]]+\]\(([a-zA-Z_$][\w$]*\(\d+\))/);
  const methodCall = fetchCtx.match(/method:([a-zA-Z_$][\w$]*\(\d+,\s*"[^"]*"\))/);
  const headersMatch = fetchCtx.match(
    /JSON\[[^\]]+\]\(([a-zA-Z_$][\w$]*)\((\d+),([a-zA-Z_$][\w$]*)\)\)/,
  );
  if (!baseCall || !streamCall || !methodCall || !headersMatch) throw new Error('catalog route calls missing');
  const saltAt = chunk.lastIndexOf(`${headersMatch[3]}="`, fetchAt);
  if (saltAt < 0) throw new Error('catalog headers salt missing');
  const saltLit = chunk.slice(saltAt).match(/^[a-zA-Z_$][\w$]*="([^"]*)"/);
  if (!saltLit) throw new Error('catalog headers salt missing');
  const base = resolveString(sb, baseCall[1]);
  const streamAction = resolveString(sb, streamCall[1]);
  const method = resolveString(sb, methodCall[1]);
  const headersJson = resolveString(sb, `${headersMatch[1]}(${headersMatch[2]},"${saltLit[1]}")`);
  if (!base.startsWith('/') || !base.includes('/se')) throw new Error('bad catalog base from player');
  if (!listAction || !streamAction) throw new Error('bad catalog actions');
  if (!method) throw new Error('bad catalog method');
  return {
    base,
    listAction,
    streamAction,
    method,
    headers: JSON.parse(headersJson),
  };
}

function candidateChunkPaths(html) {
  const paths = [
    ...html.matchAll(/\/_next\/static\/chunks\/\d+-[a-f0-9]+\.js/g),
  ].map((m) => m[0]);
  return [...new Set(paths)];
}

function isPlayerChunk(src) {
  return src.includes('function aT()') && src.includes("cQ=JSON.parse('");
}

async function fetchPlayerChunk(html) {
  const paths = candidateChunkPaths(html);
  if (!paths.length) throw new Error('player chunk candidates missing');
  const ctrl = new AbortController();
  try {
    return await Promise.any(
      paths.map(async (path) => {
        const url = `${siteOrigin}${path}`;
        const res = await fetch(url, {
          headers: { ...scraperHeaders, accept: '*/*' },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('chunk status');
        const text = await res.text();
        if (!isPlayerChunk(text)) throw new Error('not player');
        ctrl.abort();
        return { url, text };
      }),
    );
  } catch {
    throw new Error('player chunk not found');
  }
}

async function loadPlayerMaterial(opts) {
  if (cachedPlayerMaterial && Date.now() - cachedAt < TTL_MS) return cachedPlayerMaterial;
  if (!opts.html) throw new Error('embed html required for player material');

  const { url: chunkUrl, text: chunk } = await fetchPlayerChunk(opts.html);
  const sb = loadSandbox(chunk);
  const xor = extractXorTableConsts(chunk);
  const ahSeed = extractHexSeed(chunk, 'ah');
  const azSeed = extractHexSeed(chunk, 'aZ');
  const ah = buildAh(sb, chunk);
  const decrypt = scanAzDecryptMaterial(buildAz(sb, chunk), azSeed, xor);
  const seal = scanAhSealMaterial(ah, ahSeed, chunk, xor);
  const routes = mintRoutes(sb, chunk, seal.listAction);

  setCatalogDecryptMaterial(decrypt);
  setSealMaterial(seal);

  cachedPlayerMaterial = { routes, decrypt, seal, chunkUrl };
  cachedAt = Date.now();
  return cachedPlayerMaterial;
}

module.exports = {
  scraperHeaders,
  absoluteUrl,
  mergeHeaders,
  collectCookies,
  createScraperFetch,
  scrapeEmbedPage,
  loadPlayerMaterial,
};
