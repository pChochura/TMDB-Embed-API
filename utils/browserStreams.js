const fs = require('fs');
const { chromium } = require('playwright-core');

const MAX_ACTIVE = 2;
const MAX_WAITING = 20;
const STREAM_TIMEOUT = 25000;
const NAVIGATION_TIMEOUT = 15000;
let active = 0;
const waiting = [];

async function acquireSlot() {
  if (active < MAX_ACTIVE) {
    active++;
    return;
  }
  if (waiting.length >= MAX_WAITING) throw new Error('Browser extraction queue is full');
  await new Promise(resolve => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function browserExecutable() {
  if (process.env.BROWSER_EXECUTABLE_PATH) return process.env.BROWSER_EXECUTABLE_PATH;
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const executable = candidates.find(file => fs.existsSync(file));
  if (!executable) throw new Error('Chromium not found; set BROWSER_EXECUTABLE_PATH');
  return executable;
}

function watchUrl({ baseUrl, tmdbId, mediaType, season, episode, seriesPath }) {
  if (!/^[0-9]+$/.test(String(tmdbId)) || Number(tmdbId) <= 0) {
    throw new Error('TMDB ID must be a positive integer');
  }
  if (mediaType !== 'movie' && mediaType !== 'tv') throw new Error('Invalid media type');
  if (mediaType === 'tv' &&
      (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1)) {
    throw new Error('TV requests require a non-negative season and positive episode');
  }
  return baseUrl + (mediaType === 'movie'
    ? `/watch/movie/${tmdbId}`
    : seriesPath(tmdbId, season, episode));
}

function isStreamResponse(response) {
  if (response.status() < 200 || response.status() >= 300) return false;
  const url = new URL(response.url());
  return (url.protocol === 'https:' || url.protocol === 'http:') &&
    /\.(?:m3u8|mp4)$/i.test(url.pathname);
}

async function extractPlayerStreams(options) {
  const url = watchUrl(options);
  await acquireSlot();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: browserExecutable(),
      headless: true,
      chromiumSandbox: true
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    let failedDocument = null;
    page.on('response', response => {
      if (response.request().resourceType() === 'document' && response.status() >= 400) {
        failedDocument = `${new URL(response.url()).hostname} returned HTTP ${response.status()}`;
      }
    });
    const responsePromise = page.waitForEvent('response', {
      predicate: isStreamResponse,
      timeout: STREAM_TIMEOUT
    }).then(response => ({ response }), error => ({ error }));
    const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    if (!navigation || !navigation.ok()) {
      throw new Error(`Player page returned HTTP ${navigation ? navigation.status() : 'unknown'}`);
    }
    const { response, error } = await responsePromise;
    if (error) {
      const verification = await page.getByText('Verification Required', { exact: true }).isVisible();
      const detail = verification ? 'verification required' : failedDocument;
      throw new Error(`No successful HLS or MP4 response within ${STREAM_TIMEOUT / 1000}s${detail ? `; ${detail}` : ''}`);
    }
    const requestHeaders = await response.request().allHeaders();
    const headers = {};
    for (const [source, target] of [['referer', 'Referer'], ['origin', 'Origin'], ['user-agent', 'User-Agent']]) {
      if (requestHeaders[source]) headers[target] = requestHeaders[source];
    }
    return [{
      name: options.provider,
      title: `${options.provider} - Auto`,
      url: response.url(),
      quality: 'Auto',
      provider: options.provider,
      headers
    }];
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      releaseSlot();
    }
  }
}

module.exports = { extractPlayerStreams, watchUrl, isStreamResponse };
