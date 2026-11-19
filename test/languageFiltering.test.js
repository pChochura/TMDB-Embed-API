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
    const { langs } = detectStreamLanguages(stream);
    assert.ok(langs.includes('pl'));
  });

  await t.test('detects explicit language property', () => {
    const stream = { language: 'English', title: 'Movie 1080p' };
    const { langs } = detectStreamLanguages(stream);
    assert.ok(langs.includes('en'));
  });

  await t.test('detects language from title/name tags', () => {
    const streamPL = { name: 'Polish [CDA]', title: '[PL Lektor] Film - 1080p' };
    assert.ok(detectStreamLanguages(streamPL).langs.includes('pl'));

    const streamHindi = { name: 'CastleTV [Hindi] | 1080p', title: 'Movie 1080p' };
    assert.ok(detectStreamLanguages(streamHindi).langs.includes('hi'));

    const streamTamil = { name: 'CastleTV [Tamil] | 1080p', title: 'Movie 1080p' };
    assert.ok(detectStreamLanguages(streamTamil).langs.includes('ta'));

    const streamMulti = { name: 'DahmerMovies', title: '1080p | Multi Audio | 2GB' };
    assert.ok(detectStreamLanguages(streamMulti).isMulti);

    const streamAnimeDub = { name: 'AnimePahe [HLS] (1080p Dub)', title: 'Episode 1' };
    assert.ok(detectStreamLanguages(streamAnimeDub).langs.includes('en'));
  });

  await t.test('subtitles do not override foreign audio', () => {
    const stream = {
      name: 'CastleTV [Hindi] | 1080p',
      title: 'Movie',
      subtitles: [{ lang: 'en', url: 'http://sub.srt' }]
    };
    const { langs } = detectStreamLanguages(stream);
    assert.ok(langs.includes('hi'));
    assert.ok(!langs.includes('en'), 'English subtitle should not add English to audio langs');
  });

  await t.test('returns unknown for generic untagged streams', () => {
    const stream = { name: 'MovieWeb [Auto]', title: 'MovieWeb - 1080p' };
    const { langs } = detectStreamLanguages(stream);
    assert.deepEqual(langs, ['unknown']);
  });
});

test('Filter by Allowed Languages [en, pl]', async (t) => {
  const sampleStreams = [
    { id: 1, name: 'MovieWeb', title: 'Generic Movie 1080p' }, // unknown / default
    { id: 2, name: 'VidZee', title: 'VidZee 1080p - English', language: 'English' }, // en
    { id: 3, name: 'CastleTV [English] | 1080p', title: 'Movie 1080p' }, // en
    { id: 4, name: 'Polish [CDA]', title: '[PL Lektor] Test - 1080p', provider: 'polish' }, // pl
    { id: 5, name: 'CastleTV [Hindi] | 1080p', title: 'Movie 1080p', subtitles: [{ lang: 'en' }] }, // hi
    { id: 6, name: 'CastleTV [Tamil] | 1080p', title: 'Movie 1080p', subtitles: [{ lang: 'en' }] }, // ta
    { id: 7, name: '4KHDHub', title: 'Movie [Hindi-Tamil-Telugu AMZN DDP 5.1 + English Atmos] x265' }, // foreign multi
    { id: 8, name: '4KHDHub', title: 'Movie.MULTi.DDP5.1.Atmos.mkv' } // pure multi
  ];

  await t.test('returns all streams when allowedLanguages is empty or null', () => {
    const res = filterByLanguage(sampleStreams, null, null);
    assert.equal(res.length, sampleStreams.length);

    const resAll = filterByLanguage(sampleStreams, ['all'], null);
    assert.equal(resAll.length, sampleStreams.length);
  });

  await t.test('strict [en, pl] drops Hindi, Tamil, and foreign multi-audio', () => {
    const res = filterByLanguage(sampleStreams, ['en', 'pl'], null);
    const ids = res.map(s => s.id);
    assert.ok(ids.includes(1), 'Keeps untagged stream');
    assert.ok(ids.includes(2), 'Keeps explicit English stream');
    assert.ok(ids.includes(3), 'Keeps CastleTV English stream');
    assert.ok(ids.includes(4), 'Keeps Polish stream');
    assert.ok(!ids.includes(5), 'Drops CastleTV Hindi stream even with English subs');
    assert.ok(!ids.includes(6), 'Drops CastleTV Tamil stream even with English subs');
    assert.ok(!ids.includes(7), 'Drops Hindi-Tamil-Telugu multi-audio');
    assert.ok(!ids.includes(8), 'Drops MULTi repack when multi not allowed');
  });

  await t.test('[en, pl, multi] keeps multi-audio containing English', () => {
    const res = filterByLanguage(sampleStreams, ['en', 'pl', 'multi'], null);
    const ids = res.map(s => s.id);
    assert.ok(ids.includes(1));
    assert.ok(ids.includes(2));
    assert.ok(ids.includes(3));
    assert.ok(ids.includes(4));
    assert.ok(!ids.includes(5), 'Still drops pure Hindi');
    assert.ok(!ids.includes(6), 'Still drops pure Tamil');
    assert.ok(ids.includes(7), 'Keeps Hindi-Tamil-Telugu + English when multi is allowed');
    assert.ok(ids.includes(8), 'Keeps MULTi repack when multi is allowed');
  });

  await t.test('filters for Polish only (drops untagged and other languages)', () => {
    const res = filterByLanguage(sampleStreams, ['pl'], null);
    const ids = res.map(s => s.id);
    assert.deepEqual(ids, [4]);
  });
});

test('Filter by Exclude Languages', async (t) => {
  const sampleStreams = [
    { id: 1, name: 'MovieWeb', title: 'Generic Movie 1080p' },
    { id: 2, name: 'VidZee', title: 'VidZee 1080p - English', language: 'English' },
    { id: 3, name: 'CastleTV [Hindi] | 1080p', title: 'Movie 1080p' },
    { id: 4, name: 'Polish [CDA]', title: '[PL Lektor] Test - 1080p', provider: 'polish' }
  ];

  await t.test('excludes specified language while preserving untagged and other streams', () => {
    const res = filterByLanguage(sampleStreams, null, ['hi', 'pl']);
    const ids = res.map(s => s.id);
    assert.ok(ids.includes(1));
    assert.ok(ids.includes(2));
    assert.ok(!ids.includes(3), 'Hindi excluded');
    assert.ok(!ids.includes(4), 'Polish excluded');
  });
});

test('applyFilters combined quality, codec and language filtering', async (t) => {
  const streams = [
    { title: 'Stream 1', quality: '1080p', codecs: ['H264'], language: 'English' },
    { title: 'Stream 2', quality: '720p', codecs: ['H264'], language: 'English' },
    { title: 'Stream 3', quality: '1080p', codecs: ['DV', 'HDR'], language: 'English' },
    { name: 'Polish', quality: '1080p', codecs: ['H264'], provider: 'polish', title: '[PL] Stream' }
  ];

  const res = applyFilters(streams, 'test', '1080p', { excludeDV: true }, ['en'], null);
  assert.equal(res.length, 1);
  assert.equal(res[0].title, 'Stream 1');
});
