const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listProviders, getProvider } = require('../providers/registry');
const { getVideogetterStreams } = require('../providers/videogetter');

test('videogetter is registered and enabled by default in registry', () => {
  const providers = listProviders();
  const vg = providers.find(p => p.name === 'videogetter');
  assert.ok(vg, 'videogetter should be registered in listProviders()');
  assert.equal(vg.enabled, true, 'videogetter should default to enabled');

  const p = getProvider('videogetter');
  assert.ok(p, 'getProvider("videogetter") should return provider object');
  assert.equal(p.name, 'videogetter');
  assert.equal(typeof p.fetch, 'function');
  assert.equal(p.enabled, true);
});

test('videogetter handles empty inputs and offline upstream gracefully', async () => {
  // Empty or invalid inputs
  const emptyRes = await getVideogetterStreams(null);
  assert.deepEqual(emptyRes, []);

  // When sidecar server is offline (unreachable port)
  process.env.VIDEOGETTER_API_BASE = 'http://127.0.0.1:59999';
  const offlineRes = await getVideogetterStreams(278, 'movie');
  assert.ok(Array.isArray(offlineRes));
  assert.equal(offlineRes.length, 0);
});

test('videogetter maps upstream mock server responses accurately', async () => {
  let requestedHeaders = null;
  let requestedUrl = null;

  const mockServer = http.createServer((req, res) => {
    requestedUrl = req.url;
    requestedHeaders = req.headers;

    if (req.url === '/api/movie/550') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tmdb_id: 550,
        type: 'movie',
        tier: 3,
        source: 'vidrift-atlas',
        title: 'Fight Club',
        direct: true,
        url: 'https://edge.reelvault.click/proxy?u=mock123',
        headers: {
          Origin: 'https://embed.vidrift.in',
          Referer: 'https://embed.vidrift.in/'
        }
      }));
      return;
    }

    if (req.url === '/api/tv/1399/1/1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        tmdb_id: 1399,
        type: 'tv',
        season: 1,
        episode: 1,
        source: 'streamtape',
        url: 'https://streamtape.com/get_video?id=xyz',
        headers: {
          Referer: 'https://streamtape.com/'
        },
        subtitles: [
          { url: 'https://example.com/en.vtt', lang: 'en' }
        ]
      }));
      return;
    }

    if (req.url === '/api/movie/404') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'source_not_found'
      }));
      return;
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  process.env.VIDEOGETTER_API_BASE = `http://127.0.0.1:${port}`;

  try {
    // 1. Movie test
    const movieStreams = await getVideogetterStreams(550, 'movie');
    assert.equal(movieStreams.length, 1);
    assert.equal(requestedUrl, '/api/movie/550');
    assert.equal(requestedHeaders['x-api-key'], 'lakshya9310081539@');
    assert.equal(requestedHeaders['origin'], 'https://api.kineflex.site');
    assert.equal(movieStreams[0].provider, 'videogetter');
    assert.equal(movieStreams[0].name, 'VideoGetter (vidrift-atlas)');
    assert.equal(movieStreams[0].url, 'https://edge.reelvault.click/proxy?u=mock123');
    assert.equal(movieStreams[0].headers.Referer, 'https://embed.vidrift.in/');

    // 2. TV series test
    const tvStreams = await getVideogetterStreams(1399, 'series', 1, 1);
    assert.equal(tvStreams.length, 1);
    assert.equal(requestedUrl, '/api/tv/1399/1/1');
    assert.equal(tvStreams[0].provider, 'videogetter');
    assert.equal(tvStreams[0].name, 'VideoGetter (streamtape)');
    assert.equal(tvStreams[0].url, 'https://streamtape.com/get_video?id=xyz');
    assert.equal(tvStreams[0].subtitles.length, 1);
    assert.equal(tvStreams[0].subtitles[0].lang, 'en');

    // 3. 404 response
    const notFoundStreams = await getVideogetterStreams(404, 'movie');
    assert.equal(notFoundStreams.length, 0);

  } finally {
    await new Promise(resolve => mockServer.close(resolve));
    delete process.env.VIDEOGETTER_API_BASE;
  }
});

test('videogetter resolves in-process when VIDEOGETTER_API_BASE is unset', async () => {
  delete process.env.VIDEOGETTER_API_BASE;

  const { findMediaRecord } = require('../providers/videogetter/tier1_vidara');
  const { resolveVideogetterInProcess } = require('../providers/videogetter/resolver');

  // Verify local dataset lookup
  const record = findMediaRecord(262838, 'tv', 1, 1);
  assert.ok(record, 'record 262838 S1E1 should be found in local vidara.json');
  assert.equal(record.title, "India's Got Latent");
  assert.ok(record.play);

  // In-process resolution executes without needing an external HTTP server
  assert.equal(typeof resolveVideogetterInProcess, 'function');
  const streams = await getVideogetterStreams('nonexistent_id_for_testing', 'movie');
  assert.ok(Array.isArray(streams));
});

