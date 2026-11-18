const { config } = require('../utils/config');
const fs = require('fs');
const path = require('path');

// Lazy load cache for providers
const providerCache = new Map();

// Function name mappings for existing providers
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
  'movieweb.js': 'getMovieWebStreams',
  'stremiobridge.js': 'getStremioBridgeStreams',
  'polish.js': 'getPolishStreams',
  'vidzee.js': 'getVidzeeStreams',
  'animepahe.js': 'getAnimepaheStreams',
  'videogetter.js': 'getVideogetterStreams',
};

// Stats for debug endpoint
let lastCookieStats = { selected: null, index: null, total: 0, remainingMB: null, timestamp: null };

async function getEffectiveCookies() {
  return Array.isArray(config.febboxCookies) ? config.febboxCookies : [];
}

// Get all provider files
function getProviderFiles() {
  const providersDir = path.join(__dirname);
  return fs.readdirSync(providersDir)
    .filter(file => file.endsWith('.js') && file !== 'registry.js')
    .map(file => {
      const lowerName = path.parse(file).name.toLowerCase();
      const mappedFunc = providerFunctionMap[file] ||
        providerFunctionMap[`${lowerName}.js`] ||
        providerFunctionMap[Object.keys(providerFunctionMap).find(k => k.toLowerCase() === file.toLowerCase())];
      return {
        name: lowerName,
        file: file,
        functionName: mappedFunc || `get${lowerName.charAt(0).toUpperCase() + lowerName.slice(1)}Streams`
      };
    });
}

// Load a provider module
function loadProvider(providerFile) {
  if (!providerCache.has(providerFile)) {
    try {
      providerCache.set(providerFile, require(path.join(__dirname, providerFile)));
    } catch (e) {
      console.error(`Failed to load provider ${providerFile}:`, e.message);
      return null;
    }
  }
  return providerCache.get(providerFile);
}

// Create fetch function for a provider
function createFetchFunction(providerInfo) {
  return async function(ctx = {}) {
    const module = loadProvider(providerInfo.file);
    if (!module) return [];

    let funcName = providerInfo.functionName;
    if (!funcName || !module[funcName]) {
      if (typeof module.getMovieWebStreams === 'function') funcName = 'getMovieWebStreams';
      else if (typeof module.getStremioBridgeStreams === 'function') funcName = 'getStremioBridgeStreams';
      else if (typeof module.getAnimepaheStreams === 'function') funcName = 'getAnimepaheStreams';
      else if (typeof module.getStreams === 'function') funcName = 'getStreams';
      else if (typeof module.getStreamsFromTmdbId === 'function') funcName = 'getStreamsFromTmdbId';
    }

    if (!funcName || !module[funcName]) {
      console.error(`Provider ${providerInfo.name} does not export ${funcName}`);
      return [];
    }

    try {
      const mediaType = (ctx && ctx.type === 'movie') ? 'movie' : 'tv';
      const t0 = Date.now();

      let result;
      if (providerInfo.name === 'showbox') {
        // Special case for Showbox with TMDB key and cookies
        const { getTmdbApiKey } = require('../utils/tmdbKey');
        const tmdbApiKey = getTmdbApiKey();
        if (!tmdbApiKey) {
          console.warn('[registry] showbox skipped: TMDB API key missing');
          return [];
        }
        const cookies = await getEffectiveCookies();
        const previousConfig = global.currentRequestConfig;
        global.currentRequestConfig = { ...(previousConfig || {}) };
        let selected = null;
        if (cookies.length > 0) {
          const index = Math.floor(Math.random() * cookies.length);
          selected = cookies[index];
          global.currentRequestConfig.cookie = selected.startsWith('ui=') ? selected : `ui=${selected}`;
          global.currentRequestConfig.cookies = cookies.map(c => c.startsWith('ui=') ? c : `ui=${c}`);
          lastCookieStats = { selected: selected.slice(0, 16) + '...', index, total: cookies.length, remainingMB: null, timestamp: Date.now() };
          console.log(`[registry] Cookie random pick index=${index} total=${cookies.length}`);
        }
        result = await module[funcName](mediaType, ctx.tmdbId, ctx.season || null, ctx.episode || null, null, selected);
        if (global.currentRequestUserCookieRemainingMB != null) {
          lastCookieStats.remainingMB = global.currentRequestUserCookieRemainingMB;
        }
        global.currentRequestConfig = previousConfig || {};
      } else {
        // Standard provider call: pass ctx as 5th argument so providers can access imdbId and metadata
        result = await module[funcName](ctx.tmdbId, mediaType, ctx.season ?? null, ctx.episode ?? null, ctx);
      }

      const durationMs = Date.now() - t0;
      console.log(`[registry] ${providerInfo.name} fetch duration ${durationMs}ms`);

      if (!Array.isArray(result)) return [];

      // Add provider name if not present
      return result.map(s => ({ ...s, provider: s.provider || providerInfo.name }));

    } catch (e) {
      console.error(`[registry] ${providerInfo.name} fetch error:`, e.message);
      return [];
    }
  };
}

// Initialize providers - always load all; enabled state is checked dynamically from live config
const providers = [];

function ensureProvidersLoaded() {
  const currentFiles = getProviderFiles();
  for (const info of currentFiles) {
    if (!providers.some(p => p.name === info.name)) {
      providers.push({
        name: info.name,
        fetch: createFetchFunction(info)
      });
      console.log(`[registry] ${info.name} provider loaded`);
    }
  }
}

// Initial load
ensureProvidersLoaded();

function isProviderEnabled(name) {
  const normName = name.toLowerCase();
  const flag = `enable${normName.charAt(0).toUpperCase() + normName.slice(1)}Provider`;
  if (config[flag] !== undefined) return config[flag] !== false;
  // Fallbacks for alternative naming conventions
  if (normName === 'stremiobridge' && config.enableStremioBridgeProvider !== undefined) {
    return config.enableStremioBridgeProvider !== false;
  }
  if (normName === 'movieweb' && config.enableMovieWebProvider !== undefined) {
    return config.enableMovieWebProvider !== false;
  }
  // Sidecar-dependent and heavy providers default to disabled
  if (['cinezo', 'hexa', 'stremiobridge'].includes(normName)) {
    return false;
  }
  return true;
}

function listProviders() {
  ensureProvidersLoaded();
  return providers.map(p => ({ name: p.name, enabled: isProviderEnabled(p.name) }));
}

function getProvider(name) {
  if (!name) return null;
  ensureProvidersLoaded();
  const p = providers.find(p => p.name === name.toLowerCase());
  if (!p) return null;
  return { ...p, enabled: isProviderEnabled(p.name) };
}

function getCookieStats() { return lastCookieStats; }

module.exports = { listProviders, getProvider, getCookieStats };
