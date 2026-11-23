const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreCandidate, findBestMatch } = require('../utils/titleMatch');

test('titleMatch hard constraints and validation', async (t) => {
  await t.test('disqualifies candidate with mismatched season for TV series', () => {
    const query = {
      title: 'Breaking Bad',
      type: 'series',
      year: 2008,
      season: 2,
      episode: 5,
    };
    const candidate = {
      title: 'Breaking Bad',
      type: 'series',
      year: 2008,
      season: 1, // Season 1 instead of Season 2
      episode: 5,
    };
    const scored = scoreCandidate(query, candidate);
    assert.equal(scored.score, 0);
    assert.equal(scored.disqualified, true);
    assert.equal(scored.disqualificationReason, 'season_episode_mismatch');
  });

  await t.test('disqualifies candidate with mismatched episode for TV series', () => {
    const query = {
      title: 'Stranger Things',
      type: 'series',
      year: 2016,
      season: 1,
      episode: 3,
    };
    const candidate = {
      title: 'Stranger Things',
      type: 'series',
      year: 2016,
      season: 1,
      episode: 1, // Episode 1 instead of 3
    };
    const scored = scoreCandidate(query, candidate);
    assert.equal(scored.score, 0);
    assert.equal(scored.disqualified, true);
    assert.equal(scored.disqualificationReason, 'season_episode_mismatch');
  });

  await t.test('disqualifies movie candidate when release year differs by more than 1 year', () => {
    const query = {
      title: 'Gladiator',
      type: 'movie',
      year: 2024,
    };
    const candidate = {
      title: 'Gladiator',
      type: 'movie',
      year: 2000, // 2000 vs 2024
    };
    const scored = scoreCandidate(query, candidate);
    assert.equal(scored.score, 0);
    assert.equal(scored.disqualified, true);
    assert.equal(scored.disqualificationReason, 'year_mismatch');
  });

  await t.test('allows movie candidate within 1 year release date window', () => {
    const query = {
      title: 'Dune: Part Two',
      type: 'movie',
      year: 2024,
    };
    const candidate = {
      title: 'Dune: Part Two',
      type: 'movie',
      year: 2023, // 1 year diff allowed (festival vs wide theatrical)
    };
    const scored = scoreCandidate(query, candidate);
    assert.ok(scored.score > 0.6);
    assert.equal(scored.disqualified, false);
  });

  await t.test('disqualifies trailer or clip when full length runtime expected', () => {
    const query = {
      title: 'Avatar',
      type: 'movie',
      year: 2009,
      duration: 162 * 60, // 162 mins
    };
    const candidate = {
      title: 'Avatar Official Trailer',
      type: 'movie',
      year: 2009,
      duration: 150, // 2.5 minutes
    };
    const scored = scoreCandidate(query, candidate);
    assert.equal(scored.score, 0);
    assert.equal(scored.disqualified, true);
    assert.equal(scored.disqualificationReason, 'duration_mismatch');
  });

  await t.test('findBestMatch rejects all candidates if only mismatched ones exist', () => {
    const query = {
      title: 'Halloween',
      type: 'movie',
      year: 2018,
    };
    const candidates = [
      { title: 'Halloween', year: 1978, type: 'movie' },
      { title: 'Halloween II', year: 1981, type: 'movie' },
    ];
    const match = findBestMatch(query, candidates, { provider: 'test' });
    assert.equal(match.best, null);
  });
});
