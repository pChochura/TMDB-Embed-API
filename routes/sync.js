const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.SYNC_JWT_SECRET || 'filman_sync_secret_key_change_me';

// --- Auth Middleware for Sync Endpoints ---
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

// --- Auth Routes ---
router.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string' || !username.trim()) {
      return res.status(400).json({
        token: null,
        user: null,
        success: false,
        message: 'Username and password are required'
      });
    }

    const cleanUsername = username.trim().toLowerCase();
    const existing = await db.query('SELECT id FROM users WHERE username = $1', [cleanUsername]);
    if (existing.rows && existing.rows.length > 0) {
      return res.status(409).json({
        token: null,
        user: null,
        success: false,
        message: 'Username is already taken'
      });
    }

    const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '').substring(0, 12);
    const passwordHash = await bcrypt.hash(password, 10);
    const now = Date.now();

    await db.query(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)',
      [userId, cleanUsername, passwordHash, now]
    );

    const token = jwt.sign({ id: userId, username: cleanUsername }, JWT_SECRET, { expiresIn: '180d' });
    res.json({
      token,
      user: { id: userId, username: cleanUsername },
      success: true,
      message: null
    });
  } catch (err) {
    console.error('[auth/register] error:', err);
    res.status(500).json({
      token: null,
      user: null,
      success: false,
      message: 'Internal server error during registration'
    });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        token: null,
        user: null,
        success: false,
        message: 'Username and password are required'
      });
    }

    const cleanUsername = username.trim().toLowerCase();
    const result = await db.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [cleanUsername]
    );
    const user = result.rows && result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        token: null,
        user: null,
        success: false,
        message: 'Invalid username or password'
      });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '180d' });
    res.json({
      token,
      user: { id: user.id, username: user.username },
      success: true,
      message: null
    });
  } catch (err) {
    console.error('[auth/login] error:', err);
    res.status(500).json({
      token: null,
      user: null,
      success: false,
      message: 'Internal server error during login'
    });
  }
});

// --- Sync Routes ---
router.get('/sync/pull', authenticateToken, async (req, res) => {
  try {
    const since = parseInt(req.query.since || '0', 10) || 0;
    const userId = req.user.id;
    const now = Date.now();

    const progressRows = await db.query(`
      SELECT url, parent_url, progress_percentage, progress_ms, poster_url, title_pl,
             season, episode, series_title, episode_title, is_watched, updated_at
      FROM watch_progress
      WHERE user_id = $1 AND updated_at > $2
    `, [userId, since]);

    const watchlistRows = await db.query(`
      SELECT url, title_pl, poster_url, background_url, is_tv_show, year, is_deleted, updated_at
      FROM watchlist
      WHERE user_id = $1 AND updated_at > $2
    `, [userId, since]);

    const favoritesRows = await db.query(`
      SELECT url, title_pl, poster_url, background_url, is_tv_show, year, is_deleted, updated_at
      FROM favorites
      WHERE user_id = $1 AND updated_at > $2
    `, [userId, since]);

    const prefRows = await db.query(`
      SELECT pref_key, pref_value
      FROM user_preferences
      WHERE user_id = $1 AND updated_at > $2
    `, [userId, since]);

    const preferences = {};
    for (const row of prefRows.rows) {
      preferences[row.pref_key] = row.pref_value;
    }

    res.json({
      serverTimestamp: now,
      progress: progressRows.rows.map((p) => ({
        url: p.url,
        parentUrl: p.parent_url || null,
        progressPercentage: Number(p.progress_percentage || 0),
        progressMs: Number(p.progress_ms || 0),
        posterUrl: p.poster_url || '',
        titlePl: p.title_pl || '',
        season: p.season !== null && p.season !== undefined ? Number(p.season) : null,
        episode: p.episode !== null && p.episode !== undefined ? Number(p.episode) : null,
        seriesTitle: p.series_title || null,
        episodeTitle: p.episode_title || null,
        isWatched: Boolean(p.is_watched),
        updatedAt: Number(p.updated_at)
      })),
      watchlist: watchlistRows.rows.map((w) => ({
        url: w.url,
        titlePl: w.title_pl || '',
        posterUrl: w.poster_url || '',
        backgroundUrl: w.background_url || null,
        isTvShow: Boolean(w.is_tv_show),
        year: w.year !== null && w.year !== undefined ? Number(w.year) : null,
        isDeleted: Boolean(w.is_deleted),
        updatedAt: Number(w.updated_at)
      })),
      favorites: favoritesRows.rows.map((f) => ({
        url: f.url,
        titlePl: f.title_pl || '',
        posterUrl: f.poster_url || '',
        backgroundUrl: f.background_url || null,
        isTvShow: Boolean(f.is_tv_show),
        year: f.year !== null && f.year !== undefined ? Number(f.year) : null,
        isDeleted: Boolean(f.is_deleted),
        updatedAt: Number(f.updated_at)
      })),
      preferences
    });
  } catch (err) {
    console.error('[sync/pull] error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during sync pull' });
  }
});

router.post('/sync/push', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = Date.now();
    const { progress = [], watchlist = [], favorites = [], preferences = {} } = req.body || {};

    const upsertProgressSql = `
      INSERT INTO watch_progress (
        user_id, url, parent_url, progress_percentage, progress_ms,
        poster_url, title_pl, season, episode, series_title,
        episode_title, is_watched, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (user_id, url) DO UPDATE SET
        parent_url = EXCLUDED.parent_url,
        progress_percentage = EXCLUDED.progress_percentage,
        progress_ms = EXCLUDED.progress_ms,
        poster_url = EXCLUDED.poster_url,
        title_pl = EXCLUDED.title_pl,
        season = EXCLUDED.season,
        episode = EXCLUDED.episode,
        series_title = EXCLUDED.series_title,
        episode_title = EXCLUDED.episode_title,
        is_watched = EXCLUDED.is_watched,
        updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at >= watch_progress.updated_at
    `;

    const upsertMediaSql = (table) => `
      INSERT INTO ${table} (
        user_id, url, title_pl, poster_url, background_url, is_tv_show, year, is_deleted, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (user_id, url) DO UPDATE SET
        title_pl = EXCLUDED.title_pl,
        poster_url = EXCLUDED.poster_url,
        background_url = EXCLUDED.background_url,
        is_tv_show = EXCLUDED.is_tv_show,
        year = EXCLUDED.year,
        is_deleted = EXCLUDED.is_deleted,
        updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at >= ${table}.updated_at
    `;

    const upsertPrefSql = `
      INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, pref_key) DO UPDATE SET
        pref_value = EXCLUDED.pref_value,
        updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at >= user_preferences.updated_at
    `;

    await db.withTransaction(async (client) => {
      // 1. Progress
      if (Array.isArray(progress)) {
        for (const p of progress) {
          if (!p || !p.url) continue;
          await client.query(upsertProgressSql, [
            userId,
            p.url,
            p.parentUrl || null,
            p.progressPercentage !== undefined ? Number(p.progressPercentage) : 0,
            p.progressMs !== undefined ? Number(p.progressMs) : 0,
            p.posterUrl || '',
            p.titlePl || '',
            p.season !== null && p.season !== undefined ? Number(p.season) : null,
            p.episode !== null && p.episode !== undefined ? Number(p.episode) : null,
            p.seriesTitle || null,
            p.episodeTitle || null,
            Boolean(p.isWatched),
            p.updatedAt ? Number(p.updatedAt) : now
          ]);
        }
      }

      // 2. Watchlist
      if (Array.isArray(watchlist)) {
        const querySql = upsertMediaSql('watchlist');
        for (const w of watchlist) {
          if (!w || !w.url) continue;
          await client.query(querySql, [
            userId,
            w.url,
            w.titlePl || '',
            w.posterUrl || '',
            w.backgroundUrl || null,
            Boolean(w.isTvShow),
            w.year !== null && w.year !== undefined ? Number(w.year) : null,
            Boolean(w.isDeleted),
            w.updatedAt ? Number(w.updatedAt) : now
          ]);
        }
      }

      // 3. Favorites
      if (Array.isArray(favorites)) {
        const querySql = upsertMediaSql('favorites');
        for (const f of favorites) {
          if (!f || !f.url) continue;
          await client.query(querySql, [
            userId,
            f.url,
            f.titlePl || '',
            f.posterUrl || '',
            f.backgroundUrl || null,
            Boolean(f.isTvShow),
            f.year !== null && f.year !== undefined ? Number(f.year) : null,
            Boolean(f.isDeleted),
            f.updatedAt ? Number(f.updatedAt) : now
          ]);
        }
      }

      // 4. Preferences
      if (preferences && typeof preferences === 'object') {
        for (const [key, val] of Object.entries(preferences)) {
          if (!key) continue;
          await client.query(upsertPrefSql, [
            userId,
            key,
            String(val),
            now
          ]);
        }
      }
    });

    res.json({
      serverTimestamp: now,
      success: true,
      message: null
    });
  } catch (err) {
    console.error('[sync/push] error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during sync push' });
  }
});

module.exports = router;
