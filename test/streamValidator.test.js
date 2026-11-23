const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateStream,
  validateStreams,
  checkCdaHtml,
  checkGenericEmbedHtml,
  checkM3u8Content,
  clearValidationCache,
  getValidationCacheStats
} = require('../utils/streamValidator');

test('streamValidator checkCdaHtml detects premium accounts, paywalls, and deletions', () => {
  // CDA Premium snippet with paywall overlay
  const premiumHtml = `
    <html>
      <body>
        <div class="player-cover-wrapper">
          <div class="player-prem-bg-text">Ten film jest dostępny dla użytkowników premium</div>
          <a href="https://premium.cda.pl/rejestracja">Dołącz do CDA Premium</a>
        </div>
      </body>
    </html>
  `;
  const premCheck = checkCdaHtml(premiumHtml);
  assert.equal(premCheck.valid, false);
  assert.equal(premCheck.status, 'blocked');
  assert.equal(premCheck.reason, 'premium_required');

  // CDA Deleted HTML
  const deletedHtml = `
    <div class="msg-error">Ten film został usunięty z powodu naruszenia praw autorskich.</div>
  `;
  const delCheck = checkCdaHtml(deletedHtml);
  assert.equal(delCheck.valid, false);
  assert.equal(delCheck.status, 'unreachable');
  assert.equal(delCheck.reason, 'video_removed');

  // Free / Playable CDA HTML
  const playableHtml = `
    <html>
      <head>
        <link href="/_player2021css/player.css" rel="stylesheet" />
      </head>
      <body>
        <div class="pb-video-player-wrap">
          <video class="pb-video-player"></video>
        </div>
      </body>
    </html>
  `;
  const playCheck = checkCdaHtml(playableHtml);
  assert.equal(playCheck.valid, true);
  assert.equal(playCheck.status, 'valid');
});

test('streamValidator checkGenericEmbedHtml detects account blocks and copyright removals', () => {
  const paywallHtml = '<div>Subscription required to view this media. Only for registered users.</div>';
  const payCheck = checkGenericEmbedHtml(paywallHtml);
  assert.equal(payCheck.valid, false);
  assert.equal(payCheck.status, 'blocked');

  const removedHtml = '<div class="alert">Video has been removed due to copyright notice.</div>';
  const remCheck = checkGenericEmbedHtml(removedHtml);
  assert.equal(remCheck.valid, false);
  assert.equal(remCheck.status, 'unreachable');
  assert.equal(remCheck.reason, 'video_unavailable');

  const normalHtml = '<div id="player"></div><script>player.init();</script>';
  const okCheck = checkGenericEmbedHtml(normalHtml);
  assert.equal(okCheck.valid, true);
  assert.equal(okCheck.status, 'valid');
});

test('streamValidator checkM3u8Content validates HLS manifests and catches empty/invalid files', () => {
  const validM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment1.ts
#EXT-X-ENDLIST`;
  assert.deepEqual(checkM3u8Content(validM3u8), { valid: true, status: 'valid' });

  const masterM3u8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
chunklist_720p.m3u8`;
  assert.deepEqual(checkM3u8Content(masterM3u8), { valid: true, status: 'valid' });

  const invalidM3u8 = `Not a manifest at all`;
  assert.equal(checkM3u8Content(invalidM3u8).valid, false);
  assert.equal(checkM3u8Content(invalidM3u8).reason, 'missing_extm3u_header');

  const emptyM3u8 = `#EXTM3U\n`;
  assert.equal(checkM3u8Content(emptyM3u8).valid, false);
  assert.equal(checkM3u8Content(emptyM3u8).reason, 'no_stream_segments_or_variants');

  // Duration checking
  const trailerM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:60.0,
seg1.ts
#EXTINF:60.0,
seg2.ts
#EXT-X-ENDLIST`;
  // Expected 120 min film, but got 2 min trailer
  const trailerCheck = checkM3u8Content(trailerM3u8, { expectedRuntimeMinutes: 120 });
  assert.equal(trailerCheck.valid, false);
  assert.equal(trailerCheck.reason, 'trailer_or_sample_detected');

  // Mismatch duration (45 min show when 130 min film expected)
  const mismatchM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:1350.0,
seg1.ts
#EXTINF:1350.0,
seg2.ts
#EXT-X-ENDLIST`; // 2700s = 45 min
  const mismatchCheck = checkM3u8Content(mismatchM3u8, { expectedRuntimeMinutes: 130 });
  assert.equal(mismatchCheck.valid, false);
  assert.equal(mismatchCheck.reason, 'duration_mismatch');

  // Acceptable duration (125 min stream for 120 min film, ~4% diff)
  const matchingM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:3750.0,
seg1.ts
#EXTINF:3750.0,
seg2.ts
#EXT-X-ENDLIST`; // 7500s = 125 min
  const matchingCheck = checkM3u8Content(matchingM3u8, { expectedRuntimeMinutes: 120 });
  assert.equal(matchingCheck.valid, true);
});

test('streamValidator validateStream checks CDA embeds with mock axios', async () => {
  clearValidationCache();

  // Mock axios instance simulating CDA responses
  const mockAxios = {
    get: async (url) => {
      if (url.includes('premium-video')) {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: '<div class="player-prem-bg-text">Ten film jest dostępny dla użytkowników premium</div>'
        };
      }
      if (url.includes('free-video')) {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: '<div class="pb-video-player-wrap"><video></video></div>'
        };
      }
      if (url.includes('deleted-video')) {
        return {
          status: 404,
          headers: { 'content-type': 'text/html' },
          data: 'Not Found'
        };
      }
      throw new Error('Connection refused');
    }
  };

  const premResult = await validateStream(
    { url: 'https://ebd.cda.pl/620x368/premium-video' },
    { axiosInstance: mockAxios }
  );
  assert.equal(premResult.valid, false);
  assert.equal(premResult.status, 'blocked');
  assert.equal(premResult.reason, 'premium_required');

  const freeResult = await validateStream(
    { url: 'https://ebd.cda.pl/620x368/free-video' },
    { axiosInstance: mockAxios }
  );
  assert.equal(freeResult.valid, true);
  assert.equal(freeResult.status, 'valid');

  const delResult = await validateStream(
    { url: 'https://ebd.cda.pl/620x368/deleted-video' },
    { axiosInstance: mockAxios }
  );
  assert.equal(delResult.valid, false);
  assert.equal(delResult.status, 'unreachable');
  assert.equal(delResult.reason, 'http_404');
});

test('streamValidator validateStream checks direct m3u8 and mp4 media streams', async () => {
  clearValidationCache();

  const mockAxios = {
    get: async (url, opts) => {
      assert.ok(opts.headers.Range, 'Direct media validation must request byte range');

      if (url.endsWith('.m3u8')) {
        return {
          status: 206,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          data: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p.m3u8'
        };
      }
      if (url.endsWith('fake.mp4')) {
        // Server returned 200 HTML error page instead of video
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          data: '<html>404 Not Found / Paywall</html>'
        };
      }
      if (url.endsWith('good.mp4')) {
        return {
          status: 206,
          headers: { 'content-type': 'video/mp4' },
          data: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]) // ftyp mp4
        };
      }
      return { status: 403, headers: {}, data: 'Forbidden' };
    }
  };

  const m3u8Res = await validateStream('https://cdn.example.com/stream.m3u8', { axiosInstance: mockAxios });
  assert.equal(m3u8Res.valid, true);

  const fakeMp4Res = await validateStream('https://cdn.example.com/fake.mp4', { axiosInstance: mockAxios });
  assert.equal(fakeMp4Res.valid, false);
  assert.equal(fakeMp4Res.reason, 'html_served_for_media_url');

  const goodMp4Res = await validateStream('https://cdn.example.com/good.mp4', { axiosInstance: mockAxios });
  assert.equal(goodMp4Res.valid, true);
});

test('streamValidator caches results and respects TTL and clearValidationCache', async () => {
  clearValidationCache();
  let networkCalls = 0;

  const mockAxios = {
    get: async () => {
      networkCalls++;
      return { status: 200, headers: { 'content-type': 'text/html' }, data: '<div id="player"></div>' };
    }
  };

  const url = 'https://embed.example.com/123';
  const res1 = await validateStream(url, { axiosInstance: mockAxios });
  assert.equal(res1.valid, true);
  assert.equal(networkCalls, 1);

  // Second call should hit in-memory cache
  const res2 = await validateStream(url, { axiosInstance: mockAxios });
  assert.equal(res2.valid, true);
  assert.equal(networkCalls, 1, 'Subsequent call should be served from cache without network hit');

  // Cache stats check
  const stats = getValidationCacheStats();
  assert.equal(stats.size, 1);

  // Clear cache and verify fresh fetch
  clearValidationCache();
  assert.equal(getValidationCacheStats().size, 0);

  const res3 = await validateStream(url, { axiosInstance: mockAxios });
  assert.equal(res3.valid, true);
  assert.equal(networkCalls, 2);
});

test('streamValidator validateStreams filters invalid streams in parallel', async () => {
  clearValidationCache();

  const streams = [
    { title: 'Stream 1 (Free)', url: 'https://ebd.cda.pl/620x368/free' },
    { title: 'Stream 2 (Premium)', url: 'https://ebd.cda.pl/620x368/premium' },
    { title: 'Stream 3 (Direct HLS)', url: 'https://cdn.example.com/video.m3u8' }
  ];

  const mockAxios = {
    get: async (url) => {
      if (url.includes('premium')) {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: '<div class="player-prem-bg-text">Ten film jest dostępny dla użytkowników premium</div>'
        };
      }
      if (url.includes('free')) {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: '<div class="pb-video-player-wrap"><video></video></div>'
        };
      }
      if (url.endsWith('.m3u8')) {
        return {
          status: 206,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          data: '#EXTM3U\n#EXTINF:10.0,\nseg1.ts'
        };
      }
      return { status: 404, headers: {}, data: '' };
    }
  };

  // With filterInvalid: true
  const validOnly = await validateStreams(streams, { filterInvalid: true, axiosInstance: mockAxios });
  assert.equal(validOnly.length, 2);
  assert.equal(validOnly[0].title, 'Stream 1 (Free)');
  assert.equal(validOnly[1].title, 'Stream 3 (Direct HLS)');

  // Without filterInvalid (annotates each stream)
  const annotated = await validateStreams(streams, { filterInvalid: false, axiosInstance: mockAxios });
  assert.equal(annotated.length, 3);
  assert.equal(annotated[0].validation.valid, true);
  assert.equal(annotated[1].validation.valid, false);
  assert.equal(annotated[1].validation.reason, 'premium_required');
  assert.equal(annotated[2].validation.valid, true);
});
