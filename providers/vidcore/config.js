const siteOrigin = process.env.VIDCORE_ORIGIN || 'https://vidcore.io';
const siteReferer = `${siteOrigin}/`;
const userAgent =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

module.exports = {
  siteOrigin,
  siteReferer,
  userAgent,
};
