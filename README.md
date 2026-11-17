# 🍿 TMDB Embed API

> Modern, configurable streaming metadata + source aggregation API with a secure admin panel and multi-key TMDB rotation.

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20.18.1%2B-brightgreen?style=flat" />
  <img src="https://img.shields.io/badge/Status-Active-success?style=flat" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" />
  <img src="https://img.shields.io/badge/Version-1.3.0-informational?style=flat" />
  <img src="https://img.shields.io/docker/pulls/inside4ndroid/tmdb-embed-api?label=Docker%20Pulls&style=flat" />
</p>

---

## 📸 Screenshots
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 174931.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175002.png" width="46%" />
</p>
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 175008.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175013.png" width="46%" />
</p>
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 175020.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175026.png" width="46%" />
</p>
<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 175033.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175040.png" width="46%" />
</p>

---

## ✨ Features
- **15 Built-in Providers** – Showbox/FebBox, 4KHDHub, VixSrc, Videasy, Vidlink, DahmerMovies, StreamFlix, VaPlayer, CastleTV, HDGharTV, NetMirror, OneTouchTV, ZXCStreams, Cinezo and Hexa — with per-provider enable toggles + default selection.
- **Multi-TMDB Key Rotation** – Supply multiple API keys; one is chosen randomly per request.
- **🔥 Plugin System** – Drop new provider files in `providers/` and add its exported function to the registry map (`providers/registry.js` → `providerFunctionMap`). No core file edits required.
- **Dynamic Filtering** – Minimum quality presets, custom JSON quality map, codec exclusion rules (presets + JSON).
- **Runtime Overrides UI** – Fully interactive web admin at `/config.html` (login protected) writing to `utils/user-config.json`.
- **Session Auth + Rate Limiting** – Login system with brute-force lockouts, logout, and password change.
- **Status & Health Panel** – Live metrics, provider status, endpoint list, and per-provider functional checks (configurable check title via TMDB ID).
- **Config Propagation** – Overrides mirrored to `process.env` for legacy compatibility (no `.env` required after first save).
- **Back-Navigation Safe** – Cache-control + visibility/session revalidation.
- **Optional Stream Proxy Layer** – When enabled, rewrites returned stream URLs so HLS playlists, TS segments, and subtitles are served through internal endpoints (`/m3u8-proxy`, `/ts-proxy`, `/sub-proxy`) allowing uniform headers, origin shielding, and optional segment caching.
  When active the API omits per-stream `headers` objects from responses (they're no longer needed by clients) to avoid leaking upstream header requirements.

  Proxy Tuning Parameters (query flags accepted by `/ts-proxy` – defaults shown):
  - `clampOpen` (on) – If a client sends an ambiguous `Range: bytes=0-`, constrain it to an initial window of `openChunkKB` (default 4096 KB) to avoid huge first reads.
  - `openChunkKB=4096` – Size (KB) used for both clamp window and each progressive expansion increment.
  - `progressiveOpen` (on) – Grow successive ambiguous head requests (`bytes=0-`) incrementally instead of one large span. Maintains a per-URL expansion map.
  - `initChunkKB=512` – Size used for a synthetic initial partial (206) when no client range is provided and progressive growth is disabled. Capped 64–2048 KB.
  - `noSynth=1` – Disable synthetic initial partial generation (forces pass-through behavior).
  - `force200=1` – Normalize upstream 206 responses to 200 (diagnostics / edge player testing).
  - `tailPrefetch` (on) – Enable asynchronous tail fetch of the file's last bytes to satisfy rapid player tail probes.
  - `tailPrefetchKB=256` – Tail window size (64–2048 KB). Cached in memory with TTL cleanup.
  Behavior Notes:
  - Synthetic partials auto-disable when `progressiveOpen` is active (real progressive ranges preferred).
  - Player tail probes (e.g., VLC metadata scans) are accelerated by the cached tail window.
  - Forced 200 mode strips `Content-Range` to emulate full responses for troubleshooting.
  - Host Overrides: `pixeldrain.*` and `video-downloads.googleusercontent.com` URLs are routed through `/ts-proxy` regardless of extension to ensure correct range + MIME handling.

---

## 📦 Quick Start
```bash
# 1. Install dependencies
npm install

# 2. (Optional) Copy example env if you want an initial TMDB key
cp .env.example .env   # then edit TMDB_API_KEY=

# 3. Start API with automatic restarts (recommended for local dev)
npm start

# Or production-style single run
# node apiServer.js

# 4. Open the Admin UI (login page) in browser
http://localhost:8787/

# 5. Health check
curl http://localhost:8787/api/health
```

**Default credentials (first run):** `admin` / `change-me` — **change them immediately** from the dashboard or via `POST /auth/change-password`.

---

## 🐳 Docker Usage

### Pull & Run (Fastest)
If you just want to run it (no building):
```bash
docker pull inside4ndroid/tmdb-embed-api:latest
docker run --name tmdb-embed-api -p 8787:8787 \
  -e TMDB_API_KEY=YOUR_TMDB_KEY \
  inside4ndroid/tmdb-embed-api:latest
```

Or the minimal quick-test run:
```bash
docker run -it -p 8787:8787 inside4ndroid/tmdb-embed-api:latest
```

Persist overrides (Windows PowerShell example) by mounting a local file:
```powershell
New-Item -ItemType File -Path .\utils\user-config.json -Force | Out-Null
docker run --name tmdb-embed-api -p 8787:8787 `
  -e TMDB_API_KEY=YOUR_TMDB_KEY `
  -v ${PWD}/utils/user-config.json:/app/utils/user-config.json `
  inside4ndroid/tmdb-embed-api:latest
```

### Build Locally
```bash
docker build -t tmdb-embed-api .
docker run --name tmdb-embed -p 8787:8787 \
  -e TMDB_API_KEY=YOUR_TMDB_KEY \
  -v "$(pwd)/utils/user-config.json:/app/utils/user-config.json" \
  tmdb-embed-api
```

After first login + save, the UI writes overrides into the mounted `user-config.json` so they persist across container restarts.

### Free Render deployment

The included [Render Blueprint](./render.yaml) creates a free Docker web service
and disables Render's automatic deployments so that GitHub Actions controls
deployments instead.

1. Push this repository, including `render.yaml` and the deploy workflow, to
   the GitHub repository's `main` branch.
2. In [Render](https://dashboard.render.com/), create a **Blueprint** and
   connect that repository. Confirm the free instance and provide a TMDB API
   key when prompted. The first deployment is started by Render.
3. In the service's **Environment** settings, reveal the generated
   `ADMIN_PASSWORD`. Sign in as `admin` with that value. To change it, update
   the environment variable in Render; password changes in the UI are disabled
   while this variable is set. Never commit or share the password.
4. Copy the secret **Deploy Hook** from the service's **Settings** tab. In the
   GitHub repository, open **Settings → Secrets and variables → Actions** and
   add it as the repository secret `RENDER_DEPLOY_HOOK_URL`.
5. Subsequent pushes to `main` run [Deploy to Render](./.github/workflows/deploy-render.yml).
   The workflow runs deployment authentication and streaming tests, then triggers the hook.
   The GitHub job confirms that Render accepted the request; check the Render
   dashboard for the actual build, deployment and health status. You can also
   run the workflow manually from the Actions tab.

Render's free service spins down after 15 minutes without traffic, takes about
one minute to wake, and has an ephemeral filesystem. Dashboard configuration,
passwords changed without `ADMIN_PASSWORD`, caches, and sessions are lost on
restart, redeploy or spin-down. Configure persistent settings using Render
environment variables instead. The free instance has limited CPU and 512 MB
RAM; the browser-backed providers are disabled by default and may exceed those
resources. Render's free usage limits include outbound bandwidth and build
minutes; check [Render's free-tier terms](https://render.com/docs/free) for
current limits and possible overage charges.

The streaming endpoints are public. Keep `ENABLE_PROXY` disabled on an
internet-facing deployment unless access to the proxy endpoints is separately
restricted: they accept arbitrary target URLs. The config and debug endpoints
require an authenticated admin session.

### docker-compose
An example `docker-compose.yml` is included (healthcheck + `restart: unless-stopped`). Start with:
```bash
docker compose up -d --build
```
Environment variables can be supplied via a `.env` file in the same directory (Compose automatically loads it). Example `.env`:
```
TMDB_API_KEY=first_key
```

To stop & remove:
```bash
docker compose down
```

### Switching to Multiple TMDB Keys
Either set `TMDB_API_KEYS` to a JSON array string:
```bash
docker run -p 8787:8787 \
  -e TMDB_API_KEYS='["KEY1","KEY2","KEY3"]' \
  tmdb-embed-api
```
or add / remove keys inside the Admin UI (Keys panel) and save.

If both `TMDB_API_KEY` and `TMDB_API_KEYS` are provided, rotation uses the array. Clearing the array in the UI also clears the legacy key.

### Key Environment Variables
| Variable | Purpose | Notes |
|----------|---------|-------|
| `API_PORT` | Port the server listens on | Defaults to `8787` |
| `BIND_HOST` | Interface to bind | Defaults to `0.0.0.0` |
| `ADMIN_PASSWORD` | Admin password managed by the environment | At least 8 characters; disables UI password changes |
| `TMDB_API_KEY` | Single TMDB key (legacy) | Use if you only have one key |
| `TMDB_API_KEYS` | JSON array of keys | Overrides single key when present |
| `DEFAULT_PROVIDERS` | Comma-separated default providers | Used by the aggregate endpoint |
| `DEFAULT_REGION` / `FEBBOX_REGION` | Default region | Passed through for legacy compat |
| `MIN_QUALITIES` | Min quality setting / JSON | Mirrored to the config model |
| `EXCLUDE_CODECS` | Codec exclusion JSON | e.g. `{"excludeDV":true}` |
| `FEBBOX_COOKIES` | FebBox JWT cookie(s) | Comma-separated; required for Showbox |
| `ENABLE_<PROVIDER>_PROVIDER` | Per-provider enable flags | e.g. `ENABLE_4KHDHUB_PROVIDER=true` |
| `DISABLE_CACHE` | Disable internal caches | `true`/`false` |
| `ENABLE_PSTREAM_API` | PStream API flag | Default `true` |
| `DISABLE_URL_VALIDATION` | Skip general URL checks | Default `false` |
| `DISABLE_4KHDHUB_URL_VALIDATION` | Skip 4khdhub URL checks | Default `false` |
| `ENABLE_PROXY` | Mount proxy routes | Default `false` |
| `PROVIDER_CHECK_TMDB_ID` | Title for dashboard functional checks | Default `278` |
| `SHOWBOX_CACHE_DIR` | Custom Showbox cache directory | Optional |
| `NETMIRROR_API_BASE` | NetMirror embed base URL | Optional override |
| `NETMIRROR_STREAM_REFERER` | NetMirror stream Referer header | Optional override |

### Updating the Image
```bash
docker compose pull   # if using an external registry (future)
docker compose up -d --build
```

### Restart from Admin UI
The Admin panel includes a Restart Server control.
- Local (nodemon): the backend writes a `restart.trigger` file and exits; nodemon detects the change and restarts automatically.
- Docker Compose: the container exits and is restarted by `restart: unless-stopped`.

### Healthcheck
Container health relies on `GET /api/health`. If you disable or modify that route, adjust the Dockerfile / compose healthcheck accordingly.

---

## 🔐 Authentication
The root (`/`) serves the login page. After successful login a session cookie (`session`) is issued (HttpOnly; 12h lifetime). All admin pages (e.g. `config.html`) require an active session.

Credentials are stored in `utils/auth-users.json` (auto-created on first run with `admin` / `change-me`). Passwords are hashed with PBKDF2-SHA512 (100,000 iterations, random salt). There is no `PASSWORD_HASH` / `ADMIN_USERNAME` environment override — manage users directly in this file or via the change-password endpoint.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/login` | POST | Authenticate (JSON: `{ username, password }`) |
| `/auth/logout` | POST | Destroy session |
| `/auth/session` | GET | Check session status |
| `/auth/change-password` | POST | Update password (requires session) |

Repeated failed logins trigger escalating lockouts (`Retry-After` header emitted; 5 attempts per window).

---

## 🛠 Configuration Model
All runtime state collapses into a *merged* object displayed in the UI (Live Config panel). Source order:
1. Initial environment variables / optional `.env`
2. JSON overrides: `utils/user-config.json`

Saving in the UI writes only changed keys. Setting a field to empty removes the override (reverting to env/default). Removing all TMDB keys (and saving) clears `tmdbApiKeys` and the legacy `tmdbApiKey`.

**Override File:** `utils/user-config.json`
```json
{
  "defaultProviders": ["4khdhub"],
  "tmdbApiKeys": ["KEY_A","KEY_B"],
  "enable4khdhubProvider": true,
  "providerCheckTmdbId": "278"
}
```

---

## 🎛 Admin UI Sections
| Panel | Summary |
|-------|---------|
| Core | Port, default providers, default region |
| Quality / Filters | Min quality presets & codec exclusion JSON |
| Keys | Add/remove TMDB API keys (rotated randomly) |
| Advanced | Provider toggles, cache & validation flags |
| Server Status | Live metrics, provider functional checks |
| Live Config | View merged + override JSON snapshots |

Session is revalidated on visibility and back/forward navigation to prevent stale access.

---

## 🔌 Providers
The API supports a plugin system. Drop a new provider file in the `providers/` folder and register its exported function in `providers/registry.js` under `providerFunctionMap`.

### Current Built-in Providers
- `showbox` - Showbox/FebBox streams (requires FebBox JWT cookie)
- `4khdhub` - 4KHDHub streams
- `vixsrc` - VixSrc streams
- `videasy` - Videasy streams (10 servers via enc-dec.app)
- `vidlink` - Vidlink streams
- `dahmermovies` - DahmerMovies streams (direct file links)
- `streamflix` - StreamFlix streams (direct MP4 links)
- `vaplayer` - VaPlayer streams (HLS via IMDb ID)
- `castletv` - CastleTV streams (AES-128 encrypted API)
- `hdghartv` - HDGharTV streams (title-matched search + IMDb verification)
- `netmirror` - NetMirror streams (Netflix direct + NewTV platform fallback)
- `onetouchtv` - OneTouchTV streams (AES-256 encrypted API)
- `zxcstreams` - ZXCStreams streams (multi-server backend, dynamic domain discovery)
- `cinezo` - Cinezo player streams (browser required; disabled by default)
- `hexa` - Hexa player streams (browser required; disabled by default)

Providers that rely on title resolution against TMDB (`castletv`, `hdghartv`, `onetouchtv`, `zxcstreams`, `vaplayer`, `netmirror`) require at least one TMDB API key configured.

Cinezo and Hexa use a headless Chromium browser to detect successful HLS or MP4
playback requests. Enable them in the provider settings or with
`ENABLE_CINEZO_PROVIDER=true` and `ENABLE_HEXA_PROVIDER=true` (saved settings
take precedence). They are disabled by default because browser extraction is
resource-intensive and may be blocked by verification challenges or upstream
access restrictions. The Docker image includes Chromium; for local installations,
install Chromium or Chrome and set `BROWSER_EXECUTABLE_PATH` if it is not in a
standard location. Chromium's sandbox must be available in the runtime.
Docker's default seccomp profile can block Chromium's sandbox; use a container
seccomp profile that permits the required user-namespace operations rather than
disabling the Chromium sandbox. See the [Playwright Docker guidance](https://playwright.dev/docs/docker#crawling-and-scraping).
Up to two extractions run at once; each waits up to 25 seconds for a stream.
Live availability depends on the sites and no bypass of verification is provided.

### Adding a New Provider
1. **Create** `providers/yourprovider.js` with your stream fetching logic
2. **Export** a function like `getYourproviderStreams(tmdbId, mediaType, season, episode)`
3. **Register** it in `providers/registry.js` → `providerFunctionMap`:
   ```js
   // providers/registry.js
   const providerFunctionMap = {
     'Showbox.js': 'getStreamsFromTmdbId',
     '4khdhub.js': 'get4KHDHubStreams',
     'vixsrc.js': 'getVixsrcStreams',
     'videasy.js': 'getVideasyStreams',
     'vidlink.js': 'getVidlinkStreams',
     'dahmermovies.js': 'getDahmermoviesStreams',
     'streamflix.js': 'getStreamflixStreams',
     'vaplayer.js': 'getVaplayerStreams',
     'castletv.js': 'getCastletvStreams',
     'hdghartv.js': 'getHdghartvStreams',
     'netmirror.js': 'getNetmirrorStreams',
     'onetouchtv.js': 'getOnetouchtvStreams',
     'zxcstreams.js': 'getZxcstreamsStreams',
     'cinezo.js': 'getCinezoStreams',
     'hexa.js': 'getHexaStreams',
     'yourprovider.js': 'getYourproviderStreams'
   };
   ```
4. The provider will appear in the admin UI with an enable/disable toggle.

**Example Provider (Unified Output):**
```javascript
async function getYourproviderStreams(tmdbId, mediaType, season, episode) {
  // Your scraping/API logic here
  return [{
    name: "YourProvider",
    title: "Fight Club - 1080p [YourProvider #1]",
    url: "https://stream.url/video.mp4",
    quality: "1080p",
    provider: "yourprovider",
    headers: { "User-Agent": "Mozilla/5.0" }
  }];
}

module.exports = { getYourproviderStreams };
```

> **⚠️ Important**: All providers must return streams in the unified JSON format to ensure compatibility with filtering and aggregation.

The system automatically:
- ✅ Detects new provider files
- ✅ Adds enable/disable toggles in the admin UI
- ✅ Includes them in stream aggregation
- ✅ Applies filtering and quality controls
- ✅ No core file edits required!

---

## 📡 Key Endpoints
| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Basic heartbeat |
| `GET /api/metrics` | Runtime counters & summary |
| `GET /api/status` | Metrics + providers + endpoints + `providerCheckTmdbId` |
| `GET /api/providers` | All providers with enabled status |
| `GET /api/providers/:name` | Single provider status |
| `GET /api/streams/:type/:tmdbId` | Aggregate streams (`type` = movie\|series; supports `?season=&episode=`) |
| `GET /api/streams/:provider/:type/:tmdbId` | Provider-specific streams (same query params) |
| `GET /api/config` | `{ merged, override, overridePath }` (admin session required) |
| `POST /api/config` | Apply override patch (admin session required; persisted to `utils/user-config.json`) |
| `POST /api/restart` | Graceful restart (writes `restart.trigger` + exits) |
| `GET /api/debug/env` | Debug environment/config snapshot |

Proxy routes (mounted only when `enableProxy` is on):
| Endpoint | Description |
|----------|-------------|
| `GET /m3u8-proxy?url=...&headers=...` | Rewrites & serves HLS playlists/segments |
| `GET /ts-proxy?url=...&headers=...` | Range-aware file/segment proxy |
| `GET /sub-proxy?url=...` | Subtitle passthrough proxy |

The aggregate endpoint auto-resolves IMDb when needed, merges all enabled (or `defaultProviders`) provider output, then applies filtering. Provider timing is returned per provider (`providerTimings`).

### Receive sources as providers finish

Add `?stream=1` to the aggregate endpoint to receive **Server-Sent Events**
instead of the usual JSON response. For series, include the existing season and
episode parameters, e.g. `/api/streams/series/1399?season=1&episode=1&stream=1`.
The original endpoint without `stream=1` remains unchanged.

The server sends:

- `start`: `{ tmdbId, imdbId }` after the IMDb lookup.
- `provider`: `{ provider, success, durationMs, count, streams }` when an
  enabled, selected provider finishes. Streams use the same filtering and
  proxy settings as the aggregate JSON endpoint. A failed provider has
  `success: false`, `durationMs: null`, and an empty stream array. Some
  providers handle their own errors and return an empty array, which cannot be
  distinguished from no results.
- `complete`: `{ success: true, tmdbId, imdbId, count, providerTimings }` after
  all selected providers finish. The count is the total streamed source count.
- `error`: `{ success: false, error: "INTERNAL_ERROR" }` for a fatal server
  error after the response begins.

Each event carries a JSON object in its `data` field. A provider's results
arrive as a batch; individual providers may still wait for all their own
sources. Results can arrive in a different order than in the JSON response.
Closing the connection stops events but does not cancel provider requests
already in progress. Browsers automatically reconnect an `EventSource` after a
disconnect, so close it on completion to avoid duplicate requests:

```js
const source = new EventSource('/api/streams/movie/278?stream=1');
source.addEventListener('provider', event => {
  const { provider, streams } = JSON.parse(event.data);
  console.log(provider, streams);
});
source.addEventListener('complete', event => {
  console.log('Finished:', JSON.parse(event.data));
  source.close();
});
source.addEventListener('error', event => {
  if (event.data) console.error('Server error:', JSON.parse(event.data));
  else console.error('Connection interrupted');
  source.close();
});
```

Reverse proxies must allow streaming responses without buffering. Periodic
comment frames keep idle connections open; proxies may still impose timeouts.

---

## 🧪 Stream Object Schema (Unified)
```json
{
  "name": "ProviderDisplay",
  "title": "Fight Club - 1080p [YourProvider #1]",
  "url": "https://stream.url/video.mp4",
  "quality": "1080p",
  "provider": "yourprovider",
  "headers": { "User-Agent": "Mozilla/5.0" },
  "subtitles": [ { "url": "https://.../en.srt", "lang": "English" } ]
}
```
- `name` / `title` – display strings (often include quality/source hints).
- `url` – direct upstream URL (or proxied URL when `enableProxy` is on).
- `quality` – e.g. `Auto`, `1080p`, `720p`, `480p`, `4K`. Missing/unknown qualities parse as `0`.
- `headers` – optional upstream request headers (stripped when proxying).
- `subtitles` – optional embedded subtitle tracks (CastleTV, NetMirror, OneTouchTV, Showbox).

Filtering passes through `applyFilters` to enforce min quality + codec exclusions (see below).

> Note: When the `enableProxy` flag is turned on, provider-specific request headers are stripped from each stream object before responding. Clients should use the proxied URL directly without adding custom Referer/Origin headers.

---

## ⚙️ Configuration Flags (Advanced Panel)
| Flag | Default | Purpose |
|------|---------|---------|
| `enable<Name>Provider` | true | Enable/disable a provider (e.g. `enableCastletvProvider`) |
| `disableCache` | false | Disables internal caches |
| `enablePStreamApi` | true | PStream API flag |
| `disableUrlValidation` | false | Skip general URL pattern validation checks |
| `disable4khdhubUrlValidation` | false | Skip 4khdhub-specific URL validation |
| `enableProxy` | false | Mounts proxy routes and rewrites stream URLs through them |
| `providerCheckTmdbId` | `278` | TMDB ID used by dashboard functional checks |
| `showboxCacheDir` | — | Custom Showbox cache directory |

Toggle `enableProxy` to activate the internal proxy. This adds lightweight playlist/segment/subtitle rewriting without modifying provider code. Disable it to return direct upstream URLs.

---

## 🧩 Quality & Codec Filtering
- Presets: `all`, `480p`, `720p`, `1080p`, `1440p`, `2160p`.
- Custom quality JSON example (runtime applies the `default` entry; per-provider keys are preserved for future use):
```json
{ "default": "900p" }
```
- Quality strings are normalized numerically — `Auto` ≈ 1080, `HD` ≈ 720, `SD` ≈ 480, plus `4K`/`2160`, `1440`, `1080`, `720`, `576`, `480`, `360`, `240`.
- Codec exclusion JSON example:
```json
{ "excludeDV": true, "excludeHDR": false }
```

---

## 📊 Server Status & Functional Checks
The **Server Status** panel shows live metrics, the endpoint list, and a per-provider functional check table:

- **Run Provider Functional Checks** – hits `/api/streams/:provider/movie/:tmdbId` for each enabled provider and reports pass/fail with stream counts.
- **Provider check TMDB ID** – the title used for the checks is configurable in the dashboard (default `278` = *The Shawshank Redemption*). The value is persisted to `utils/user-config.json` and exposed via `/api/status` as `providerCheckTmdbId`.

---

## 🔐 Security Notes
- Admin UI requires login; session cookie is HttpOnly.
- Cache-control headers disable storing sensitive pages.
- Login is rate limited with escalating lockouts (5 attempts per window).
- Password change endpoint enforces minimum length (8+).
- Default credentials (`admin` / `change-me`) are generated on first run — change them immediately.

---

## 🚀 Deployment Tips
| Aspect | Recommendation |
|--------|---------------|
| Node Version | 18+ LTS |
| Reverse Proxy | Terminate TLS (e.g., Nginx) and forward to API port |
| Persistent Config | Mount / persist `utils/user-config.json` |
| Auth Users | Persist `utils/auth-users.json` so credentials survive restarts |
| Logs | Pipe stdout to centralized logger |
| Scaling | Use a single instance unless providers are CPU bound |

For ephemeral platforms (e.g., Vercel) note that some providers use temporary directories; avoid enabling disk-heavy cache directories.

---

## 💡 Troubleshooting
| Symptom | Cause / Fix |
|---------|------------|
| TMDB quota issues | Add more keys under Keys panel |
| Provider missing in matrix | Ensure its enable flag exists & UI updated |
| Empty merged config after restart | `user-config.json` deleted or unreadable |
| Streams low quality | Adjust min quality preset or custom JSON |
| Showbox shows nothing | Provide `FEBBOX_COOKIES` (comma-separated) under Keys |
| Functional checks fail | Some providers 0-stream legit titles; try changing the *Provider check TMDB ID* |

---

## 🤝 Contributing
PRs welcome. Keep changes focused and avoid unrelated formatting churn. For new providers include:
- A short rationale
- Retry / timeout safeguards
- Respect for existing filtering structure

---

## ❤️ Sponsorship
If this project helps you, consider sponsoring to support continued development & maintenance:

<p align="center">
  <a href="https://github.com/sponsors/Inside4ndroid">
    <img src="https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?style=for-the-badge&logo=github-sponsors&logoColor=white" alt="Sponsor on GitHub" />
  </a>
</p>

Every contribution accelerates feature delivery & sustainability.

---

## 📜 License
MIT.

---

## 🙏 Acknowledgements
Inspired by community scraping/stream aggregation efforts. Credits also to the original NuvioStreamsAddon work for earlier concepts.

---

> *Happy streaming & hacking!* ✨

---