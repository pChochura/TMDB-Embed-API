const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listProviders, getProvider } = require('../providers/registry');
const {
  getMovieWebStreams,
  mapStreamToStandard,
  formatQuality
} = require('../providers/movieweb');
const { getStremioBridgeStreams } = require('../providers/stremiobridge');
const {
  getPolishStreams,
  detectAudioTag,
  detectQuality,
  buildSearchQueries,
  parseCDASearchResults,
  parseViderSearchResults
} = require('../providers/polish');

test('registry loading and provider list includes new providers with correct defaults', () => {
  const providers = listProviders();
  const providerNames = providers.map(p => p.name);

  // Providers must be registered
  assert.ok(providerNames.includes('movieweb'), 'movieweb should be listed in providers');
  assert.ok(providerNames.includes('stremiobridge'), 'stremiobridge should be listed in providers');
  assert.ok(providerNames.includes('polish'), 'polish should be listed in providers');
  assert.ok(providerNames.includes('animepahe'), 'animepahe should be listed in providers');
  assert.ok(providerNames.includes('vidzee'), 'vidzee should be listed in providers');

  // Polish should default to enabled: true
  const polish = getProvider('polish');
  assert.ok(polish, 'getProvider("polish") should return provider');
  assert.equal(polish.name, 'polish');
  assert.equal(typeof polish.fetch, 'function');
  assert.equal(polish.enabled, true, 'polish should default to enabled');

  // Movieweb should default to enabled: true
  const movieweb = getProvider('movieweb');
  assert.ok(movieweb, 'getProvider("movieweb") should return provider');
  assert.equal(movieweb.name, 'movieweb');
  assert.equal(typeof movieweb.fetch, 'function');
  assert.equal(movieweb.enabled, true, 'movieweb should default to enabled');

  // Stremiobridge should default to disabled: false (sidecar-dependent)
  const stremiobridge = getProvider('stremiobridge');
  assert.ok(stremiobridge, 'getProvider("stremiobridge") should return provider');
  assert.equal(stremiobridge.name, 'stremiobridge');
  assert.equal(typeof stremiobridge.fetch, 'function');
  assert.equal(stremiobridge.enabled, false, 'stremiobridge should default to disabled without configured sidecars');
});

test('registry fetch passes context and handles empty results safely', async () => {
  const movieweb = getProvider('movieweb');
  const stremiobridge = getProvider('stremiobridge');

  // When called without context or with empty tmdbId, should return empty array safely without error
  const mwRes = await movieweb.fetch({ tmdbId: 'nonexistent-test-id-000', type: 'movie' });
  assert.ok(Array.isArray(mwRes));
  assert.equal(mwRes.length, 0);

  const sbRes = await stremiobridge.fetch({ tmdbId: 'nonexistent-test-id-000', type: 'movie' });
  assert.ok(Array.isArray(sbRes));
  assert.equal(sbRes.length, 0);

  const polish = getProvider('polish');
  const polRes = await polish.fetch({ tmdbId: 'nonexistent-test-id-000', type: 'movie' });
  assert.ok(Array.isArray(polRes));
  assert.equal(polRes.length, 0);
});

test('movieweb formatQuality formats known resolutions accurately', () => {
  assert.equal(formatQuality('4k'), '4K');
  assert.equal(formatQuality('2160'), '4K');
  assert.equal(formatQuality('2160p'), '4K');
  assert.equal(formatQuality('1080'), '1080p');
  assert.equal(formatQuality('1080p'), '1080p');
  assert.equal(formatQuality('720'), '720p');
  assert.equal(formatQuality('720p'), '720p');
  assert.equal(formatQuality('unknown'), 'Auto');
  assert.equal(formatQuality('auto'), 'Auto');
  assert.equal(formatQuality(null), 'Auto');
  assert.equal(formatQuality(''), 'Auto');
});

test('movieweb mapStreamToStandard maps HLS playlists correctly', () => {
  const hlsResult = {
    sourceId: 'flixhq',
    embedId: 'upcloud',
    stream: {
      type: 'hls',
      playlist: 'https://example.com/playlist.m3u8',
      preferredHeaders: { 'Referer': 'https://flixhq.to' }
    }
  };

  const mapped = mapStreamToStandard(hlsResult);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].provider, 'movieweb');
  assert.equal(mapped[0].url, 'https://example.com/playlist.m3u8');
  assert.equal(mapped[0].quality, 'Auto');
  assert.equal(mapped[0].name, 'MovieWeb [flixhq/upcloud]');
  assert.equal(mapped[0].title, 'MovieWeb (flixhq/upcloud) - Auto');
  assert.equal(mapped[0].headers.Referer, 'https://flixhq.to');
});

test('movieweb mapStreamToStandard maps multi-quality file streams correctly', () => {
  const fileResult = {
    sourceId: 'superstream',
    embedId: 'direct',
    stream: {
      type: 'file',
      qualities: {
        '1080': { url: 'https://example.com/1080.mp4' },
        '720': { url: 'https://example.com/720.mp4' }
      },
      headers: { 'User-Agent': 'CustomUA' }
    }
  };

  const mapped = mapStreamToStandard(fileResult);
  assert.equal(mapped.length, 2);

  const stream1080 = mapped.find(s => s.quality === '1080p');
  assert.ok(stream1080);
  assert.equal(stream1080.url, 'https://example.com/1080.mp4');
  assert.equal(stream1080.provider, 'movieweb');
  assert.equal(stream1080.headers['User-Agent'], 'CustomUA');

  const stream720 = mapped.find(s => s.quality === '720p');
  assert.ok(stream720);
  assert.equal(stream720.url, 'https://example.com/720.mp4');
});

test('movieweb mapStreamToStandard handles empty or invalid inputs gracefully', () => {
  assert.deepEqual(mapStreamToStandard(null), []);
  assert.deepEqual(mapStreamToStandard(undefined), []);
  assert.deepEqual(mapStreamToStandard({}), []);
  assert.deepEqual(mapStreamToStandard({ stream: null }), []);
});

test('movieweb getMovieWebStreams handles mock provider execution and timeout gracefully', async () => {
  // Mock custom provider instance
  let capturedOps = null;
  const mockProviders = {
    runAll: async (ops) => {
      capturedOps = ops;
      return {
        sourceId: 'mocksource',
        embedId: 'mockembed',
        stream: {
          type: 'hls',
          playlist: 'https://mock.cdn/stream.m3u8'
        }
      };
    }
  };

  const streams = await getMovieWebStreams('550', 'movie', null, null, {
    title: 'Fight Club',
    year: 1999,
    imdbId: 'tt0137523',
    providersInstance: mockProviders
  });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://mock.cdn/stream.m3u8');
  assert.equal(streams[0].provider, 'movieweb');
  assert.equal(capturedOps.media.type, 'movie');
  assert.equal(capturedOps.media.title, 'Fight Club');
  assert.equal(capturedOps.media.releaseYear, 1999);
  assert.equal(capturedOps.media.imdbId, 'tt0137523');

  // Test TV media construction
  await getMovieWebStreams('1399', 'tv', 1, 3, {
    title: 'Game of Thrones',
    year: 2011,
    providersInstance: mockProviders
  });
  assert.equal(capturedOps.media.type, 'show');
  assert.equal(capturedOps.media.season.number, 1);
  assert.equal(capturedOps.media.episode.number, 3);

  // Test timeout handling
  const hangingProviders = {
    runAll: () => new Promise(resolve => setTimeout(() => resolve({ stream: { url: 'late.mp4' } }), 500))
  };
  const timedOutStreams = await getMovieWebStreams('550', 'movie', null, null, {
    title: 'Fight Club',
    timeout: 50,
    providersInstance: hangingProviders
  });
  assert.deepEqual(timedOutStreams, []);
});

test('stremiobridge returns empty array when unconfigured or missing IMDb ID', async () => {
  // Empty STREMIO_BRIDGE_URLS
  const origUrls = process.env.STREMIO_BRIDGE_URLS;
  try {
    delete process.env.STREMIO_BRIDGE_URLS;
    const resNoUrls = await getStremioBridgeStreams('550', 'movie', null, null, { imdbId: 'tt0137523' });
    assert.deepEqual(resNoUrls, []);

    // Configured URL but no IMDb ID and unresolvable TMDB
    process.env.STREMIO_BRIDGE_URLS = 'http://127.0.0.1:9999';
    const resNoImdb = await getStremioBridgeStreams(null, 'movie', null, null, { imdbId: null });
    assert.deepEqual(resNoImdb, []);
  } finally {
    if (origUrls !== undefined) process.env.STREMIO_BRIDGE_URLS = origUrls;
    else delete process.env.STREMIO_BRIDGE_URLS;
  }
});

test('stremiobridge formats queries for movies and series and maps responses properly', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);

    if (req.url === '/stream/movie/tt0137523.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        streams: [
          {
            name: 'WebStreamr 1080p',
            title: 'Fight Club 1080p BluRay',
            url: 'https://cdn.example.com/movie.m3u8',
            behaviorHints: {
              proxyHeaders: {
                request: {
                  'Referer': 'https://upstream.test',
                  'User-Agent': 'TestUA'
                }
              }
            }
          },
          {
            // Invalid / non-http stream should be filtered out
            name: 'P2P Stream',
            title: 'Torrent InfoHash',
            infoHash: 'abcd1234ef5678'
          }
        ]
      }));
    } else if (req.url === '/stream/series/tt0944947:2:5.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        streams: [
          {
            name: 'CinePro 4K',
            title: 'Game of Thrones S02E05 2160p HDR',
            url: 'https://cdn.example.com/series-4k.mp4'
          }
        ]
      }));
    } else if (req.url === '/stream/movie/tt500error.json') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error": "Internal Error"}');
    } else if (req.url === '/stream/movie/ttbadjson.json') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('NOT VALID JSON');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}/manifest.json`;

  const origUrls = process.env.STREMIO_BRIDGE_URLS;
  process.env.STREMIO_BRIDGE_URLS = baseUrl;

  try {
    // 1. Movie query formatting & mapping test
    const movieStreams = await getStremioBridgeStreams('550', 'movie', null, null, {
      imdbId: '0137523' // without tt prefix; should be normalized to tt0137523
    });

    assert.ok(requests.includes('/stream/movie/tt0137523.json'), 'Should format movie endpoint URL with tt-prefixed IMDb ID');
    assert.equal(movieStreams.length, 1, 'Only HTTP streams should be returned (non-HTTP filtered)');
    assert.equal(movieStreams[0].provider, 'stremiobridge');
    assert.equal(movieStreams[0].quality, '1080p');
    assert.equal(movieStreams[0].name, 'WebStreamr 1080p');
    assert.equal(movieStreams[0].title, 'Fight Club 1080p BluRay');
    assert.equal(movieStreams[0].url, 'https://cdn.example.com/movie.m3u8');
    assert.deepEqual(movieStreams[0].headers, {
      Referer: 'https://upstream.test',
      'User-Agent': 'TestUA'
    });

    // 2. Series query formatting & 4K detection test
    const seriesStreams = await getStremioBridgeStreams('1399', 'tv', 2, 5, {
      imdbId: 'tt0944947'
    });

    assert.ok(requests.includes('/stream/series/tt0944947:2:5.json'), 'Should format series endpoint URL with imdb:season:episode');
    assert.equal(seriesStreams.length, 1);
    assert.equal(seriesStreams[0].quality, '4K');
    assert.equal(seriesStreams[0].url, 'https://cdn.example.com/series-4k.mp4');

    // 3. Error and bad JSON handling
    const errorStreams = await getStremioBridgeStreams('999', 'movie', null, null, { imdbId: 'tt500error' });
    assert.deepEqual(errorStreams, []);

    const badJsonStreams = await getStremioBridgeStreams('999', 'movie', null, null, { imdbId: 'ttbadjson' });
    assert.deepEqual(badJsonStreams, []);

  } finally {
    if (origUrls !== undefined) process.env.STREMIO_BRIDGE_URLS = origUrls;
    else delete process.env.STREMIO_BRIDGE_URLS;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('polish detectAudioTag correctly identifies Lektor, Napisy, and Dubbing', () => {
  assert.equal(detectAudioTag('Inception (2010) [Lektor PL] 1080p'), '[PL Lektor]');
  assert.equal(detectAudioTag('Inception 2010 PL-LEKTOR 720p'), '[PL Lektor]');
  assert.equal(detectAudioTag('Breaking Bad S01E01 Lekt'), '[PL Lektor]');
  assert.equal(detectAudioTag('Avatar (2009) Napisy PL 1080p'), '[PL Napisy]');
  assert.equal(detectAudioTag('Gladiator [PL-Napisy] WEB-DL'), '[PL Napisy]');
  assert.equal(detectAudioTag('Shrek Dubbing PL 720p'), '[PL Dubbing]');
  assert.equal(detectAudioTag('Kroll (1991) Polski Film'), '[PL Lektor]');
  assert.equal(detectAudioTag('Unknown Audio Format'), '[PL Lektor]');
});

test('polish detectQuality formats resolutions correctly', () => {
  assert.equal(detectQuality('Video 2160p UHD'), '4K');
  assert.equal(detectQuality('Video 4k'), '4K');
  assert.equal(detectQuality('Video 1080p FHD'), '1080p');
  assert.equal(detectQuality('Video 720p HD'), '720p');
  assert.equal(detectQuality('Video 480p SD'), '480p');
  assert.equal(detectQuality('Video 360p'), '360p');
  assert.equal(detectQuality('Video Rip'), 'Auto');
});

test('polish buildSearchQueries constructs movie and TV search queries with Polish title', () => {
  // Movie query check
  const movieQueries = buildSearchQueries({
    title: 'Fight Club',
    polishTitle: 'Podziemny krąg',
    year: 1999,
    isTv: false
  });
  assert.ok(movieQueries.includes('Podziemny krąg Lektor PL'));
  assert.ok(movieQueries.includes('Podziemny krąg 1999 Lektor'));
  assert.ok(movieQueries.includes('Fight Club Lektor PL'));

  // TV query check
  const tvQueries = buildSearchQueries({
    title: 'Breaking Bad',
    polishTitle: 'Breaking Bad',
    year: 2008,
    isTv: true,
    season: 1,
    episode: 2
  });
  assert.ok(tvQueries.includes('Breaking Bad S01E02 Lektor'));
  assert.ok(tvQueries.includes('Breaking Bad S01E02'));
});

test('polish parses CDA and Vider search HTML accurately into standard stream objects', () => {
  const cdaHtml = `
    <div class="elem-rts">
      <a href="/video/9876543a" title="Diuna Część Druga (2024) Lektor PL 1080p">
        <span class="quality">1080p</span>
      </a>
    </div>
    <div class="video-clip">
      <a href="/video/1234567b" title="Diuna 2 (2024) Napisy PL 720p">
        <span class="hd-badge">720p</span>
      </a>
    </div>
  `;

  const cdaStreams = parseCDASearchResults(cdaHtml);
  assert.equal(cdaStreams.length, 2);
  assert.equal(cdaStreams[0].name, 'Polish [CDA]');
  assert.equal(cdaStreams[0].url, 'https://ebd.cda.pl/620x368/9876543a');
  assert.equal(cdaStreams[0].quality, '1080p');
  assert.equal(cdaStreams[0].provider, 'polish');
  assert.ok(cdaStreams[0].title.startsWith('[PL Lektor]'));

  assert.equal(cdaStreams[1].name, 'Polish [CDA]');
  assert.equal(cdaStreams[1].url, 'https://ebd.cda.pl/620x368/1234567b');
  assert.equal(cdaStreams[1].quality, '720p');
  assert.ok(cdaStreams[1].title.startsWith('[PL Napisy]'));

  const viderHtml = `
    <div class="video-item">
      <a href="/vid/xyz890" title="Wiedźmin S01E01 Lektor PL 1080p"></a>
    </div>
  `;

  const viderStreams = parseViderSearchResults(viderHtml);
  assert.equal(viderStreams.length, 1);
  assert.equal(viderStreams[0].name, 'Polish [Vider]');
  assert.equal(viderStreams[0].url, 'https://vider.info/embed/video/xyz890');
  assert.equal(viderStreams[0].quality, '1080p');
  assert.ok(viderStreams[0].title.startsWith('[PL Lektor]'));
});

test('polish parseCDASearchResults filters out CDA Premium items', () => {
  const cdaHtmlWithPremium = `
    <div class="video-clip">
      <a class="video-clip-link autoHide" href="https://www.cda.pl/video/23324482b3/vfilm">
        <span class="timeElem">01:30:40</span>
      </a>
      <div class="text text-video">
        <a class="link-title-visit" href="https://www.cda.pl/video/23324482b3/vfilm">Shrek (2001) Dubbing PL</a>
        <span class="hd-ico-elem hd-elem-pos-title">1080p</span>
        <span class="flag-video-premium">premium</span>
      </div>
    </div>
    <div class="video-clip">
      <a class="video-clip-link autoHide" href="/video/free123">
        <span class="timeElem">01:20:00</span>
      </a>
      <div class="text text-video">
        <a class="link-title-visit" href="/video/free123">Shrek Fan Film Lektor PL</a>
        <span class="hd-ico-elem hd-elem-pos-title">720p</span>
      </div>
    </div>
  `;

  const filteredStreams = parseCDASearchResults(cdaHtmlWithPremium);
  assert.equal(filteredStreams.length, 1, 'Should filter out the premium /vfilm item and keep the free one');
  assert.equal(filteredStreams[0].url, 'https://ebd.cda.pl/620x368/free123');
  assert.equal(filteredStreams[0].quality, '720p');
  assert.ok(filteredStreams[0].title.includes('Shrek Fan Film'));
});

test('polish getPolishStreams handles mock scrapers, ranking, and error resilience', async () => {
  // 1. Safe handling when no TMDB or title
  const emptyStreams = await getPolishStreams(null, 'movie', null, null, {});
  assert.deepEqual(emptyStreams, []);

  // 2. Mock scraper with ranking: Lektor before Napisy, and higher quality first
  const mockScraper1 = async () => [
    {
      name: 'Polish [CDA]',
      title: 'Film [PL Napisy] - 1080p',
      url: 'https://ebd.cda.pl/620x368/napisy1080',
      quality: '1080p'
    },
    {
      name: 'Polish [CDA]',
      title: 'Film [PL Lektor] - 720p',
      url: 'https://ebd.cda.pl/620x368/lektor720',
      quality: '720p'
    },
    {
      name: 'Polish [CDA]',
      title: 'Film [PL Lektor] - 1080p',
      url: 'https://ebd.cda.pl/620x368/lektor1080',
      quality: '1080p'
    }
  ];

  const results = await getPolishStreams('550', 'movie', null, null, {
    title: 'Fight Club',
    polishTitle: 'Podziemny krąg',
    year: 1999,
    scrapers: [mockScraper1]
  });

  assert.equal(results.length, 3);
  // Lektor 1080p should rank first, then Lektor 720p, then Napisy 1080p
  assert.equal(results[0].url, 'https://ebd.cda.pl/620x368/lektor1080');
  assert.ok(results[0].title.includes('[PL Lektor]'));
  assert.equal(results[1].url, 'https://ebd.cda.pl/620x368/lektor720');
  assert.ok(results[1].title.includes('[PL Lektor]'));
  assert.equal(results[2].url, 'https://ebd.cda.pl/620x368/napisy1080');
  assert.ok(results[2].title.includes('[PL Napisy]'));

  // 3. Failing scraper resilience: should return empty array safely without throwing
  const failingScraper = async () => {
    throw new Error('Connection refused / timeout');
  };
  const safeRes = await getPolishStreams('550', 'movie', null, null, {
    title: 'Fight Club',
    scrapers: [failingScraper]
  });
  assert.deepEqual(safeRes, []);
});
