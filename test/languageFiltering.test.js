const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterByLanguage,
  applyFilters,
  detectStreamLanguages
} = require('../utils/streamFilters');

test('Language Detection', async (t) => {
  await t.test('detects provider-level language (e.g. polish)', () => {
    const stream = { provider: 'polish', title: 'Film 1080p', url: 'http://example.com' };
    const langs = detectStreamLanguages(stream);
    assert.ok(langs.includes('pl'));
    assert.ok(langs.includes('polish'));
  });

  await t.test('detects explicit language property', () => {
    const stream = { language: 'English', title: 'Movie 1080p' };
    const langs = detectStreamLanguages(stream);
    assert.ok(langs.includes('en'));
    assert.ok(langs.includes('english'));
  });

  await t.test('detects language from title/name tags', () => {
    const streamPL = { name: 'Polish [CDA]', title: '[PL Lektor] Film - 1080p' };
    assert.ok(detectStreamLanguages(streamPL).includes('pl'));

    const streamHindi = { name: 'CastleTV 1080p', title: 'Movie [Hindi]' };
    assert.ok(detectStreamLanguages(streamHindi).includes('hi'));

    const streamMulti = { name: 'DahmerMovies', title: '1080p | Multi Audio | 2GB' };
    assert.ok(detectStreamLanguages(streamMulti).includes('multi'));

    const streamAnimeDub = { name: 'AnimePahe [HLS] (1080p Dub)', title: 'Episode 1' };
    assert.ok(detectStreamLanguages(streamAnimeDub).includes('en'));
  });

  await t.test('detects audioTracks and subtitles', () => {
    const streamTracks = {
      title: 'Movie',
      audioTracks: [{ language: 'es', label: 'Spanish' }]
    };
    const langs = detectStreamLanguages(streamTracks);
    assert.ok(langs.includes('es') || langs.includes('spanish'));

    const streamSubs = {
      title: 'Movie',
      subtitles: [{ lang: 'English', url: 'http://sub.srt' }]
    };
    assert.ok(detectStreamLanguages(streamSubs).includes('sub:english'));
  });

  await t.test('returns unknown for generic untagged streams', () => {
    const stream = { name: 'MovieWeb [Auto]', title: 'MovieWeb - 1080p' };
    const langs = detectStreamLanguages(stream);
    assert.deepEqual(langs, ['unknown']);
  });
});

test('Filter by Allowed Languages', async (t) => {
  const sampleStreams = [
    { id: 1, name: 'MovieWeb', title: 'Generic Movie 1080p' }, // unknown / default
    { id: 2, name: 'VidZee', title: 'VidZee 1080p - English', language: 'English' }, // en
    { id: 3, name: 'DahmerMovies', title: '1080p | Multi Audio | 2GB' }, // multi
    { id: 4, name: 'Polish [CDA]', title: '[PL Lektor] Test - 1080p', provider: 'polish' }, // pl
    { id: 5, name: 'CastleTV', title: 'CastleTV 1080p [Hindi]' }, // hi
    { id: 6, name: 'Stream', title: 'Spanish [ES] Movie 720p', language: 'Spanish' } // es
  ];

  await t.test('returns all streams when allowedLanguages is empty or null', () => {
    const res = filterByLanguage(sampleStreams, null, null);
    assert.equal(res.length, sampleStreams.length);

    const resAll = filterByLanguage(sampleStreams, ['all'], null);
    assert.equal(resAll.length, sampleStreams.length);
  });

  await t.test('filters for English (keeps English, Multi, and untagged default streams)', () => {
    const res = filterByLanguage(sampleStreams, ['en'], null);
    const ids = res.map(s => s.id);
    assert.ok(ids.includes(1), 'Keeps untagged/original stream');
    assert.ok(ids.includes(2), 'Keeps explicit English stream');
    assert.ok(ids.includes(3), 'Keeps Multi Audio stream');
    assert.ok(!ids.includes(4), 'Filters out Polish stream');
    assert.ok(!ids.includes(5), 'Filters out Hindi stream');
    assert.ok(!ids.includes(6), 'Filters out Spanish stream');
  });

  await t.test('filters for Polish only (drops untagged and other languages)', () => {
    const res = filterByLanguage(sampleStreams, ['pl'], null);
    const ids = res.map(s => s.id);
    assert.deepEqual(ids, [4]);
  });

  await t.test('filters for Hindi only', () => {
    const res = filterByLanguage(sampleStreams, ['hi'], null);
    const ids = res.map(s => s.id);
    assert.deepEqual(ids, [5]);
  });

  await t.test('filters for multiple allowed languages (pl and es)', () => {
    const res = filterByLanguage(sampleStreams, ['pl', 'es'], null);
    const ids = res.map(s => s.id);
    assert.deepEqual(ids, [4, 6]);
  });
});

test('Filter by Exclude Languages', async (t) => {
  const sampleStreams = [
    { id: 1, name: 'MovieWeb', title: 'Generic Movie 1080p' },
    { id: 2, name: 'VidZee', title: 'VidZee 1080p - English', language: 'English' },
    { id: 3, name: 'Polish [CDA]', title: '[PL Lektor] Test - 1080p', provider: 'polish' },
    { id: 4, name: 'CastleTV', title: 'CastleTV 1080p [Hindi]' }
  ];

  await t.test('excludes specified language while preserving untagged and other streams', () => {
    const res = filterByLanguage(sampleStreams, null, ['pl', 'hi']);
    const ids = res.map(s => s.id);
    assert.ok(ids.includes(1));
    assert.ok(ids.includes(2));
    assert.ok(!ids.includes(3), 'Polish excluded');
    assert.ok(!ids.includes(4), 'Hindi excluded');
  });
});

test('applyFilters combined quality, codec and language filtering', async (t) => {
  const streams = [
    { title: 'Stream 1', quality: '1080p', codecs: ['H264'], language: 'English' },
    { title: 'Stream 2', quality: '720p', codecs: ['H264'], language: 'English' },
    { title: 'Stream 3', quality: '1080p', codecs: ['DV', 'HDR'], language: 'English' },
    { name: 'Polish', quality: '1080p', codecs: ['H264'], provider: 'polish', title: '[PL] Stream' }
  ];

  // Min quality 1080p + exclude DV + allowed English only
  const res = applyFilters(streams, 'test', '1080p', { excludeDV: true }, ['en'], null);
  assert.equal(res.length, 1);
  assert.equal(res[0].title, 'Stream 1');
});
