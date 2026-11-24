const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deburrPolish,
  cleanColonTitle,
  normalizePolish,
  matchesQuery,
  pickMatches
} = require('../utils/polishMatcher');
const {
  parseSearchResponse: parseBajeczkiSearch,
  parseEmbedUrls: parseBajeczkiEmbeds,
  detectBajeczkiAudioTag,
  searchBajeczki24
} = require('../providers/polish/bajeczki24');
const {
  extractBootstrapData,
  detectObejrzyjAudioTag,
  findBestObejrzyjItem,
  searchObejrzyj
} = require('../providers/polish/obejrzyj');
const {
  mapPremiumsmartVideos,
  searchPremiumsmart
} = require('../providers/polish/premiumsmart');
const { getPolishStreams, resolveCdaStreamUrl, scrapeCDA, scrapeVider, parseViderSearchResults } = require('../providers/polish');

test('polishMatcher cleanColonTitle, normalizePolish, and matchesQuery operate correctly', () => {
  // 1. cleanColonTitle
  assert.equal(cleanColonTitle('Kraina lodu: Przygoda Olafa'), 'Kraina lodu');
  assert.equal(cleanColonTitle('Psi Patrol: Film (2021)'), 'Psi Patrol');
  assert.equal(cleanColonTitle('Shrek'), 'Shrek');

  // 2. normalizePolish
  assert.equal(normalizePolish('Wiedźmin: Zmora Wilka'), 'wiedzmin zmora wilka');
  assert.equal(normalizePolish('Królewna Śnieżka'), 'krolewna sniezka');

  // 3. matchesQuery word boundary matching
  assert.ok(matchesQuery('Dune: Part Two', 'Dune'));
  assert.ok(matchesQuery('Diuna (2021)', 'Diuna'));
  assert.ok(matchesQuery('Kraina lodu', 'Kraina lodu'));
  // Must NOT match accidental substring without word boundary
  assert.equal(matchesQuery('Zdunek i przyjaciele', 'Dune'), false);
  assert.equal(matchesQuery('Cudowne lata', 'Dune'), false);
});

test('polishMatcher pickMatches prioritizes exact year, allows ±1 year, and ranks by title length', () => {
  const candidates = [
    { title: 'Diuna: Część druga', year: '2024' },
    { title: 'Diuna', year: '2021' },
    { title: 'Diuna: Powrót legendy', year: '2025' },
    { title: 'Diuna Klasyk', year: '1984' }
  ];

  // Exact year match (2024)
  const match2024 = pickMatches(candidates, { title: 'Diuna', year: '2024' });
  assert.equal(match2024.length, 2); // 2024 (rank 0) and 2025 (rank 1), 2021 and 1984 dropped (> 1 year diff)
  assert.equal(match2024[0].year, '2024');

  // Exact year match (2021)
  const match2021 = pickMatches(candidates, { title: 'Diuna', year: '2021' });
  assert.equal(match2021[0].year, '2021');
  assert.equal(match2021[0].title, 'Diuna');
});

test('bajeczki24 parses Meilisearch hits and extracts embed URLs accurately', () => {
  const mockApiHits = {
    hits: [
      {
        title: 'Kraina lodu',
        releaseYear: 2013,
        path: '/filmy/animowane/kraina-lodu/'
      },
      {
        title: 'Psi Patrol',
        releaseYear: 2013,
        path: '/seriale/animowane/psi-patrol/'
      },
      {
        title: 'Ignored Path',
        path: '/news/article/'
      }
    ]
  };

  const parsed = parseBajeczkiSearch(mockApiHits);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, 'movie');
  assert.equal(parsed[0].url, 'https://bajeczki24.pl/filmy/animowane/kraina-lodu/');
  assert.equal(parsed[1].type, 'tv');

  const mockHtml = `
    <html>
      <body>
        <div class="video-container">
          <iframe src="//bysesukior.com/e/abc1234xyz" allowfullscreen></iframe>
        </div>
      </body>
    </html>
  `;
  const embeds = parseBajeczkiEmbeds(mockHtml);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0], 'https://bysesukior.com/e/abc1234xyz');
});

test('bajeczki24 searchBajeczki24 executes search and maps streams with mock axiosInstance', async () => {
  const mockAxios = {
    post: async () => ({
      data: {
        hits: [
          {
            title: 'Shrek',
            releaseYear: 2001,
            path: '/filmy/animowane/shrek/'
          }
        ]
      }
    }),
    get: async () => ({
      data: '<html><iframe src="https://bysesukior.com/e/shrek123"></iframe></html>'
    })
  };

  const streams = await searchBajeczki24(
    { title: 'Shrek', polishTitle: 'Shrek', year: 2001, type: 'movie' },
    { axiosInstance: mockAxios }
  );

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, 'Polish [Bajeczki24]');
  assert.ok(streams[0].title.includes('[PL Dubbing]'));
  assert.equal(streams[0].url, 'https://bysesukior.com/e/shrek123');
  assert.equal(streams[0].quality, '1080p');
});

test('bajeczki24 searches non-kids content and detects [PL Lektor] audio tag', async () => {
  const mockAxios = {
    post: async () => ({
      data: {
        hits: [
          {
            title: 'Gladiator',
            releaseYear: 2000,
            path: '/filmy/akcja/gladiator/',
            categories: ['Akcja', 'Dramat']
          }
        ]
      }
    }),
    get: async () => ({
      data: '<html><iframe src="https://bysesukior.com/e/gladiator123"></iframe></html>'
    })
  };

  const streams = await searchBajeczki24(
    { title: 'Gladiator', polishTitle: 'Gladiator', year: 2000, type: 'movie' },
    { axiosInstance: mockAxios, isKidsOrAnimation: false }
  );

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, 'Polish [Bajeczki24]');
  assert.ok(streams[0].title.includes('[PL Lektor]'));
  assert.equal(streams[0].url, 'https://bysesukior.com/e/gladiator123');
});

test('obejrzyj extracts bootstrapData, matches by TMDB/IMDb, and detects audio tags', () => {
  const html = `
    <script>
      window.bootstrapData = {
        "loaders": {
          "searchPage": {
            "results": [
              {
                "id": 100,
                "name": "Diuna",
                "is_series": false,
                "tmdb_id": 438631,
                "imdb_id": "tt1160419",
                "year": 2021
              }
            ]
          }
        }
      };
    </script>
  `;

  const data = extractBootstrapData(html);
  assert.ok(data);
  const results = data.loaders.searchPage.results;

  // Match by TMDB ID
  const matchTmdb = findBestObejrzyjItem(results, { tmdbId: '438631' });
  assert.equal(matchTmdb.id, 100);

  // Match by IMDb ID
  const matchImdb = findBestObejrzyjItem(results, { imdbId: '1160419' });
  assert.equal(matchImdb.id, 100);

  // Detect audio tags
  assert.equal(detectObejrzyjAudioTag({ language_type: 'lektor_pl' }), '[PL Lektor]');
  assert.equal(detectObejrzyjAudioTag({ language_type: 'dubbing_pl' }), '[PL Dubbing]');
  assert.equal(detectObejrzyjAudioTag({ language_type: 'napisy_pl' }), '[PL Napisy]');
  assert.equal(detectObejrzyjAudioTag({}, true), '[PL Dubbing]');
  assert.equal(detectObejrzyjAudioTag({}, false), '[PL Lektor]');
});

test('obejrzyj searchObejrzyj resolves movie and TV video sources with mock axiosInstance', async () => {
  const mockSearchHtml = `
    <script>
      window.bootstrapData = {
        "loaders": {
          "searchPage": {
            "results": [
              { "id": 50908, "name": "Wiedźmin", "is_series": true, "tmdb_id": 71912, "imdb_id": "tt5180504" }
            ]
          }
        }
      };
    </script>
  `;

  const mockEpisodeHtml = `
    <script>
      window.bootstrapData = {
        "loaders": {
          "episodePage": {
            "episode": {
              "videos": [
                {
                  "name": "Filemoon",
                  "src": "https://streamlyplayero.online/e/testvideo",
                  "quality": "1080p",
                  "language_type": "lektor_pl"
                }
              ]
            }
          }
        }
      };
    </script>
  `;

  const mockAxios = {
    get: async (url) => {
      if (url.includes('/search/')) return { data: mockSearchHtml };
      return { data: mockEpisodeHtml };
    }
  };

  const streams = await searchObejrzyj(
    { title: 'The Witcher', polishTitle: 'Wiedźmin', type: 'tv', season: 1, episode: 1, tmdbId: 71912 },
    { axiosInstance: mockAxios }
  );

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, 'Polish [Filemoon]');
  assert.ok(streams[0].title.includes('[PL Lektor]'));
  assert.equal(streams[0].url, 'https://streamlyplayero.online/e/testvideo');
  assert.equal(streams[0].quality, '1080p');
});

test('premiumsmart maps videos and searchPremiumsmart queries API with mock axiosInstance', async () => {
  const mockVideos = [
    {
      src: '//hoster.com/embed/12345',
      name: 'vShare',
      quality: '1080p',
      language_type: 'dubbing_pl'
    }
  ];

  const mapped = mapPremiumsmartVideos(mockVideos, 'Shrek', true);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].url, 'https://hoster.com/embed/12345');
  assert.ok(mapped[0].title.includes('[PL Dubbing]'));
  assert.equal(mapped[0].name, 'Polish [vShare]');

  const mockAxios = {
    get: async (url) => {
      if (url.endsWith('/')) {
        return { headers: { 'set-cookie': ['session=test123; path=/'] } };
      }
      if (url.includes('/api/v1/search/')) {
        return {
          data: {
            results: [{ id: 808, name: 'Shrek', model_type: 'title', is_series: false }]
          }
        };
      }
      return {
        data: {
          title: {
            videos: [
              { src: 'https://hoster.com/embed/shrek', name: 'Mixdrop', category: 'full', quality: '1080p' }
            ]
          }
        }
      };
    }
  };

  const streams = await searchPremiumsmart(
    { title: 'Shrek', polishTitle: 'Shrek', type: 'movie' },
    { axiosInstance: mockAxios, isKidsOrAnimation: true }
  );

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, 'Polish [Mixdrop]');
  assert.ok(streams[0].title.includes('[PL Dubbing]'));
  assert.equal(streams[0].url, 'https://hoster.com/embed/shrek');
});

test('getPolishStreams respects ctx.language and localized ctx.title from query parameter', async () => {
  const executedQueries = [];
  const mockScraper = async (query) => {
    executedQueries.push(query);
    return [
      {
        title: 'Kraina lodu Dubbing PL 1080p',
        url: 'https://vider.info/embed/video/kraina123',
        quality: '1080p',
        provider: 'polish'
      }
    ];
  };

  const streams = await getPolishStreams(109445, 'movie', null, null, {
    title: 'Kraina lodu',
    originalTitle: 'Frozen',
    language: 'pl',
    scrapers: [mockScraper]
  });

  assert.ok(streams.length > 0);
  assert.ok(executedQueries.some(q => q.includes('Kraina lodu')), 'Queries should use localized Polish title');
  assert.equal(streams[0].url, 'https://vider.info/embed/video/kraina123');
});

test('resolveCdaStreamUrl extracts direct manifest_apple HLS m3u8 playlist', async () => {
  const mockHtml = `
    <html>
      <div id="mediaplayer123" player_data='{"video":{"manifest_apple":"https://vcze202.cda.pl/abc/123.m3u8"}}'></div>
    </html>
  `;
  const mockAxios = {
    get: async () => ({ data: mockHtml })
  };

  const resolved = await resolveCdaStreamUrl('https://ebd.cda.pl/620x368/123', { axiosInstance: mockAxios });
  assert.equal(resolved, 'https://vcze202.cda.pl/abc/123.m3u8');

  // Fallback when player_data is missing
  const fallbackAxios = {
    get: async () => ({ data: '<html><div>No player</div></html>' })
  };
  const fallback = await resolveCdaStreamUrl('https://ebd.cda.pl/620x368/999', { axiosInstance: fallbackAxios });
  assert.equal(fallback, 'https://ebd.cda.pl/620x368/999');
});

test('deburrPolish strips Polish diacritics while preserving words and casing', () => {
  assert.equal(deburrPolish('Kamień'), 'Kamien');
  assert.equal(deburrPolish('Chłopi'), 'Chlopi');
  assert.equal(deburrPolish('Żądło'), 'Zadlo');
  assert.equal(deburrPolish('Świętojańska'), 'Swietojanska');
  assert.equal(deburrPolish('Wiedźmin 3: Dziki Gon'), 'Wiedzmin 3: Dziki Gon');
});

test('scrapeCDA deburrs Polish diacritics in the search URL to avoid redirect loops', async () => {
  let requestedUrl = null;
  const mockAxios = {
    get: async (url) => {
      requestedUrl = url;
      return { data: '<html><div>Empty</div></html>' };
    }
  };

  await scrapeCDA('Harry Potter i Kamień Filozoficzny', { axiosInstance: mockAxios });
  assert.ok(requestedUrl);
  assert.ok(requestedUrl.includes('Kamien'), 'URL should contain Kamien instead of non-ASCII Kamień');
  assert.ok(!requestedUrl.includes('%C5%84'), 'URL should not contain percent-encoded Polish diacritic');
});

test('parseViderSearchResults parses both JSON response and HTML markup', () => {
  // 1. JSON payload from POST /search/get
  const mockJson = {
    response: {
      data_files: {
        data: [
          {
            id: '12345',
            id_url: 'shrek3abc',
            name: 'Shrek Trzeci (2007) Dubbing PL 1080p',
            duration: '1:32:48'
          }
        ]
      }
    }
  };

  const jsonStreams = parseViderSearchResults(mockJson, true);
  assert.equal(jsonStreams.length, 1);
  assert.equal(jsonStreams[0].name, 'Polish [Vider]');
  assert.ok(jsonStreams[0].title.includes('[PL Dubbing]'));
  assert.equal(jsonStreams[0].quality, '1080p');
  assert.equal(jsonStreams[0].duration, 5568);
  assert.equal(jsonStreams[0].url, 'https://vider.info/embed/video/shrek3abc');

  // 2. HTML markup fallback
  const mockHtml = `
    <div class="video-item">
      <a href="/video/shrek4xyz" title="Shrek Forever After 2010 Dubbing PL">Shrek Forever</a>
      <span class="time">1:33:10</span>
    </div>
  `;
  const htmlStreams = parseViderSearchResults(mockHtml, true);
  assert.equal(htmlStreams.length, 1);
  assert.equal(htmlStreams[0].name, 'Polish [Vider]');
  assert.equal(htmlStreams[0].url, 'https://vider.info/embed/video/shrek4xyz');
});

test('scrapeVider queries JSON endpoint and falls back gracefully', async () => {
  let postCalled = false;
  let postPayload = null;
  const mockAxios = {
    post: async (url, data) => {
      postCalled = true;
      postPayload = data;
      return {
        data: {
          response: {
            data_files: {
              data: [
                {
                  id: '999',
                  id_url: 'viderTestId',
                  name: 'Testowy Film Dubbing PL',
                  duration: '01:30:00'
                }
              ]
            }
          }
        }
      };
    }
  };

  const streams = await scrapeVider('Kiler: Dwójka', { axiosInstance: mockAxios });
  assert.ok(postCalled);
  assert.equal(postPayload.search_phrase, 'Kiler Dwojka');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://vider.info/embed/video/viderTestId');
});
