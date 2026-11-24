const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_progress (
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    parent_url TEXT,
    progress_percentage REAL NOT NULL DEFAULT 0.0,
    progress_ms BIGINT NOT NULL DEFAULT 0,
    poster_url TEXT DEFAULT '',
    title_pl TEXT DEFAULT '',
    season INTEGER,
    episode INTEGER,
    series_title TEXT,
    episode_title TEXT,
    is_watched BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, url),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_progress_user_updated ON watch_progress(user_id, updated_at);

CREATE TABLE IF NOT EXISTS watchlist (
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title_pl TEXT DEFAULT '',
    poster_url TEXT DEFAULT '',
    background_url TEXT,
    is_tv_show BOOLEAN NOT NULL DEFAULT FALSE,
    year INTEGER,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, url),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_updated ON watchlist(user_id, updated_at);

CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title_pl TEXT DEFAULT '',
    poster_url TEXT DEFAULT '',
    background_url TEXT,
    is_tv_show BOOLEAN NOT NULL DEFAULT FALSE,
    year INTEGER,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, url),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_favorites_user_updated ON favorites(user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT NOT NULL,
    pref_key TEXT NOT NULL,
    pref_value TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, pref_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pref_user_updated ON user_preferences(user_id, updated_at);
`;

function migrate(jsonPath, dbPath) {
  console.log(`[migrate] Loading backup from ${jsonPath}...`);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  
  console.log(`[migrate] Initializing SQLite database at ${dbPath}...`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  const statements = SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    db.exec(stmt);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Users
    if (Array.isArray(data.users)) {
      const stmt = db.prepare('INSERT OR REPLACE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
      for (const u of data.users) {
        stmt.run(u.id, u.username, u.password_hash, Number(u.created_at));
      }
      console.log(`[migrate] Imported ${data.users.length} users`);
    }

    // 2. Favorites
    if (Array.isArray(data.favorites)) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO favorites (user_id, url, title_pl, poster_url, background_url, is_tv_show, year, is_deleted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const f of data.favorites) {
        stmt.run(
          f.user_id,
          f.url,
          f.title_pl || '',
          f.poster_url || '',
          f.background_url || null,
          f.is_tv_show ? 1 : 0,
          f.year != null ? Number(f.year) : null,
          f.is_deleted ? 1 : 0,
          Number(f.updated_at)
        );
      }
      console.log(`[migrate] Imported ${data.favorites.length} favorites`);
    }

    // 3. Watchlist
    if (Array.isArray(data.watchlist)) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO watchlist (user_id, url, title_pl, poster_url, background_url, is_tv_show, year, is_deleted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const w of data.watchlist) {
        stmt.run(
          w.user_id,
          w.url,
          w.title_pl || '',
          w.poster_url || '',
          w.background_url || null,
          w.is_tv_show ? 1 : 0,
          w.year != null ? Number(w.year) : null,
          w.is_deleted ? 1 : 0,
          Number(w.updated_at)
        );
      }
      console.log(`[migrate] Imported ${data.watchlist.length} watchlist items`);
    }

    // 4. Watch Progress
    if (Array.isArray(data.watch_progress)) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO watch_progress (
          user_id, url, parent_url, progress_percentage, progress_ms, poster_url, title_pl,
          season, episode, series_title, episode_title, is_watched, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of data.watch_progress) {
        stmt.run(
          p.user_id,
          p.url,
          p.parent_url || null,
          Number(p.progress_percentage || 0),
          Number(p.progress_ms || 0),
          p.poster_url || '',
          p.title_pl || '',
          p.season != null ? Number(p.season) : null,
          p.episode != null ? Number(p.episode) : null,
          p.series_title || null,
          p.episode_title || null,
          p.is_watched ? 1 : 0,
          Number(p.updated_at)
        );
      }
      console.log(`[migrate] Imported ${data.watch_progress.length} watch_progress records`);
    }

    // 5. User Preferences
    if (Array.isArray(data.user_preferences)) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO user_preferences (user_id, pref_key, pref_value, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const up of data.user_preferences) {
        stmt.run(up.user_id, up.pref_key, up.pref_value, Number(up.updated_at));
      }
      console.log(`[migrate] Imported ${data.user_preferences.length} user_preferences`);
    }

    db.exec('COMMIT');
    console.log('[migrate] Migration committed successfully!');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[migrate] Migration failed:', err);
    throw err;
  }
}

if (require.main === module) {
  const jsonPath = process.argv[2] || 'tiwi_backup.json';
  const dbPath = process.argv[3] || 'test_tiwi.db';
  migrate(jsonPath, dbPath);
}

module.exports = { migrate };
