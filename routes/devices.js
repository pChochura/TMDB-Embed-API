const express = require('express');
const jwt = require('jsonwebtoken');

const router = express.Router();
const JWT_SECRET = process.env.SYNC_JWT_SECRET || 'filman_sync_secret_key_change_me';

// --- Auth Middleware for Devices Endpoints ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Missing auth token' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// In-memory active device registry: Map<userId:deviceId, DeviceEntry>
// DeviceEntry: { userId, deviceId, deviceName, platform, appVersion, lastSeen, sseResponse, pendingCommand }
const activeDevices = new Map();

function getDeviceKey(userId, deviceId) {
  return `${userId}:${deviceId}`;
}

// Heartbeat & Registration
router.post('/devices/heartbeat', authenticateToken, (req, res) => {
  const userId = req.user?.id;
  const { deviceId, deviceName, platform, appVersion } = req.body || {};

  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    return res.status(400).json({ success: false, message: 'deviceId is required' });
  }

  const key = getDeviceKey(userId, deviceId.trim());
  const existing = activeDevices.get(key) || {};
  const now = Date.now();

  const entry = {
    ...existing,
    userId,
    deviceId: deviceId.trim(),
    deviceName: (deviceName && typeof deviceName === 'string' && deviceName.trim()) ? deviceName.trim() : (existing.deviceName || 'Android TV'),
    platform: (platform && typeof platform === 'string' && platform.trim()) ? platform.trim() : (existing.platform || 'android_tv'),
    appVersion: (appVersion && typeof appVersion === 'string') ? appVersion.trim() : (existing.appVersion || ''),
    lastSeen: now,
  };

  activeDevices.set(key, entry);

  res.json({
    success: true,
    timestamp: now,
  });
});

// Real-Time SSE Stream for Android TV Device
router.get('/devices/events', authenticateToken, (req, res) => {
  const userId = req.user?.id;
  const deviceId = req.query?.deviceId;

  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    return res.status(400).json({ success: false, message: 'deviceId is required' });
  }

  const key = getDeviceKey(userId, deviceId.trim());
  const now = Date.now();
  const existing = activeDevices.get(key) || {
    userId,
    deviceId: deviceId.trim(),
    deviceName: 'Android TV',
    platform: 'android_tv',
    appVersion: '',
  };

  // Close any existing SSE response for this device key to prevent ghost listeners
  if (existing.sseResponse && !existing.sseResponse.writableEnded) {
    try {
      existing.sseResponse.end();
    } catch (_) {}
  }

  // Setup SSE headers (including X-Accel-Buffering: no for Traefik/Nginx proxies)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  existing.lastSeen = now;
  existing.sseResponse = res;
  activeDevices.set(key, existing);

  // Send initial connected handshake event
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', deviceId: deviceId.trim() })}\n\n`);

  // Deliver any pending command immediately if queued while reconnecting
  if (existing.pendingCommand) {
    const cmd = existing.pendingCommand;
    existing.pendingCommand = null;
    res.write(`event: play\ndata: ${JSON.stringify(cmd)}\n\n`);
  }

  // Keep-alive heartbeat every 25 seconds
  const pingInterval = setInterval(() => {
    if (!res.writableEnded) {
      existing.lastSeen = Date.now();
      res.write(': keep-alive\n\n');
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(pingInterval);
    const curr = activeDevices.get(key);
    if (curr && curr.sseResponse === res) {
      curr.sseResponse = null;
      curr.lastSeen = Date.now();
    }
  });
});

// List Active Devices for Authenticated User
router.get('/devices', authenticateToken, (req, res) => {
  const userId = req.user?.id;
  const now = Date.now();
  const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

  const devices = [];
  for (const entry of activeDevices.values()) {
    if (entry.userId === userId) {
      const isOnline = Boolean(entry.sseResponse && !entry.sseResponse.writableEnded) || (now - entry.lastSeen < ACTIVE_THRESHOLD_MS);
      if (isOnline) {
        devices.push({
          deviceId: entry.deviceId,
          deviceName: entry.deviceName,
          platform: entry.platform,
          appVersion: entry.appVersion,
          lastSeen: entry.lastSeen,
          isOnline: true,
        });
      }
    }
  }

  res.json({
    success: true,
    devices,
  });
});

// Send Play Command to Target Device
router.post('/devices/:deviceId/play', authenticateToken, (req, res) => {
  const userId = req.user?.id;
  const targetDeviceId = req.params?.deviceId;
  const { url, episodeUrl, title, progressMs, autoPlay } = req.body || {};

  if (!targetDeviceId || typeof targetDeviceId !== 'string') {
    return res.status(400).json({ success: false, message: 'Target deviceId is required' });
  }

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, message: 'Media url is required' });
  }

  const key = getDeviceKey(userId, targetDeviceId.trim());
  const device = activeDevices.get(key);

  const now = Date.now();
  const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;
  const isOnline = device && (Boolean(device.sseResponse && !device.sseResponse.writableEnded) || (now - device.lastSeen < ACTIVE_THRESHOLD_MS));

  if (!device || !isOnline) {
    return res.status(404).json({ success: false, message: 'Device not found or currently offline' });
  }

  const payload = {
    action: 'PLAY_MEDIA',
    url: url.trim(),
    episodeUrl: (episodeUrl && typeof episodeUrl === 'string') ? episodeUrl.trim() : null,
    title: (title && typeof title === 'string') ? title.trim() : null,
    progressMs: Number.isFinite(Number(progressMs)) ? Math.max(0, Number(progressMs)) : 0,
    autoPlay: autoPlay !== false,
    timestamp: now,
  };

  if (device.sseResponse && !device.sseResponse.writableEnded) {
    device.sseResponse.write(`event: play\ndata: ${JSON.stringify(payload)}\n\n`);
  } else {
    // If SSE is reconnecting, store as pending command
    device.pendingCommand = payload;
  }

  res.json({
    success: true,
    message: 'Playback command dispatched successfully',
  });
});

// Fallback Poll for Devices without active SSE connection
router.get('/devices/pending-command', authenticateToken, (req, res) => {
  const userId = req.user?.id;
  const deviceId = req.query?.deviceId;

  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ success: false, message: 'deviceId is required' });
  }

  const key = getDeviceKey(userId, deviceId.trim());
  const device = activeDevices.get(key);
  if (!device || !device.pendingCommand) {
    return res.json({ success: true, command: null });
  }

  const command = device.pendingCommand;
  device.pendingCommand = null;
  res.json({ success: true, command });
});

// Helper for testing to reset registry
function _resetDevicesForTest() {
  activeDevices.clear();
}

module.exports = {
  router,
  _resetDevicesForTest,
  activeDevices,
};
