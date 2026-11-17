const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

async function startServer({ proxy = false, empty = false, formatError = false } = {}) {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = fork(path.join(__dirname, 'fixtures', 'stream-server.js'), [], {
    env: { ...process.env, API_PORT: String(port), BIND_HOST: '127.0.0.1', TEST_PROXY: String(proxy),
      TEST_EMPTY: String(empty), TEST_FORMAT_ERROR: String(formatError) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server failed: ${errors}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; }
    catch (error) { if (error.cause && error.cause.code !== 'ECONNREFUSED') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Server did not start: ${errors}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function* events(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = frame.match(/^event: (.+)$/m);
        const data = frame.match(/^data: (.+)$/m);
        if (name && data) yield { event: name[1], data: JSON.parse(data[1]) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test('streams provider results before slow providers, preserving JSON behavior', { timeout: 15000 }, async () => {
  const { child, base } = await startServer();
  try {
    const invalid = await fetch(`${base}/api/streams/invalid/123?stream=1`);
    assert.equal(invalid.status, 400);
    const response = await fetch(`${base}/api/streams/series/123?season=1&episode=2&stream=1`);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const iterator = events(response.body);
    const received = [];
    while (!received.some(event => event.event === 'provider' && event.data.provider === 'fast')) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      received.push(next.value);
    }
    assert.equal(received[0].event, 'start');
    assert.equal(received[0].data.imdbId, 'tt123');
    const fast = received.find(event => event.data.provider === 'fast');
    assert.equal(fast.data.count, 1);
    assert.equal(fast.data.streams[0].quality, '1080p');
    assert.ok(!received.some(event => event.event === 'complete' || event.data.provider === 'slow'));
    child.send('release');
    for await (const event of iterator) received.push(event);
    const slow = received.find(event => event.data.provider === 'slow');
    const failed = received.find(event => event.data.provider === 'failed');
    const complete = received.find(event => event.event === 'complete');
    assert.equal(slow.data.count, 1);
    assert.equal(failed.data.success, false);
    assert.equal(failed.data.durationMs, null);
    assert.equal(complete.data.count, 2);
    assert.deepEqual(Object.keys(complete.data.providerTimings).sort(), ['failed', 'fast', 'slow']);
    assert.ok(!received.some(event => event.data.provider === 'disabled'));

    const slowStarted = new Promise(resolve => {
      const onMessage = message => {
        if (message.event === 'slow-start' && message.call === 2) {
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
    });
    const jsonPromise = fetch(`${base}/api/streams/movie/123`);
    await slowStarted;
    child.send('release');
    const json = await (await jsonPromise).json();
    assert.equal(json.success, true);
    assert.equal(json.count, 2);
    assert.deepEqual(json.streams.map(stream => stream.quality), ['720p', '1080p']);
    assert.equal(json.providerTimings.failed, null);
  } finally {
    await stopServer(child);
  }
});

test('streams proxy URLs without exposing upstream headers', { timeout: 15000 }, async () => {
  const { child, base } = await startServer({ proxy: true });
  try {
    const response = await fetch(`${base}/api/streams/movie/123?stream=1`);
    const received = [];
    for await (const event of events(response.body)) {
      received.push(event);
      if (event.event === 'provider' && event.data.provider === 'fast') child.send('release');
    }
    const streams = received.filter(event => event.event === 'provider').flatMap(event => event.data.streams);
    assert.equal(streams.length, 2);
    assert.match(streams.find(s => s.quality === '1080p').url, /\/m3u8-proxy\?/);
    assert.match(streams.find(s => s.quality === '720p').url, /\/ts-proxy\?/);
    assert.ok(streams.every(s => !('headers' in s)));
  } finally {
    await stopServer(child);
  }
});

test('completes even when no selected providers are enabled', { timeout: 15000 }, async () => {
  const { child, base } = await startServer({ empty: true });
  try {
    const response = await fetch(`${base}/api/streams/movie/123?stream=1`);
    const received = [];
    for await (const event of events(response.body)) received.push(event);
    assert.deepEqual(received.map(event => event.event), ['start', 'complete']);
    assert.equal(received[1].data.count, 0);
    assert.deepEqual(received[1].data.providerTimings, {});
  } finally {
    await stopServer(child);
  }
});

test('reports fatal errors as an SSE error event', { timeout: 15000 }, async () => {
  const { child, base } = await startServer({ formatError: true });
  try {
    const response = await fetch(`${base}/api/streams/movie/123?stream=1`);
    const received = [];
    for await (const event of events(response.body)) received.push(event);
    assert.equal(received[0].event, 'start');
    assert.equal(received.at(-1).event, 'error');
    assert.deepEqual(received.at(-1).data, { success: false, error: 'INTERNAL_ERROR' });
    assert.ok(!received.some(event => event.event === 'complete'));
    child.send('release');
  } finally {
    await stopServer(child);
  }
});
