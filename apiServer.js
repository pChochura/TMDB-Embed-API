require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
const { authenticate, issueSession, requireAuth, getSession, updatePassword, envPasswordConfigured } = require('./utils/auth');
const path = require('path');
const { listProviders, getProvider, getCookieStats } = require('./providers/registry');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { resolveImdbId, getDetails } = require('./utils/tmdb');
const { applyFilters } = require('./utils/streamFilters');
const { isFfmpegAvailable, streamRemux } = require('./utils/remux');
const { validateStream, validateStreams } = require('./utils/streamValidator');
const syncRouter = require('./routes/sync');
const { initDb } = require('./db');

const app = express();
app.set('trust proxy', 1);

// Always mount proxy routes so that whenever enableProxy is turned on (via config or admin panel),
// the /m3u8-proxy, /ts-proxy, and /sub-proxy endpoints are immediately functional without requiring a restart.
createProxyRoutes(app);
console.log('[startup] proxy routes mounted (/m3u8-proxy, /ts-proxy, /sub-proxy)');

// --- Simple In-Memory Rate Limiting for /auth/login ---
const loginAttempts = new Map(); // key: ip, value: { count, first, last, lockedUntil }
const MAX_ATTEMPTS_WINDOW = 5; // attempts allowed
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes window
const BASE_LOCK_MS = 5 * 60 * 1000; // 5 minutes base lock

function getClientIp(req){
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function recordLoginFailure(ip){
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry) {
    entry = { count:1, first: now, last: now, lockedUntil:0 };
    loginAttempts.set(ip, entry);
    return entry;
  }
  // Reset window if outside timeframe and not locked
  if (now - entry.first > WINDOW_MS && now > entry.lockedUntil) {
    entry.count = 1;
    entry.first = now;
  } else {
    entry.count++;
  }
  entry.last = now;
  if (entry.count > MAX_ATTEMPTS_WINDOW) {
    // Exponential backoff lock: base * 2^(count - limit)
    const over = entry.count - MAX_ATTEMPTS_WINDOW;
    const lockMs = BASE_LOCK_MS * Math.min(8, Math.pow(2, over-1));
    entry.lockedUntil = now + lockMs;
  }
  return entry;
}

function canAttempt(ip){
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed:true };
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed:false, retryAfter: Math.ceil((entry.lockedUntil - now)/1000) };
  }
  if (now - entry.first > WINDOW_MS) {
    // Window passed; reset
    loginAttempts.delete(ip);
    return { allowed:true };
  }
  return { allowed:true };
}

function recordLoginSuccess(ip){
  // On success clear state to avoid lingering count
  loginAttempts.delete(ip);
}

// Guard against premature process.exit from imported legacy modules, but allow controlled restarts
const realProcessExit = process.exit.bind(process);
let allowControlledExit = false;
process.exit = function(code){
  if (allowControlledExit) return realProcessExit(code);
  console.warn('[diagnostic] Intercepted process.exit with code', code, new Error('exit trace').stack);
  // keep process alive for debugging
};
setImmediate(()=>console.log('[diagnostic] post-start setImmediate fired'));
app.use(cors());
app.use(express.json());

// Global Authentication Middleware (API Key or HTTP Basic Auth)
const API_SECRET_KEY = process.env.API_SECRET_KEY || "";

function requireAuthentication(req, res, next) {
  // 1. Allow local loopback (internal container healthchecks & monitoring)
  const clientIp = req.ip || req.socket?.remoteAddress;
  if (clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1") {
    return next();
  }

  // 2. API Key header / bearer / query
  const authHeader = req.headers["authorization"];
  const incomingKey = req.headers["x-api-key"] ||
    (authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null) ||
    req.query?.apiKey ||
    req.query?.api_key;
  if (API_SECRET_KEY && incomingKey === API_SECRET_KEY) {
    return next();
  }

  // 3. Existing admin web session cookie
  const sess = getSession(req);
  if (sess) {
    req.user = sess.u;
    return next();
  }

  // 4. HTTP Basic Auth (admin / ADMIN_PASSWORD)
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const b64 = authHeader.slice(6).trim();
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx > 0) {
        const u = decoded.slice(0, colonIdx);
        const p = decoded.slice(colonIdx + 1);
        if (authenticate(u, p)) {
          req.user = u;
          return next();
        }
      }
    } catch (_) {}
  }

  // 5. Unauthenticated -> 401 with HTTP Auth challenge
  res.setHeader("WWW-Authenticate", 'Basic realm="TMDB Embed API"');
  if (req.path.startsWith("/api") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ success: false, error: "UNAUTHORIZED", message: "Valid API key or HTTP Auth required" });
  }
  return res.status(401).send("Unauthorized: API key or HTTP Auth required\n");
}

app.use(requireAuthentication);

// Auth & Preferences Sync API
app.use('/api', syncRouter);

// --- Auth Routes (login before static serving) ---
app.post('/auth/login', (req,res) => {
  const { username, password } = req.body || {};
  const ip = getClientIp(req);
  const attemptState = canAttempt(ip);
  if (!attemptState.allowed) {
    res.setHeader('Retry-After', String(attemptState.retryAfter));
    return res.status(429).json({ success:false, error:'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
  }
  if (!username || !password) return res.status(400).json({ success:false, error:'MISSING_CREDENTIALS' });
  if (!authenticate(username, password)) {
    const entry = recordLoginFailure(ip);
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now())/1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success:false, error:'LOCKED', retryAfter });
    }
    return res.status(401).json({ success:false, error:'INVALID_CREDENTIALS', remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count) });
  }
  recordLoginSuccess(ip);
  const token = issueSession(username);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12*60*60}`);
  res.json({ success:true, username });
});

app.post('/auth/logout', (req,res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ success:true });
});

app.get('/auth/session', (req,res) => {
  const sess = getSession(req);
  if (sess) return res.json({ authenticated:true, username: sess.u });
  if (req.user) return res.json({ authenticated:true, username: req.user });
  return res.json({ authenticated:false });
});

app.post('/auth/change-password', (req,res) => {
  const { username, oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ success:false, error:'MISSING_FIELDS' });
  const sess = getSession(req);
  const targetUser = sess?.u || username || 'admin';
  if (!authenticate(targetUser, oldPassword)) return res.status(401).json({ success:false, error:'INVALID_OLD_PASSWORD' });
  if (envPasswordConfigured) return res.status(409).json({ success:false, error:'PASSWORD_MANAGED_BY_ENVIRONMENT' });
  if (newPassword.length < 8) return res.status(400).json({ success:false, error:'PASSWORD_TOO_SHORT' });
  if (!updatePassword(targetUser, newPassword)) return res.status(500).json({ success:false, error:'UPDATE_FAILED' });
  res.json({ success:true, message:'PASSWORD_UPDATED' });
});

// Protect config panel (HTML) explicitly before static middleware
app.get('/config.html', (req,res,next) => {
  const sess = getSession(req);
  if (!sess) return res.redirect(302, '/');
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(process.cwd(),'public','config.html'));
});

// Explicit root handler for login page to ensure no-store
app.get('/', (req,res) => {
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(process.cwd(),'public','index.html'));
});

// Diagnostics for unexpected exits
process.on('beforeExit', (code) => {
  console.log('[diagnostic] beforeExit code=', code);
});
process.on('exit', (code) => {
  console.log('[diagnostic] exit code=', code);
});
process.on('uncaughtException', (err) => {
  console.error('[diagnostic] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[diagnostic] unhandledRejection', reason);
});
// Periodic heartbeat to confirm event loop activity (can be removed later)
let hbCount = 0;
setInterval(()=>{
  hbCount++;
  if (hbCount % 6 === 0) { // every 60s if interval is 10s
    console.log('[diagnostic] heartbeat 60s elapsed, process alive');
  }
}, 10_000).unref();


// --- Metrics (in-memory) ---
const metrics = {
  startTime: Date.now(),
  requestsTotal: 0,
  streamRequests: 0,
  providerCalls: {},
  lastRequestAt: null,
  lastError: null,
  streamsReturned: 0,
  tmdbToImdbLookups: 0
};

app.use((req,res,next)=>{ metrics.requestsTotal++; metrics.lastRequestAt = Date.now(); next(); });
// Serve static UI (login page at /)
app.use(express.static(path.join(process.cwd(),'public')));

// Config API
app.get('/api/config', requireAuth, (req,res) => {
  const fs = require('fs');
  let override = {};
  try { if (fs.existsSync(OVERRIDE_PATH)) override = JSON.parse(fs.readFileSync(OVERRIDE_PATH,'utf8')); } catch (e) {
    // ignore JSON parse or fs errors reading override; return base config
  }
  res.json({ success:true, merged: config, override, overridePath: OVERRIDE_PATH });
});
app.post('/api/config', requireAuth, (req,res) => {
  const patch = req.body || {};
  if (patch.port) {
    const p = Number(patch.port); if (!Number.isFinite(p) || p<=0 || p>65535) return res.status(400).json({ success:false, error:'INVALID_PORT'});
    patch.port = p;
  }
  if (patch.defaultProviders && !Array.isArray(patch.defaultProviders)) return res.status(400).json({ success:false, error:'DEFAULT_PROVIDERS_NOT_ARRAY'});
  const ok = saveConfigPatch(patch);
  res.json({ success: ok, merged: config });
});

// Restart endpoint (requires auth via session cookie on /config.html UI)
app.post('/api/restart', (req,res) => {
  const sess = getSession(req);
  if(!sess) return res.status(401).json({ success:false, error:'UNAUTHORIZED' });
  res.json({ success:true, message:'RESTARTING' });
  // Give the response a moment to flush
  setTimeout(()=>{
    try {
      const fs = require('fs');
      const restartMarker = require('path').join(process.cwd(), 'restart.trigger');
      fs.writeFileSync(restartMarker, String(Date.now()));
      console.warn('[control] wrote restart.trigger to notify nodemon');
    } catch (e) {
      console.warn('[control] failed to write restart marker:', e.message);
    }
    console.warn('[control] restarting process by exit(0)');
    // Let nodemon detect the file change and restart the app
    allowControlledExit = true;
    realProcessExit(0);
  }, 300);
});

// --- Basic informational endpoints ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'tmdb-embed-api', time: new Date().toISOString() });
});

// Metrics endpoint
app.get('/api/metrics', (req,res) => {
  res.json({
    uptimeSeconds: Math.round((Date.now()-metrics.startTime)/1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024),
    loadAvg: os.loadavg ? os.loadavg() : [],
    nodeVersion: process.version,
    configDefaults: {
      region: config.defaultRegion,
      providers: config.defaultProviders,
      minQualities: config.minQualities ? Object.keys(config.minQualities).length : 0,
      excludeCodecs: config.excludeCodecs ? Object.keys(config.excludeCodecs).filter(k=>config.excludeCodecs[k]).length : 0,
      allowedLanguages: config.allowedLanguages ? config.allowedLanguages.length : 0,
      febboxCookies: config.febboxCookies.length
    }
  });
});

// Consolidated status (metrics + providers + endpoints)
app.get('/api/status', (req,res) => {
  const endpoints = [
    'GET /api/health',
    'GET /api/metrics',
    'GET /api/status',
    'GET /api/providers',
    'GET /api/providers/:name',
    'GET /api/streams/:type/:tmdbId (optional ?stream=1)',
    'GET /api/streams/:provider/:type/:tmdbId',
    'GET /api/remux/mp4 (optional ?url=...&referer=...&download=1)',
    'POST /api/config',
    'GET /api/config',
    'POST /api/auth/register',
    'POST /api/auth/login',
    'GET /api/sync/pull',
    'POST /api/sync/push'
  ];
  // Determine cookie requirement heuristically (currently Showbox / PStream)
  const cookieRequiredProviders = new Set(['showbox']);
  const providers = listProviders().map(p => {
    const cookieRequired = cookieRequiredProviders.has(p.name);
    const cookieOk = !cookieRequired || (config.febboxCookies && config.febboxCookies.length > 0);
    return { name: p.name, enabled: p.enabled, cookieRequired, cookieOk };
  });
  res.json({ success:true, providerCheckTmdbId: config.providerCheckTmdbId, metrics: {
    uptimeSeconds: Math.round((Date.now()-metrics.startTime)/1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024)
  }, endpoints, providers });
});

// Providers list
app.get('/api/providers', (req,res) => {
  res.json({ success: true, providers: listProviders() });
});

// Debug environment/config endpoint (do not expose publicly in production)
app.get('/api/debug/env', requireAuth, (req,res) => {
  const cookieStats = getCookieStats ? getCookieStats() : null;
  res.json({
    port: config.port,
    defaultProviders: config.defaultProviders,
    febboxCookieCount: config.febboxCookies.length,
    showboxCacheDir: process.env.SHOWBOX_CACHE_DIR || '(os tmp)',
    nodeVersion: process.version,
    cookieStats
  });
});

// Single provider info
app.get('/api/providers/:name', (req,res) => {
  const p = getProvider(req.params.name);
  if (!p) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  res.json({ success:true, provider:{ name: p.name, enabled: p.enabled } });
});

// Aggregate streams across all enabled providers
app.get('/api/streams/:type/:tmdbId', async (req,res) => {
  const { type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  const streaming = req.query.stream === '1';
  const shouldValidate = req.query.validate === '1' || req.query.check === '1';
  const clientLang = (req.query.lang || req.query.language || '').trim() || null;
  let disconnected = false;
  let heartbeat;
  if (streaming) {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.on('close', () => { disconnected = true; clearInterval(heartbeat); });
    heartbeat = setInterval(() => {
      if (!disconnected) res.write(': keep-alive\n\n');
    }, 15000);
  }
  const sendEvent = (event, data) => {
    if (!disconnected && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const formatStreams = streams => {
    const allowedLangs = req.query.allowedLanguages
      ? req.query.allowedLanguages.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
      : (req.query.filterLang === '1' && clientLang)
      ? [clientLang]
      : config.allowedLanguages;
    let filtered = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs, allowedLangs, config.excludeLanguages);
    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      filtered = processStreamsForProxy(filtered, serverUrl);
      filtered = filtered.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }
    return filtered;
  };
  try {
    metrics.streamRequests++;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const [tmdbDetails, imdbId] = await Promise.all([
      getDetails(tmdbType, tmdbId, clientLang).catch(() => null),
      resolveImdbId(tmdbType, tmdbId).catch(() => null)
    ]);
    if (imdbId) metrics.tmdbToImdbLookups++;
    const expectedYear = tmdbDetails?.release_date
      ? parseInt(tmdbDetails.release_date.slice(0, 4), 10)
      : tmdbDetails?.first_air_date
      ? parseInt(tmdbDetails.first_air_date.slice(0, 4), 10)
      : null;
    const expectedRuntime = tmdbDetails?.runtime ||
      (Array.isArray(tmdbDetails?.episode_run_time) && tmdbDetails.episode_run_time[0]) ||
      null;
    const expectedTitle = tmdbDetails?.title || tmdbDetails?.name || null;
    const originalTitle = tmdbDetails?.original_title || tmdbDetails?.original_name || null;

    if (disconnected) return;
    let selectedProviders = (config.defaultProviders.length ? [...config.defaultProviders] : listProviders().map(p=>p.name));
    if (selectedProviders.includes('polish')) {
      selectedProviders = ['polish', ...selectedProviders.filter(p => p !== 'polish')];
    }
    const providerTimings = {};
    let streamedCount = 0;
    if (streaming) sendEvent('start', { tmdbId, imdbId });
    const results = await Promise.all(selectedProviders.map(async name => {
      const prov = getProvider(name);
      if (!prov || !prov.enabled) return [];
      metrics.providerCalls[name] = (metrics.providerCalls[name]||0)+1;
      let r;
      try {
        console.log(`[api] invoking provider ${name} for tmdbId=${tmdbId}`);
        const t0 = Date.now();
        r = await prov.fetch({
          tmdbId,
          type,
          season,
          episode,
          imdbId,
          title: expectedTitle,
          originalTitle,
          year: expectedYear,
          runtime: expectedRuntime,
          language: clientLang,
          details: tmdbDetails,
          filters:{}
        });
        providerTimings[name] = Date.now()-t0;
        console.log(`[api] provider ${name} returned ${Array.isArray(r)?r.length:0} streams`);
      } catch (e) {
        console.error(`[api] provider ${name} failed:`, e.message);
        providerTimings[name] = null;
        if (streaming) sendEvent('provider', { provider: name, durationMs: null, success: false, count: 0, streams: [] });
        return [];
      }
      if (streaming && !disconnected) {
        let streams = formatStreams(r);
        if (shouldValidate) {
          streams = await validateStreams(streams, { filterInvalid: true, expectedRuntimeMinutes: expectedRuntime });
        }
        streamedCount += streams.length;
        metrics.streamsReturned += streams.length;
        sendEvent('provider', { provider: name, durationMs: providerTimings[name], success: true, count: streams.length, streams });
      }
      return r;
    }));
    if (streaming) {
      if (!disconnected) {
        sendEvent('complete', { success: true, tmdbId, imdbId, count: streamedCount, providerTimings });
        res.end();
      }
      return;
    }
    let streams = formatStreams(results.flat());
    if (shouldValidate) {
      streams = await validateStreams(streams, { filterInvalid: true, expectedRuntimeMinutes: expectedRuntime });
    }
    streams.sort((a, b) => {
      const aPolish = (a.provider === 'polish' || (a.name && /polish/i.test(a.name))) ? 1 : 0;
      const bPolish = (b.provider === 'polish' || (b.name && /polish/i.test(b.name))) ? 1 : 0;
      return bPolish - aPolish;
    });
    metrics.streamsReturned += streams.length;
    res.json({ success:true, tmdbId, imdbId, count: streams.length, providerTimings, streams });
  } catch (e) {
    metrics.lastError = e.message;
    console.error('[api] aggregate streams error:', e.message);
    if (streaming) {
      sendEvent('error', { success: false, error: 'INTERNAL_ERROR' });
      if (!disconnected) res.end();
    } else res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  } finally {
    clearInterval(heartbeat);
  }
});

// Provider-specific streams
app.get('/api/streams/:provider/:type/:tmdbId', async (req,res) => {
  const { provider, type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  const clientLang = (req.query.lang || req.query.language || '').trim() || null;
  const prov = getProvider(provider);
  if (!prov) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  if (!prov.enabled) return res.status(503).json({ success:false, error:'PROVIDER_DISABLED' });
  try {
    metrics.streamRequests++;
    metrics.providerCalls[prov.name] = (metrics.providerCalls[prov.name]||0)+1;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    let tmdbDetails = null;
    try {
      tmdbDetails = await getDetails(tmdbType, tmdbId, clientLang);
    } catch {
      // ignore TMDB details error
    }
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const expectedYear = tmdbDetails?.release_date
      ? parseInt(tmdbDetails.release_date.slice(0, 4), 10)
      : tmdbDetails?.first_air_date
      ? parseInt(tmdbDetails.first_air_date.slice(0, 4), 10)
      : null;
    const expectedRuntime = tmdbDetails?.runtime ||
      (Array.isArray(tmdbDetails?.episode_run_time) && tmdbDetails.episode_run_time[0]) ||
      null;
    const expectedTitle = tmdbDetails?.title || tmdbDetails?.name || null;
    const originalTitle = tmdbDetails?.original_title || tmdbDetails?.original_name || null;

    const t0 = Date.now();
    let streams = await prov.fetch({
      tmdbId,
      type,
      season,
      episode,
      imdbId,
      title: expectedTitle,
      originalTitle,
      year: expectedYear,
      runtime: expectedRuntime,
      language: clientLang,
      filters:{}
    });
    const providerTimings = { [prov.name]: Date.now()-t0 };
    const allowedLangs = req.query.allowedLanguages
      ? req.query.allowedLanguages.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
      : (req.query.filterLang === '1' && clientLang)
      ? [clientLang]
      : config.allowedLanguages;
    streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs, allowedLangs, config.excludeLanguages);
    if (req.query.validate === '1' || req.query.check === '1') {
      streams = await validateStreams(streams, { filterInvalid: true, expectedRuntimeMinutes: expectedRuntime });
    }
    metrics.streamsReturned += streams.length;
    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
      streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }
    res.json({ success:true, provider: prov.name, tmdbId, imdbId, count: streams.length, providerTimings, streams });
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

// Validate reachability and check for premium / paywall blocks on a video link
app.all('/api/validate-stream', async (req, res) => {
  const url = req.query.url || req.body?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'MISSING_URL', message: 'Parameter "url" is required.' });
  }
  const headers = req.body?.headers || {};
  const validation = await validateStream({ url, headers });
  return res.json({ success: true, validation });
});

// Optional on-the-fly HLS-to-MP4 remuxing endpoint (pipes fragmented MP4 via ffmpeg when requested)
app.get('/api/remux/mp4', (req, res) => {
  const { url, referer, download, filename } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'MISSING_URL', message: 'Query parameter "url" is required.' });
  }
  if (!isFfmpegAvailable()) {
    return res.status(501).json({
      success: false,
      error: 'FFMPEG_UNAVAILABLE',
      message: 'FFmpeg is not installed or available on this system for on-the-fly MP4 remuxing.'
    });
  }
  return streamRemux(res, url, {
    download: download === '1' || download === 'true',
    filename: filename || 'stream.mp4',
    referer: referer || 'https://player.vidzee.wtf/'
  });
});

const PORT = config.port;
const HOST = process.env.BIND_HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`TMDB Embed REST API listening on http://${HOST}:${PORT}`);
  if (HOST !== 'localhost') {
    console.log(`Local access (if running on your machine): http://localhost:${PORT}`);
  }
  console.log('Endpoints:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/metrics');
  console.log('  GET  /api/providers');
  console.log('  GET  /api/streams/:type/:id');
  console.log('  POST /api/streams/:type/:id');
  console.log('  GET  /api/remux/mp4');
  console.log('  GET  /api/validate-stream?url=...');
  console.log('  POST /api/auth/register');
  console.log('  POST /api/auth/login');
  console.log('  GET  /api/sync/pull');
  console.log('  POST /api/sync/push');
  initDb().catch(err => console.error('[startup] Database initialization error:', err.message));
  if (!config.febboxCookies || config.febboxCookies.length === 0) {
    console.warn('[startup][warning] No FEBBOX_COOKIES configured. Showbox / PStream related streams may be unavailable. Set FEBBOX_COOKIES in your environment to enable these sources.');
  }
});

server.on('error', (err)=>{ console.error('[diagnostic] server error', err); });
