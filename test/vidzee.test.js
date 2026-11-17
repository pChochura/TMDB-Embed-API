const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listProviders, getProvider } = require('../providers/registry');
const {
  getVidzeeStreams,
  buildStreamUrl,
  normalizeVidzeeStream,
  STREAM_REFERER
} = require('../providers/vidzee');
const {
  isFfmpegAvailable,
  firstPlaylistEntry,
  looksLikeImage
} = require('../utils/remux');

test('registry loading includes vidzee provider with correct defaults', () => {
  const providers = listProviders();
  const providerNames = providers.map(p => p.name);

  assert.ok(providerNames.includes('vidzee'), 'vidzee should be listed in providers');
  const vidzee = getProvider('vidzee');
  assert.ok(vidzee, 'getProvider("vidzee") should return provider object');
  assert.equal(vidzee.name, 'vidzee');
  assert.equal(typeof vidzee.fetch, 'function');
  assert.equal(vidzee.enabled, true, 'vidzee should default to enabled: true');
});

test('vidzee buildStreamUrl constructs expected endpoints for movies and series', () => {
  const movieUrl = buildStreamUrl({
    tmdbId: '550',
    type: 'movie',
    sr: 'dcloud'
  });
  assert.equal(movieUrl, 'https://core.vidzee.wtf/streams/movie/550?s=dcloud&e=0');

  const tvUrl = buildStreamUrl({
    tmdbId: '1399',
    type: 'tv',
    season: 2,
    episode: 5,
    sr: 'v6:Hindi'
  });
  assert.equal(tvUrl, 'https://core.vidzee.wtf/streams/tv/1399/2/5?s=v6%3AHindi&e=0');
});

test('vidzee normalizeVidzeeStream maps valid streams and ignores encrypted/invalid payloads', () => {
  // Valid payload
  const validData = {
    url: 'https://cdn.example.com/playlist.m3u8',
    language: 'English',
    headers: { 'X-Custom-Header': 'val' }
  };
  const streams = normalizeVidzeeStream(validData, 'dcloud');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, 'VidZee dcloud - 720p - English');
  assert.equal(streams[0].title, 'VidZee dcloud - 720p - English');
  assert.equal(streams[0].url, 'https://cdn.example.com/playlist.m3u8');
  assert.equal(streams[0].quality, '720p');
  assert.equal(streams[0].provider, 'VidZee');
  assert.equal(streams[0].headers.Referer, STREAM_REFERER);
  assert.equal(streams[0].headers['X-Custom-Header'], 'val');

  // Encrypted blob without plaintext url should be safely rejected
  const encryptedBlob = { c: 'obfuscatedCiphertextBlob==' };
  const emptyStreams = normalizeVidzeeStream(encryptedBlob, 'tik');
  assert.deepEqual(emptyStreams, []);

  // Invalid / non-HTTP url should be safely rejected
  const invalidUrl = { url: 'ftp://invalid-url.com' };
  assert.deepEqual(normalizeVidzeeStream(invalidUrl, 'ipcloud'), []);
});

test('vidzee input validation rejects missing tmdbId, invalid types, or incomplete series params', async () => {
  assert.deepEqual(await getVidzeeStreams(null, 'movie'), []);
  assert.deepEqual(await getVidzeeStreams('', 'movie'), []);
  assert.deepEqual(await getVidzeeStreams('550', 'invalidType'), []);
  assert.deepEqual(await getVidzeeStreams('1399', 'tv', null, 1), []);
  assert.deepEqual(await getVidzeeStreams('1399', 'tv', 1, null), []);
});

test('vidzee getVidzeeStreams handles mock server responses and network failures gracefully', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.includes('s=dcloud')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        url: 'https://cdn.example.com/movie-dcloud.m3u8',
        language: 'English'
      }));
    } else if (req.url.includes('s=tik')) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server down' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockApiBase = `http://127.0.0.1:${port}`;

  try {
    const streams = await getVidzeeStreams('550', 'movie', null, null, {
      apiBase: mockApiBase,
      servers: ['dcloud', 'tik', 'nonexistent']
    });

    assert.equal(streams.length, 1);
    assert.equal(streams[0].provider, 'VidZee');
    assert.equal(streams[0].url, 'https://cdn.example.com/movie-dcloud.m3u8');
    assert.equal(streams[0].quality, '720p');
    assert.equal(streams[0].headers.Referer, STREAM_REFERER);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('remux utility checks ffmpeg presence, m3u8 entry parsing, and image header sniffing', () => {
  const isAvailable = isFfmpegAvailable();
  assert.equal(typeof isAvailable, 'boolean');

  // m3u8 playlist entry parsing
  const m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nsegment001.ts\n`;
  const firstEntry = firstPlaylistEntry(m3u8, 'https://cdn.example.com/path/playlist.m3u8');
  assert.equal(firstEntry, 'https://cdn.example.com/path/segment001.ts');

  // Image sniffing
  const pngHeader = Buffer.from('89504e470d0a1a0a000000', 'hex');
  assert.equal(looksLikeImage(pngHeader), true);

  const tsHeader = Buffer.from('47400010', 'hex'); // MPEG-TS sync byte 0x47
  assert.equal(looksLikeImage(tsHeader), false);
});
