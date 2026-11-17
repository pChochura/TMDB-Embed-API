const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { extractPlayerStreams, watchUrl, isStreamResponse } = require('../utils/browserStreams');

const seriesPath = (id, season, episode) => `/watch/tv/${id}/${season}/${episode}`;
const options = { baseUrl: 'https://example.test', tmdbId: '123', seriesPath };

test('builds movie and series URLs and rejects invalid inputs', () => {
  assert.equal(watchUrl({ ...options, mediaType: 'movie' }), 'https://example.test/watch/movie/123');
  assert.equal(watchUrl({ ...options, mediaType: 'tv', season: 0, episode: 2 }), 'https://example.test/watch/tv/123/0/2');
  assert.throws(() => watchUrl({ ...options, tmdbId: '../1', mediaType: 'movie' }), /TMDB ID/);
  assert.throws(() => watchUrl({ ...options, mediaType: 'tv', season: 1 }), /season and positive episode/);
  assert.throws(() => watchUrl({ ...options, mediaType: 'series' }), /media type/);
});

test('only accepts successful HTTP media responses', () => {
  const response = (url, status) => ({ url: () => url, status: () => status });
  assert.equal(isStreamResponse(response('https://example.test/path/master.m3u8?token=1', 200)), true);
  assert.equal(isStreamResponse(response('https://example.test/video.mp4', 206)), true);
  assert.equal(isStreamResponse(response('https://example.test/video.mp4', 403)), false);
  assert.equal(isStreamResponse(response('https://example.test/video.mp4.js', 200)), false);
});

test('extracts a successful stream and playback headers from a browser page', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/watch/movie/123') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>fetch("/denied.mp4"); fetch("/master.m3u8?token=example");</script>');
    } else if (req.url === '/master.m3u8?token=example') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n');
    } else {
      res.writeHead(403);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const streams = await extractPlayerStreams({ ...options, baseUrl, mediaType: 'movie', provider: 'Test' });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, `${baseUrl}/master.m3u8?token=example`);
    assert.equal(streams[0].provider, 'Test');
    assert.equal(streams[0].quality, 'Auto');
    assert.equal(streams[0].headers.Referer, `${baseUrl}/watch/movie/123`);
    assert.match(streams[0].headers['User-Agent'], /Chrome/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('registry exposes both provider names', () => {
  const { getProvider } = require('../providers/registry');
  assert.equal(getProvider('cinezo').name, 'cinezo');
  assert.equal(getProvider('hexa').name, 'hexa');
});

test('registry forwards movie and TV requests to the correct watch pages', async () => {
  const helper = require('../utils/browserStreams');
  const original = helper.extractPlayerStreams;
  const urls = [];
  helper.extractPlayerStreams = async options => {
    urls.push(watchUrl(options));
    return [{ url: 'https://example.test/stream.m3u8' }];
  };
  try {
    const { getProvider } = require('../providers/registry');
    for (const name of ['cinezo', 'hexa']) {
      const provider = getProvider(name);
      const movie = await provider.fetch({ tmdbId: '123', type: 'movie' });
      assert.equal(movie[0].provider, name);
      await provider.fetch({ tmdbId: '123', type: 'series', season: 0, episode: 2 });
    }
    assert.deepEqual(urls, [
      'https://www.cinezo.st/watch/movie/123',
      'https://www.cinezo.st/watch/tv/123?season=0&episode=2',
      'https://hexa.su/watch/movie/123',
      'https://hexa.su/watch/tv/123/0/2'
    ]);
  } finally {
    helper.extractPlayerStreams = original;
  }
});
