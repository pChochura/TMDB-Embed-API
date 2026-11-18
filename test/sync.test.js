const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const serverPath = path.join(__dirname, '..', 'apiServer.js');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function startServer() {
  const port = await unusedPort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-sync-test-'));
  const env = {
    ...process.env,
    API_PORT: String(port),
    BIND_HOST: '127.0.0.1',
    DATABASE_DRIVER: 'sqlite',
    SQLITE_DB_PATH: ':memory:',
    USER_CONFIG_PATH: path.join(tempDir, 'user-config.json'),
    SYNC_JWT_SECRET: 'test_jwt_secret_key_12345',
    NODE_ENV: 'test',
    TMDB_API_KEY: 'test-key'
  };
  const child = spawn(process.execPath, [serverPath], { cwd: tempDir, env, stdio: 'pipe' });
  const base = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited prematurely with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { child, base };
    } catch (e) {
      // wait until server is listening
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('Server did not become ready');
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('Auth & Preferences Sync API Endpoints Contract', async (t) => {
  const { child, base } = await startServer();

  t.after(async () => {
    await stopServer(child);
  });

  let userToken = null;
  let userId = null;

  await t.test('POST /api/auth/register validation and success', async () => {
    // Missing credentials
    const badRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '' })
    });
    assert.equal(badRes.status, 400);
    const badBody = await badRes.json();
    assert.equal(badBody.success, false);
    assert.equal(badBody.token, null);
    assert.equal(badBody.user, null);

    // Valid registration
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JaneDoe', password: 'secretpassword123' })
    });
    assert.equal(regRes.status, 200);
    const regBody = await regRes.json();
    assert.equal(regBody.success, true);
    assert.ok(regBody.token);
    assert.ok(regBody.user);
    assert.equal(regBody.user.username, 'janedoe');
    assert.ok(regBody.user.id.startsWith('usr_'));
    assert.equal(regBody.message, null);

    userToken = regBody.token;
    userId = regBody.user.id;

    // Duplicate username conflict
    const dupRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'janedoe', password: 'anotherpassword' })
    });
    assert.equal(dupRes.status, 409);
    const dupBody = await dupRes.json();
    assert.equal(dupBody.success, false);
    assert.equal(dupBody.token, null);
    assert.equal(dupBody.message, 'Username is already taken');
  });

  await t.test('POST /api/auth/login validation and success', async () => {
    // Wrong password
    const failRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'janedoe', password: 'wrongpassword' })
    });
    assert.equal(failRes.status, 401);
    const failBody = await failRes.json();
    assert.equal(failBody.success, false);
    assert.equal(failBody.token, null);
    assert.equal(failBody.message, 'Invalid username or password');

    // Successful login (case-insensitive username)
    const okRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'JANEDOE', password: 'secretpassword123' })
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.success, true);
    assert.ok(okBody.token);
    assert.equal(okBody.user.id, userId);
    assert.equal(okBody.user.username, 'janedoe');
  });

  await t.test('Sync endpoints require authentication', async () => {
    // Missing token
    const noAuth = await fetch(`${base}/api/sync/pull`);
    assert.equal(noAuth.status, 401);
    const noAuthBody = await noAuth.json();
    assert.equal(noAuthBody.success, false);
    assert.equal(noAuthBody.message, 'Missing auth token');

    // Invalid token
    const badToken = await fetch(`${base}/api/sync/pull`, {
      headers: { Authorization: 'Bearer invalid.token.value' }
    });
    assert.equal(badToken.status, 401);
    const badTokenBody = await badToken.json();
    assert.equal(badTokenBody.success, false);
    assert.equal(badTokenBody.message, 'Invalid or expired token');
  });

  await t.test('POST /api/sync/push and GET /api/sync/pull full cycle', async () => {
    const pushPayload = {
      clientTimestamp: 1716000950000,
      progress: [
        {
          url: 'tv_1399_1_1',
          parentUrl: 'tv_1399',
          progressPercentage: 0.85,
          progressMs: 2850000,
          posterUrl: 'https://image.tmdb.org/t/p/w500/test.jpg',
          titlePl: 'Gra o Tron',
          season: 1,
          episode: 1,
          seriesTitle: 'Gra o Tron',
          episodeTitle: 'Winter Is Coming',
          isWatched: false,
          updatedAt: 1716000920000
        }
      ],
      watchlist: [
        {
          url: 'movie_550',
          titlePl: 'Podziemny krąg',
          posterUrl: 'https://image.tmdb.org/t/p/w500/fightclub.jpg',
          backgroundUrl: 'https://image.tmdb.org/t/p/w1280/bg.jpg',
          isTvShow: false,
          year: 1999,
          isDeleted: false,
          updatedAt: 1716000800000
        }
      ],
      favorites: [
        {
          url: 'tv_1399',
          titlePl: 'Gra o Tron',
          posterUrl: 'https://image.tmdb.org/t/p/w500/got.jpg',
          backgroundUrl: 'https://image.tmdb.org/t/p/w1280/got_bg.jpg',
          isTvShow: true,
          year: 2011,
          isDeleted: false,
          updatedAt: 1716000850000
        }
      ],
      preferences: {
        preferred_quality: '1080p',
        autoplay_next: 'true',
        lektor_voice: 'meski',
        lektor_ducking_volume: '0.3'
      }
    };

    // Push data
    const pushRes = await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify(pushPayload)
    });
    assert.equal(pushRes.status, 200);
    const pushBody = await pushRes.json();
    assert.equal(pushBody.success, true);
    assert.ok(pushBody.serverTimestamp > 0);
    assert.equal(pushBody.message, null);

    // Pull data with since=0
    const pullRes = await fetch(`${base}/api/sync/pull?since=0`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert.equal(pullRes.status, 200);
    const pullBody = await pullRes.json();
    assert.ok(pullBody.serverTimestamp > 0);

    // Check progress
    assert.equal(pullBody.progress.length, 1);
    const p = pullBody.progress[0];
    assert.equal(p.url, 'tv_1399_1_1');
    assert.equal(p.parentUrl, 'tv_1399');
    assert.equal(p.progressPercentage, 0.85);
    assert.equal(p.progressMs, 2850000);
    assert.equal(p.titlePl, 'Gra o Tron');
    assert.equal(p.season, 1);
    assert.equal(p.episode, 1);
    assert.equal(p.seriesTitle, 'Gra o Tron');
    assert.equal(p.episodeTitle, 'Winter Is Coming');
    assert.equal(p.isWatched, false);
    assert.equal(p.updatedAt, 1716000920000);

    // Check watchlist
    assert.equal(pullBody.watchlist.length, 1);
    const w = pullBody.watchlist[0];
    assert.equal(w.url, 'movie_550');
    assert.equal(w.titlePl, 'Podziemny krąg');
    assert.equal(w.isTvShow, false);
    assert.equal(w.year, 1999);
    assert.equal(w.isDeleted, false);
    assert.equal(w.updatedAt, 1716000800000);

    // Check favorites
    assert.equal(pullBody.favorites.length, 1);
    const f = pullBody.favorites[0];
    assert.equal(f.url, 'tv_1399');
    assert.equal(f.isTvShow, true);
    assert.equal(f.year, 2011);
    assert.equal(f.isDeleted, false);

    // Check preferences
    assert.equal(pullBody.preferences.preferred_quality, '1080p');
    assert.equal(pullBody.preferences.autoplay_next, 'true');
    assert.equal(pullBody.preferences.lektor_voice, 'meski');
    assert.equal(pullBody.preferences.lektor_ducking_volume, '0.3');

    // Pull with since filter greater than updatedAt
    const filteredPull = await fetch(`${base}/api/sync/pull?since=1716000925000`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    const filteredBody = await filteredPull.json();
    assert.equal(filteredBody.progress.length, 0);
    assert.equal(filteredBody.watchlist.length, 0);
  });

  await t.test('Last-Write-Wins (LWW) conflict handling', async () => {
    // 1. Try to push an older progress update (updatedAt = 1000000000000 < 1716000920000)
    await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        progress: [
          {
            url: 'tv_1399_1_1',
            progressPercentage: 0.1,
            progressMs: 1000,
            isWatched: false,
            updatedAt: 1000000000000
          }
        ]
      })
    });

    // Pull to verify old update was ignored
    const pull1 = await (await fetch(`${base}/api/sync/pull?since=0`, {
      headers: { Authorization: `Bearer ${userToken}` }
    })).json();
    assert.equal(pull1.progress[0].progressPercentage, 0.85);
    assert.equal(pull1.progress[0].updatedAt, 1716000920000);

    // 2. Push a newer progress update (updatedAt = 1716000999000 > 1716000920000)
    await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        progress: [
          {
            url: 'tv_1399_1_1',
            progressPercentage: 1.0,
            progressMs: 3400000,
            isWatched: true,
            updatedAt: 1716000999000
          }
        ]
      })
    });

    // Pull to verify newer update was applied
    const pull2 = await (await fetch(`${base}/api/sync/pull?since=0`, {
      headers: { Authorization: `Bearer ${userToken}` }
    })).json();
    assert.equal(pull2.progress[0].progressPercentage, 1.0);
    assert.equal(pull2.progress[0].isWatched, true);
    assert.equal(pull2.progress[0].updatedAt, 1716000999000);
  });
});
