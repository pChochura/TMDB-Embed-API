const port = Number(process.env.API_PORT);
const { config } = require('../../utils/config');
const registry = require('../../providers/registry');
const tmdb = require('../../utils/tmdb');

config.port = port;
config.defaultProviders = process.env.TEST_EMPTY === 'true' ? ['disabled'] : ['slow', 'fast', 'failed', 'disabled'];
config.minQualities = { default: process.env.TEST_FORMAT_ERROR === 'true' ? 5 : '720p' };
config.enableProxy = process.env.TEST_PROXY === 'true';
tmdb.resolveImdbId = async () => 'tt123';

const pending = [];
let slowCalls = 0;
process.on('message', message => {
  if (message === 'release') {
    for (const resolve of pending.splice(0)) resolve();
  }
});
const providers = {
  slow: {
    name: 'slow', enabled: true,
    fetch: async () => {
      if (process.send) process.send({ event: 'slow-start', call: ++slowCalls });
      await new Promise(resolve => pending.push(resolve));
      return [{ url: 'https://example.test/slow.mp4', quality: '720p', headers: { Referer: 'https://example.test/' } }];
    }
  },
  fast: {
    name: 'fast', enabled: true,
    fetch: async () => [
      { url: 'https://example.test/fast.m3u8', quality: '1080p', headers: { Referer: 'https://example.test/' } },
      { url: 'https://example.test/low.mp4', quality: '480p' }
    ]
  },
  failed: { name: 'failed', enabled: true, fetch: async () => { throw new Error('test provider failure'); } },
  disabled: { name: 'disabled', enabled: false, fetch: async () => { throw new Error('disabled provider called'); } }
};
registry.getProvider = name => providers[name] || null;
registry.listProviders = () => Object.values(providers);

require('../../apiServer');
