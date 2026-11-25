const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listProviders, getProvider } = require('../providers/registry');
const { getVidcoreStreams, parseResolverPayload } = require('../providers/vidcore');

test('vidcore is registered and enabled by default in registry', () => {
  const providers = listProviders();
  const vc = providers.find(p => p.name === 'vidcore');
  assert.ok(vc, 'vidcore should be registered in listProviders()');
  assert.equal(vc.enabled, true, 'vidcore should default to enabled');

  const p = getProvider('vidcore');
  assert.ok(p, 'getProvider("vidcore") should return provider object');
  assert.equal(p.name, 'vidcore');
  assert.equal(typeof p.fetch, 'function');
  assert.equal(p.enabled, true);
});

test('vidcore handles empty inputs and offline upstream gracefully', async () => {
  // Empty or invalid inputs
  const emptyRes = await getVidcoreStreams(null);
  assert.deepEqual(emptyRes, []);

  // When sidecar server is offline (unreachable port)
  process.env.VIDCORE_RESOLVER_BASE = 'http://127.0.0.1:59998';
  const offlineRes = await getVidcoreStreams(969681, 'movie');
  assert.ok(Array.isArray(offlineRes));
  assert.equal(offlineRes.length, 0);
});

test('parseResolverPayload parses both JSON objects, arrays, and NDJSON events', () => {
  // 1. JSON with streams array
  const jsonPayload = {
    ok: true,
    streams: [
      {
        server: 'Orbit',
        url: 'https://cdn.goldenkite.top/stream.m3u8',
        quality: 'Auto',
        headers: { Referer: 'https://vidcore.io/' }
      }
    ]
  };
  const parsedJson = parseResolverPayload(jsonPayload);
  assert.equal(parsedJson.length, 1);
  assert.equal(parsedJson[0].server, 'Orbit');

  // 2. NDJSON stream from /api/resolve
  const ndjsonText = `
{"event":"server","server":{"name":"Orbit","status":"loading"}}
{"event":"meta","title":"Fight Club","year":1999}
{"event":"server","server":{"name":"Orbit","status":"ok","ms":250,"url":"https://cdn.goldenkite.top/master.m3u8","play":"http://localhost:8789/api/hls/Orbit/123","referer":true,"refererUrl":"https://vidcore.io/","userAgent":"CustomUA"}}
`;
  const parsedNdjson = parseResolverPayload(ndjsonText);
  assert.equal(parsedNdjson.length, 1);
  assert.equal(parsedNdjson[0].name, 'Orbit');
  assert.equal(parsedNdjson[0].url, 'https://cdn.goldenkite.top/master.m3u8');
  assert.equal(parsedNdjson[0].play, 'http://localhost:8789/api/hls/Orbit/123');
  assert.equal(parsedNdjson[0].headers.Referer, 'https://vidcore.io/');
  assert.equal(parsedNdjson[0].headers['User-Agent'], 'CustomUA');
});

test('vidcore maps upstream mock server responses with header propagation', async () => {
  let requestedUrl = null;

  const mockServer = http.createServer((req, res) => {
    requestedUrl = req.url;

    if (req.url === '/movie/969681') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        streams: [
          {
            server: 'Orbit',
            name: 'Orbit',
            url: 'https://cdn.goldenkite.top/master.m3u8?s=s1.1700000000',
            quality: 'Auto',
            headers: {
              'User-Agent': 'Mozilla/5.0 Test',
              'Referer': 'https://vidcore.io/',
              'Origin': 'https://vidcore.io'
            },
            subtitles: [
              { url: 'https://vidcore.io/sub/en.vtt', lang: 'en' }
            ]
          }
        ]
      }));
      return;
    }

    if (req.url === '/tv/1399/1/1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        streams: [
          {
            server: 'Supreme',
            name: 'Supreme',
            url: 'https://moon.goldenkite.top/vd/abc/master.m3u8',
            quality: 'Auto',
            headers: {
              'Referer': 'https://vidcore.io/',
              'Origin': 'https://vidcore.io'
            }
          }
        ]
      }));
      return;
    }

    // Fallback NDJSON test
    if (req.url?.startsWith('/api/resolve')) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end('{"event":"server","server":{"name":"Orbit","status":"ok","url":"https://cdn.goldenkite.top/ndjson.m3u8","refererUrl":"https://vidcore.io/"}}\n');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  process.env.VIDCORE_RESOLVER_BASE = `http://127.0.0.1:${port}`;

  try {
    // 1. Movie test
    const movieStreams = await getVidcoreStreams(969681, 'movie');
    assert.equal(movieStreams.length, 1);
    assert.equal(requestedUrl, '/movie/969681');
    assert.equal(movieStreams[0].provider, 'vidcore');
    assert.equal(movieStreams[0].name, 'VidCore (Orbit)');
    assert.equal(movieStreams[0].url, 'https://cdn.goldenkite.top/master.m3u8?s=s1.1700000000');
    assert.equal(movieStreams[0].headers.Referer, 'https://vidcore.io/');
    assert.equal(movieStreams[0].headers.Origin, 'https://vidcore.io');
    assert.equal(movieStreams[0].subtitles.length, 1);
    assert.equal(movieStreams[0].subtitles[0].lang, 'en');

    // 2. TV series test
    const tvStreams = await getVidcoreStreams(1399, 'series', 1, 1);
    assert.equal(tvStreams.length, 1);
    assert.equal(requestedUrl, '/tv/1399/1/1');
    assert.equal(tvStreams[0].provider, 'vidcore');
    assert.equal(tvStreams[0].name, 'VidCore (Supreme)');
    assert.equal(tvStreams[0].url, 'https://moon.goldenkite.top/vd/abc/master.m3u8');
    assert.equal(tvStreams[0].headers.Referer, 'https://vidcore.io/');

    // 3. 404 response
    const notFoundStreams = await getVidcoreStreams(404, 'movie');
    assert.equal(notFoundStreams.length, 0);

  } finally {
    await new Promise(resolve => mockServer.close(resolve));
    delete process.env.VIDCORE_RESOLVER_BASE;
  }
});

test('vidcore resolves in-process when VIDCORE_RESOLVER_BASE is unset', async () => {
  delete process.env.VIDCORE_RESOLVER_BASE;
  const { resolveVidcoreInProcess } = require('../providers/vidcore/resolver');
  assert.equal(typeof resolveVidcoreInProcess, 'function');

  // getVidcoreStreams calls resolveVidcoreInProcess when VIDCORE_RESOLVER_BASE is not set
  const streams = await getVidcoreStreams('invalid_tmdb_id_for_testing', 'movie');
  assert.ok(Array.isArray(streams));
});

