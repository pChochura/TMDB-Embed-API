const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanColonTitle,
  normalizePolish,
  matchesQuery,
  pickMatches
} = require('../utils/polishMatcher');
const {
  parseSearchResponse: parseBajeczkiSearch,
  parseEmbedUrls: parseBajeczkiEmbeds,
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
const { getPolishStreams } = require('../providers/polish');

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
