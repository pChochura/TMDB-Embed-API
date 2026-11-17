const { spawn, spawnSync } = require('child_process');
const axios = require('axios');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let ffmpegCheckCache = null;

function isFfmpegAvailable() {
  if (ffmpegCheckCache !== null) {
    return ffmpegCheckCache;
  }
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpegCheckCache = result.status === 0;
  } catch {
    ffmpegCheckCache = false;
  }
  return ffmpegCheckCache;
}

// Reset cache for testing
function setFfmpegAvailable(val) {
  ffmpegCheckCache = val;
}

function firstPlaylistEntry(text, baseUrl) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    try {
      return new URL(entry, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

const IMAGE_MAGIC = [
  Buffer.from('89504e470d0a1a0a', 'hex'), // PNG
  Buffer.from('ffd8ff', 'hex'),           // JPEG
  Buffer.from('GIF87a', 'ascii'),
  Buffer.from('GIF89a', 'ascii'),
];

function looksLikeImage(buf) {
  if (!buf || !buf.length) return false;
  const head = Buffer.from(buf);
  return IMAGE_MAGIC.some(magic => head.subarray(0, magic.length).equals(magic));
}

async function isOpenable(url, extraHeaders = {}) {
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': DEFAULT_UA, ...extraHeaders },
      timeout: 8000,
      maxContentLength: 4 * 1024 * 1024,
      responseType: 'text',
      transformResponse: [d => d],
      validateStatus: s => s >= 200 && s < 300,
    });
    let playlist = typeof resp.data === 'string' ? resp.data : '';
    if (!playlist.includes('#EXTM3U')) return false;

    let entryUrl = firstPlaylistEntry(playlist, url);
    if (!entryUrl) return false;

    if (playlist.includes('#EXT-X-STREAM-INF')) {
      const subResp = await axios.get(entryUrl, {
        headers: { 'User-Agent': DEFAULT_UA, ...extraHeaders },
        timeout: 8000,
        responseType: 'text',
        transformResponse: [d => d],
        validateStatus: s => s >= 200 && s < 300,
      });
      playlist = typeof subResp.data === 'string' ? subResp.data : '';
      if (!playlist.includes('#EXTM3U')) return false;
      entryUrl = firstPlaylistEntry(playlist, entryUrl);
      if (!entryUrl) return false;
    }

    const seg = await axios.get(entryUrl, {
      headers: { 'User-Agent': DEFAULT_UA, Range: 'bytes=0-15', ...extraHeaders },
      timeout: 8000,
      responseType: 'arraybuffer',
      validateStatus: s => s >= 200 && s < 300,
    });
    return !looksLikeImage(Buffer.from(seg.data));
  } catch {
    return false;
  }
}

function streamRemux(res, streamUrl, options = {}) {
  const {
    download = false,
    filename = 'stream.mp4',
    referer = 'https://player.vidzee.wtf/',
    userAgent = DEFAULT_UA
  } = options;

  if (!isFfmpegAvailable()) {
    if (!res.headersSent) {
      res.status(501).json({
        success: false,
        error: 'FFMPEG_UNAVAILABLE',
        message: 'FFmpeg is not installed or available on this system for on-the-fly MP4 remuxing.'
      });
    }
    return null;
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', userAgent,
    '-referer', referer,
    '-i', streamUrl,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let started = false;
  let stderr = '';
  ff.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  ff.stdout.once('data', (chunk) => {
    started = true;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store');
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.write(chunk);
    ff.stdout.pipe(res);
  });

  ff.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).json({ success: false, error: 'FFMPEG_SPAWN_FAILED', detail: e.message });
    }
  });

  ff.on('close', (code) => {
    if (!started && !res.headersSent) {
      res.status(502).json({ success: false, error: 'REMUX_FAILED', detail: stderr.slice(-400).trim() });
    } else if (!res.writableEnded) {
      res.end();
    }
    if (code) {
      console.warn(`[remux] ffmpeg exited code=${code} ${stderr.slice(-200).trim()}`);
    }
  });

  const kill = () => {
    if (ff.exitCode === null && !ff.killed) {
      ff.kill('SIGKILL');
    }
  };
  res.on('close', kill);
  return ff;
}

module.exports = {
  isFfmpegAvailable,
  setFfmpegAvailable,
  firstPlaylistEntry,
  looksLikeImage,
  isOpenable,
  streamRemux
};
