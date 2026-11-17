const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const serverPath = path.join(__dirname, '..', 'apiServer.js');
const adminPassword = 'test-only-password';

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startServer(directory, password) {
  const port = await unusedPort();
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    API_PORT: String(port),
    BIND_HOST: '127.0.0.1',
    TMDB_API_KEY: 'test-only-key'
  };
  if (password !== undefined) env.ADMIN_PASSWORD = password;
  const child = spawn(process.execPath, [serverPath], { cwd: directory, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { child, base };
    } catch (error) {
      if (error.cause && error.cause.code !== 'ECONNREFUSED') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
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

test('public deployment protects config and supports persistent environment credentials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-deploy-test-'));
  fs.mkdirSync(path.join(directory, 'utils'));
  let running;
  try {
    running = await startServer(directory, adminPassword);
    const request = (route, options) => fetch(`${running.base}${route}`, options);
    assert.equal((await request('/api/health')).status, 200);
    assert.equal((await request('/api/config')).status, 401);
    assert.equal((await request('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await request('/api/debug/env')).status, 401);

    const login = async password => request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password })
    });
    assert.equal((await login('change-me')).status, 401);
    const response = await login(adminPassword);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const config = await request('/api/config', { headers: { Cookie: cookie } });
    assert.equal(config.status, 200);
    assert.deepEqual((await config.json()).merged.tmdbApiKeys, ['test-only-key']);
    const change = await request('/auth/change-password', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: adminPassword, newPassword: 'new-test-password' })
    });
    assert.equal(change.status, 409);
    assert.equal((await change.json()).error, 'PASSWORD_MANAGED_BY_ENVIRONMENT');
    await stopServer(running.child);
    running = await startServer(directory, adminPassword);
    assert.equal((await login(adminPassword)).status, 200);
    await stopServer(running.child);
    running = null;

    const invalid = spawnSync(process.execPath, [serverPath], {
      cwd: directory,
      env: { PATH: process.env.PATH, ADMIN_PASSWORD: '' },
      encoding: 'utf8'
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /ADMIN_PASSWORD must contain at least 8 characters/);

    running = await startServer(directory);
    assert.equal((await login('change-me')).status, 200);
  } finally {
    if (running) await stopServer(running.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
