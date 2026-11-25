const { siteOrigin, siteReferer, userAgent } = require('./config');
const { decryptCatalogBody, sealEn } = require('./crypto');
const { createScraperFetch, loadPlayerMaterial, scrapeEmbedPage } = require('./scraper');
const { SERVER_ORDER, profileByName, ensureMasterForAbr } = require('./servers');

const CACHE_TTL_MS = 120_000;
let catalogCache = null;

function requestKey(kind, id, season, episode) {
  return kind === 'tv' ? `tv:${id}:${season}:${episode}` : `movie:${id}`;
}

function ordered(servers) {
  const byName = new Map(servers.filter((s) => s?.data).map((s) => [s.name, s]));
  return SERVER_ORDER.map((name) => byName.get(name)).filter(Boolean);
}

async function listCatalogServers(en, scraperFetch, html) {
  const material = await loadPlayerMaterial({ html });
  const r = material.routes;
  const sealed = sealEn(en);
  const response = await scraperFetch(`${r.base}/${r.listAction}/${sealed}`, {
    method: r.method,
    headers: r.headers,
  });
  if (!response.ok) throw Object.assign(new Error(`catalog list failed: ${response.status}`), { stage: 'resolve' });
  const body = await response.text();
  if (!body) throw Object.assign(new Error('catalog list empty body'), { stage: 'resolve' });
  const decrypted = decryptCatalogBody(body);
  if (!Array.isArray(decrypted) || !decrypted.length) {
    throw Object.assign(new Error('server list empty'), { stage: 'resolve' });
  }
  return decrypted;
}

async function unlockCatalogStream(server, scraperFetch, html) {
  if (!server?.data) throw new Error('server missing data token');
  const material = await loadPlayerMaterial({ html });
  const r = material.routes;
  const response = await scraperFetch(`${r.base}/${r.streamAction}/${server.data}`, {
    method: r.method,
    headers: r.headers,
  });
  if (!response.ok) throw new Error(`stream unlock failed: ${response.status}`);
  const body = await response.text();
  if (!body) throw new Error('stream unlock empty body');
  const config = decryptCatalogBody(body);
  if (!config || !config.url) throw new Error('decrypt missing stream url');
  return config;
}

async function loadCatalog(kind, id, season, episode) {
  const key = requestKey(kind, id, season, episode);
  if (catalogCache && catalogCache.key === key && Date.now() - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache;
  }

  const embed = await scrapeEmbedPage(kind, id, {
    season: kind === 'tv' ? season : undefined,
    episode: kind === 'tv' ? episode : undefined,
  });
  const scraperFetch = createScraperFetch(embed.referer, embed.jar);
  const rawServers = await listCatalogServers(embed.en, scraperFetch, embed.html);
  const servers = ordered(rawServers);
  if (!servers.length) throw Object.assign(new Error('server list empty'), { stage: 'resolve' });

  catalogCache = { key, embed, servers, scraperFetch, at: Date.now() };
  return catalogCache;
}

/**
 * Resolves VidCore streams natively in-process without any sidecar container.
 *
 * @param {string|number} tmdbId
 * @param {'movie'|'series'|'tv'} [mediaType='movie']
 * @param {number|string} [season]
 * @param {number|string} [episode]
 * @returns {Promise<Array<Object>>}
 */
async function resolveVidcoreInProcess(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const kind = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  const idStr = String(tmdbId);
  const s = season ? String(season) : '1';
  const e = episode ? String(episode) : '1';

  const catalog = await loadCatalog(kind, idStr, s, e);
  const streams = [];

  for (const server of catalog.servers) {
    try {
      const config = await unlockCatalogStream(server, catalog.scraperFetch, catalog.embed.html);
      let streamUrl = config.url;
      const profile = profileByName(server.name);
      if (profile?.abrMaster) {
        streamUrl = await ensureMasterForAbr(streamUrl);
      }

      streams.push({
        name: `VidCore (${server.name})`,
        title: `Auto [VidCore - ${server.name}]`,
        url: streamUrl,
        quality: 'Auto',
        provider: 'vidcore',
        headers: {
          'User-Agent': userAgent,
          'Referer': siteReferer,
          'Origin': siteOrigin,
        },
        subtitles: [],
      });
    } catch (err) {
      // Continue to next server on failure
    }
  }

  return streams;
}

module.exports = {
  resolveVidcoreInProcess,
  loadCatalog,
  listCatalogServers,
  unlockCatalogStream,
};
