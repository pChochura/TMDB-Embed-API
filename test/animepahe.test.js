const test = require('node:test');
const assert = require('node:assert/strict');
const { listProviders, getProvider } = require('../providers/registry');
const {
  getAnimepaheStreams,
  extractQuality,
  cleanTitle,
  searchAnimePahe,
  getReleases,
  getPlayPageHtml
} = require('../providers/animepahe');
const {
  unpack,
  extractKwik,
  paheDecrypt,
  extractPahe
} = require('../utils/resolvers/kwik');

test('registry loading and provider list includes animepahe with correct defaults', () => {
  const providers = listProviders();
  const providerNames = providers.map((p) => p.name);

  assert.ok(providerNames.includes('animepahe'), 'animepahe should be listed in providers');

  const animepahe = getProvider('animepahe');
  assert.ok(animepahe, 'getProvider("animepahe") should return provider');
  assert.equal(animepahe.name, 'animepahe');
  assert.equal(typeof animepahe.fetch, 'function');
  assert.equal(animepahe.enabled, true, 'animepahe should default to enabled');
});

test('animepahe utility helpers format qualities and titles correctly', () => {
  assert.equal(extractQuality('1080p 34MB'), '1080p');
  assert.equal(extractQuality('720p 18MB'), '720p');
  assert.equal(extractQuality('480p'), '480p');
  assert.equal(extractQuality('360p'), '360p');
  assert.equal(extractQuality('4K UHD'), '4K');
  assert.equal(extractQuality(''), 'Auto');
  assert.equal(extractQuality(null), 'Auto');

  assert.equal(cleanTitle('Naruto: Shippuuden - Final!'), 'Naruto Shippuuden Final');
  assert.equal(cleanTitle('Attack on Titan (Shingeki no Kyojin)'), 'Attack on Titan (Shingeki no Kyojin)');
});

test('kwik resolver unpack and paheDecrypt decode obfuscated payloads accurately', async () => {
  // Test Dean Edwards packer unpacking
  const packedScript =
    'eval(function(p,a,c,k,e,r){return p}(\'const 0="1";\',2,2,\'source|https://kwik.cx/stream/test/playlist.m3u8\'.split(\'|\')))';
  const unpacked = unpack(packedScript);
  assert.match(unpacked, /const source="https:\/\/kwik\.cx\/stream\/test\/playlist\.m3u8";/);

  // Test paheDecrypt
  // Simple key and encoded string where decodedChar = parseInt(index, v2) - v1
  const key = '0123456789abcdef';
  const v1 = 0;
  const v2 = 10;
  // Character 'A' is ASCII 65 -> base 10 string '65' -> chars at key[6], key[5] = '6', '5' followed by separator key[10]='a'
  const fullString = '65a';
  const decrypted = paheDecrypt(fullString, key, v1, v2);
  assert.equal(decrypted, 'A');

  // Test extractPahe helper with mock fetcher
  const mockPaheResult = await extractPahe('https://pahe.win/dl123', {
    fetcher: async () => ({ url: 'https://final.cdn/video.mp4' })
  });
  assert.equal(mockPaheResult.url, 'https://final.cdn/video.mp4');
  assert.equal(mockPaheResult.headers.Referer, 'https://kwik.cx/');
});

test('kwik resolver extractKwik parses m3u8 playlist and generates mp4 fallback', async () => {
  const mockHtml = `
    <html>
      <head><title>Demon Slayer S01E01 1080p</title></head>
      <body>
        <script>
          eval(function(p,a,c,k,e,d){return p}('const 0="1";',2,2,'source|https://kwik.cx/stream/abc123xyz/playlist.m3u8'.split('|')))
        </script>
      </body>
    </html>
  `;

  const mockFetcher = async () => mockHtml;
  const result = await extractKwik('https://kwik.cx/e/sampleEmbed', {
    fetcher: mockFetcher
  });

  assert.ok(result);
  assert.equal(result.m3u8, 'https://kwik.cx/stream/abc123xyz/playlist.m3u8');
  assert.equal(
    result.mp4,
    'https://kwik.cx/mp4/abc123xyz?file=Demon%20Slayer%20S01E01%201080p.mp4'
  );
  assert.equal(result.headers.Referer, 'https://kwik.cx/');
  assert.equal(result.headers.Origin, 'https://kwik.cx');
});

test('animepahe search, releases, and play page helpers execute fetcher hooks', async () => {
  const mockFetcher = async (url) => {
    if (url.includes('m=search')) {
      return {
        data: [{ id: 101, title: 'Frieren: Beyond Journey\'s End', session: 'frieren-session-123' }]
      };
    }
    if (url.includes('m=release')) {
      return {
        total: 28,
        per_page: 30,
        data: [{ episode: 1, session: 'ep-session-1' }]
      };
    }
    if (url.includes('/play/')) {
      return '<html><div id="resolutionMenu"><button data-src="https://kwik.cx/e/123" data-resolution="1080p">1080p (jpn)</button></div></html>';
    }
    return null;
  };

  const searchResults = await searchAnimePahe('Frieren', { fetcher: mockFetcher });
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].session, 'frieren-session-123');

  const releases = await getReleases('frieren-session-123', 1, { fetcher: mockFetcher });
  assert.equal(releases.data.length, 1);
  assert.equal(releases.data[0].session, 'ep-session-1');

  const playHtml = await getPlayPageHtml('frieren-session-123', 'ep-session-1', { fetcher: mockFetcher });
  assert.ok(playHtml.includes('resolutionMenu'));
});

test('animepahe getAnimepaheStreams maps movie and TV series streams to unified schema', async () => {
  const mockFetcher = async (url, opts) => {
    if (opts?.isSearch) {
      return {
        data: [
          {
            id: 500,
            title: 'Spirited Away',
            session: 'spirited-away-session'
          }
        ]
      };
    }
    if (opts?.isRelease) {
      return {
        total: 1,
        per_page: 30,
        data: [{ episode: 1, session: 'ep-session-spirited' }]
      };
    }
    if (opts?.isPlay) {
      return `
        <html>
          <div id="resolutionMenu">
            <button data-src="https://kwik.cx/e/embed1080" data-resolution="1080p">1080p 120MB (eng)</button>
            <button data-src="https://kwik.cx/e/embed720" data-resolution="720p">720p 60MB (jpn)</button>
          </div>
          <div id="pickDownload">
            <a href="https://pahe.win/dl1080">1080p <span>eng</span></a>
          </div>
        </html>
      `;
    }
    if (url.includes('embed1080')) {
      return `
        <html>
          <head><title>Spirited Away 1080p</title></head>
          <body>
            <script>
              eval(function(p,a,c,k,e,d){return p}('const 0="1";',2,2,'source|https://kwik.cx/stream/sp1080/play.m3u8'.split('|')))
            </script>
          </body>
        </html>
      `;
    }
    if (url.includes('embed720')) {
      return `
        <html>
          <head><title>Spirited Away 720p</title></head>
          <body>
            <script>
              eval(function(p,a,c,k,e,d){return p}('const 0="1";',2,2,'source|https://kwik.cx/stream/sp720/play.m3u8'.split('|')))
            </script>
          </body>
        </html>
      `;
    }
    if (opts?.isPahe) {
      return {
        url: 'https://cdn.pahe.download/spirited-away-1080p.mp4'
      };
    }
    return '';
  };

  const streams = await getAnimepaheStreams('129', 'movie', null, null, {
    title: 'Spirited Away',
    fetcher: mockFetcher
  });

  assert.ok(Array.isArray(streams));
  assert.ok(streams.length >= 3, 'Should resolve HLS, MP4 and Direct streams');

  // Verify stream schema
  for (const s of streams) {
    assert.equal(s.provider, 'animepahe');
    assert.ok(s.name.startsWith('AnimePahe ['));
    assert.ok(s.title.includes('Spirited Away'));
    assert.ok(s.url.startsWith('https://'));
    assert.ok(['1080p', '720p', 'Auto'].includes(s.quality));
    assert.ok(typeof s.headers === 'object');
  }

  // Sorted by quality (1080p before 720p)
  assert.equal(streams[0].quality, '1080p');
});

test('animepahe handles invalid or missing inputs gracefully', async () => {
  // Empty tmdbId and context
  const emptyStreams = await getAnimepaheStreams(null, 'movie', null, null, {});
  assert.deepEqual(emptyStreams, []);

  // Fetcher throwing error
  const failingFetcher = async () => {
    throw new Error('Connection timeout');
  };
  const safeRes = await getAnimepaheStreams('999999', 'tv', 1, 1, {
    title: 'Nonexistent Anime',
    fetcher: failingFetcher
  });
  assert.deepEqual(safeRes, []);

  // Registry fetch function handles safely
  const animepahe = getProvider('animepahe');
  const regRes = await animepahe.fetch({ tmdbId: 'nonexistent-id', type: 'movie' });
  assert.deepEqual(regRes, []);
});
