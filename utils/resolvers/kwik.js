const axios = require('axios');
const JsUnpacker = require('../jsunpack');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Unpacks packed JavaScript using Dean Edwards packer format.
 * Uses JsUnpacker utility or fallback regex evaluation.
 * @param {string} code
 * @returns {string} Unpacked code or original code if unpack failed
 */
function unpack(code) {
  if (!code || typeof code !== 'string') return '';
  try {
    const unpacker = new JsUnpacker(code);
    if (unpacker.detect()) {
      const unpacked = unpacker.unpack();
      if (unpacked) return unpacked;
    }
  } catch {
    // Fallback below
  }

  try {
    const match = code.match(
      /}\((['"])([\s\S]*?)\1,\s*(\d+),\s*(\d+),\s*(['"])([\s\S]*?)\5\.split\((['"])\|\7\)/
    );
    if (match) {
      let [, , p] = match;
      const [, , , aStr, cStr, , kStr] = match;
      p = p.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const a = parseInt(aStr, 10);
      let c = parseInt(cStr, 10);
      const k = kStr.split('|');
      const e = (c2) =>
        (c2 < a ? '' : e(parseInt(c2 / a, 10))) +
        ((c2 = c2 % a) > 35 ? String.fromCharCode(c2 + 29) : c2.toString(36));
      const d = {};
      while (c--) {
        const key = e(c);
        d[key] = k[c] || key;
      }
      return p.replace(/\b\w+\b/g, (w) => (d[w] !== undefined ? d[w] : w));
    }
  } catch (err) {
    console.error('[KwikResolver] Unpack regex fallback failed:', err.message);
  }
  return code;
}

/**
 * Extracts streaming links (m3u8, mp4) from a Kwik player embed URL.
 * @param {string} url Kwik embed URL (e.g. https://kwik.cx/e/...)
 * @param {object} options
 * @returns {Promise<{m3u8?: string, mp4?: string, headers: object}|null>}
 */
async function extractKwik(url, options = {}) {
  if (!url || typeof url !== 'string') return null;

  try {
    const referer = options.referer || 'https://animepahe.ru/';
    const userAgent = options.userAgent || DEFAULT_UA;
    const timeout = Number(options.timeout) || 10000;

    let html = '';
    if (typeof options.fetcher === 'function') {
      html = await options.fetcher(url, { headers: { Referer: referer, 'User-Agent': userAgent } });
    } else {
      const res = await axios.get(url, {
        headers: {
          Referer: referer,
          'User-Agent': userAgent
        },
        timeout,
        validateStatus: () => true
      });
      html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    }

    if (!html) return null;

    // Search for packed scripts
    const scripts = html.match(/<script.*?>([\s\S]*?)<\/script>/gi) || [];
    const matches = [];

    for (const script of scripts) {
      if (script.includes('eval(function(p,a,c,k,e,d)') || script.includes('eval(function(p,a,c,k,e,r)')) {
        let pos = 0;
        while (pos < script.length) {
          const idxD = script.indexOf('eval(function(p,a,c,k,e,d)', pos);
          const idxR = script.indexOf('eval(function(p,a,c,k,e,r)', pos);
          let start = -1;
          if (idxD !== -1 && idxR !== -1) start = Math.min(idxD, idxR);
          else if (idxD !== -1) start = idxD;
          else if (idxR !== -1) start = idxR;

          if (start === -1) break;
          const end = script.indexOf(".split('|')", start);
          if (end === -1) break;
          const closeParen = script.indexOf('))', end);
          if (closeParen === -1) break;

          matches.push(script.substring(start, closeParen + 2));
          pos = closeParen + 2;
        }
      }
    }

    // Direct match if entire html is script or passed script directly
    if (matches.length === 0 && (html.includes('eval(function(p,a,c,k,e,d)') || html.includes('eval(function(p,a,c,k,e,r)'))) {
      matches.push(html);
    }

    for (const scriptContent of matches) {
      const unpacked = unpack(scriptContent);
      const m3u8Match =
        unpacked.match(/source\s*=\s*'([^']+m3u8[^']*)'/) ||
        unpacked.match(/source\s*=\s*"([^"]+m3u8[^"]*)"/) ||
        unpacked.match(/(https?:\/\/[^\s'"\\]+\.m3u8[^\s'"\\]*)/);

      if (m3u8Match) {
        const m3u8Url = m3u8Match[1];
        const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : 'video';
        const fileName = title.endsWith('.mp4') ? title : `${title}.mp4`;

        let mp4Url = null;
        if (m3u8Url.includes('/stream/')) {
          const urlParts = m3u8Url.replace('/stream/', '/mp4/').split('/');
          urlParts.pop();
          const mp4Base = urlParts.join('/');
          mp4Url = `${mp4Base}?file=${encodeURIComponent(fileName)}`;
        }

        return {
          m3u8: m3u8Url,
          mp4: mp4Url,
          headers: {
            Referer: 'https://kwik.cx/',
            Origin: 'https://kwik.cx',
            'User-Agent': userAgent
          }
        };
      }
    }
  } catch (err) {
    console.error('[KwikResolver] Kwik extraction error:', err.message);
  }

  return null;
}

/**
 * Decrypts Pahe string encoding.
 * @param {string} fullString
 * @param {string} key
 * @param {number} v1
 * @param {number} v2
 * @returns {string}
 */
function paheDecrypt(fullString, key, v1, v2) {
  const keyIndexMap = {};
  for (let i = 0; i < key.length; i++) {
    keyIndexMap[key[i]] = i;
  }
  let result = '';
  let i = 0;
  const toFind = key[v2];
  while (i < fullString.length) {
    const nextIndex = fullString.indexOf(toFind, i);
    if (nextIndex === -1) break;
    let decodedCharStr = '';
    for (let j = i; j < nextIndex; j++) {
      decodedCharStr += keyIndexMap[fullString[j]];
    }
    i = nextIndex + 1;
    const decodedChar = String.fromCharCode(parseInt(decodedCharStr, v2) - v1);
    result += decodedChar;
  }
  return result;
}

/**
 * Resolves a Pahe intermediate download link (pahe.win / pahe.li) to the final file stream.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<{url: string, headers: object}|null>}
 */
async function extractPahe(url, options = {}) {
  if (!url || typeof url !== 'string') return null;

  try {
    const userAgent = options.userAgent || DEFAULT_UA;
    const timeout = Number(options.timeout) || 10000;
    const initUrl = url.endsWith('/i') ? url : `${url}/i`;

    if (typeof options.fetcher === 'function') {
      const mockResult = await options.fetcher(initUrl, { isPahe: true });
      if (mockResult && mockResult.url) {
        return {
          url: mockResult.url,
          headers: {
            Referer: 'https://kwik.cx/',
            'User-Agent': userAgent
          }
        };
      }
    }

    const initRes = await axios.get(initUrl, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': userAgent,
        Referer: 'https://pahe.win/'
      },
      timeout
    });

    const redirectLoc = initRes.headers.location || initRes.headers.Location;
    if (!redirectLoc) return null;

    const kwikUrl = redirectLoc.startsWith('http')
      ? redirectLoc
      : `https://${redirectLoc.replace(/^\/+/, '')}`;

    const kwikRes = await axios.get(kwikUrl, {
      headers: {
        'User-Agent': userAgent,
        Referer: 'https://kwik.cx/'
      },
      timeout
    });

    const html = typeof kwikRes.data === 'string' ? kwikRes.data : JSON.stringify(kwikRes.data);
    const setCookieHeader = kwikRes.headers['set-cookie'];
    let cookie = '';
    if (Array.isArray(setCookieHeader) && setCookieHeader.length > 0) {
      cookie = setCookieHeader[0].split(';')[0];
    } else if (typeof setCookieHeader === 'string') {
      cookie = setCookieHeader.split(';')[0];
    }

    const kwikParamsRegex = /\("(\w+)",\d+,"(\w+)",(\d+),(\d+),\d+\)/;
    const match = html.match(kwikParamsRegex);
    if (!match) return null;

    const [, fullString, key, v1, v2] = match;
    const decrypted = paheDecrypt(fullString, key, parseInt(v1, 10), parseInt(v2, 10));
    const actionMatch = decrypted.match(/action="([^"]+)"/);
    const tokenMatch = decrypted.match(/value="([^"]+)"/);
    if (!actionMatch || !tokenMatch) return null;

    const postUri = actionMatch[1];
    const token = tokenMatch[1];

    const formData = new URLSearchParams();
    formData.append('_token', token);

    const postRes = await axios.post(postUri, formData.toString(), {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': userAgent,
        Referer: kwikUrl,
        ...(cookie ? { Cookie: cookie } : {}),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout
    });

    const finalLocation = postRes.headers.location || postRes.headers.Location;
    if (finalLocation) {
      return {
        url: finalLocation,
        headers: {
          Referer: 'https://kwik.cx/',
          'User-Agent': userAgent
        }
      };
    }
  } catch (err) {
    console.error('[KwikResolver] Pahe extraction error:', err.message);
  }

  return null;
}

module.exports = {
  unpack,
  extractKwik,
  paheDecrypt,
  extractPahe
};
