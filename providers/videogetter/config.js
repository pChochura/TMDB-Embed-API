const path = require('path');

const config = {
  defaultVidaraJSONURL: 'https://www.jsonkeeper.com/b/FWSAK',
  defaultVidaraBaseURL: 'https://mxzhxco8dft.com',
  defaultStreamTapeBaseURL: 'https://streamtape.com',
  defaultStreamHGBaseURL: 'https://hanerix.com',
  defaultHubCloudBaseURL: 'https://hubcloud.pw',
  defaultHubCloudProxyURL: 'https://proxyservr.kineflex-netflex.workers.dev',
  defaultAppURLWorker: 'https://pinggy-registry.kineflex-netflex.workers.dev/api/app',
  defaultVidFastBaseURL: 'https://cinesrc.st/embed',
  defaultVidriftBaseURL: 'https://embed.vidrift.in',
  defaultCineTVBaseURL: 'https://cinetvtest.netlify.app',
  localDataPath: path.join(__dirname, 'data', 'vidara.json'),
  requestTimeout: 15000,
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
};

module.exports = config;
