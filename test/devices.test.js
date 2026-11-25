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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-devices-test-'));
  const env = {
    ...process.env,
    API_PORT: String(port),
    BIND_HOST: '127.0.0.1',
    DATABASE_DRIVER: 'sqlite',
    SQLITE_DB_PATH: ':memory:',
    USER_CONFIG_PATH: path.join(tempDir, 'user-config.json'),
    SYNC_JWT_SECRET: 'test_jwt_secret_devices_12345',
    NODE_ENV: 'test',
    TMDB_API_KEY: 'test-key',
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

test('Cross-Device Playback & SSE Signaling Contract', async (t) => {
  const { child, base } = await startServer();

  try {
    // 1. Register a user to obtain an auth token
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'devicetester', password: 'password123' }),
    });
    const regData = await regRes.json();
    assert.equal(regRes.status, 200);
    assert.equal(regData.success, true);
    const token = regData.token;
    assert.ok(token);

    // 2. Reject unauthenticated device requests
    const unauthRes = await fetch(`${base}/api/devices`);
    assert.equal(unauthRes.status, 401);

    // 3. Register / heartbeat an Android TV device
    const hbRes = await fetch(`${base}/api/devices/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        deviceId: 'tv-device-salon-123',
        deviceName: 'Salon (Sony BRAVIA 4K)',
        platform: 'android_tv',
        appVersion: '2.33',
      }),
    });
    assert.equal(hbRes.status, 200);
    const hbData = await hbRes.json();
    assert.equal(hbData.success, true);
    assert.ok(hbData.timestamp > 0);

    // 4. List devices -> should return the registered TV
    const listRes = await fetch(`${base}/api/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.success, true);
    assert.equal(listData.devices.length, 1);
    assert.equal(listData.devices[0].deviceId, 'tv-device-salon-123');
    assert.equal(listData.devices[0].deviceName, 'Salon (Sony BRAVIA 4K)');
    assert.equal(listData.devices[0].isOnline, true);

    // 5. Connect SSE stream for the Android TV
    const abortController = new AbortController();
    const sseResponse = await fetch(`${base}/api/devices/events?deviceId=tv-device-salon-123`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abortController.signal,
    });
    assert.equal(sseResponse.status, 200);
    assert.equal(sseResponse.headers.get('content-type'), 'text/event-stream');

    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();

    // Read handshake
    const firstChunk = await reader.read();
    const handshakeText = decoder.decode(firstChunk.value);
    assert.ok(handshakeText.includes('event: connected'));
    assert.ok(handshakeText.includes('tv-device-salon-123'));

    // 6. Web app sends play command to this device
    const playRes = await fetch(`${base}/api/devices/tv-device-salon-123/play`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: 'movie_603',
        episodeUrl: null,
        title: 'The Matrix',
        progressMs: 125000,
        autoPlay: true,
      }),
    });
    assert.equal(playRes.status, 200);
    const playData = await playRes.json();
    assert.equal(playData.success, true);

    // 7. Verify TV receives the SSE play event
    const playChunk = await reader.read();
    const playEventText = decoder.decode(playChunk.value);
    assert.ok(playEventText.includes('event: play'));
    assert.ok(playEventText.includes('movie_603'));
    assert.ok(playEventText.includes('125000'));

    abortController.abort();
  } finally {
    await stopServer(child);
  }
});
