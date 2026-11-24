const { Pool, types } = require('pg');

// Parse PostgreSQL int8 (BIGINT) as Number instead of String to match JSON numeric timestamps
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

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

let pool = null;
let sqliteDb = null;
let activeDriver = 'postgres'; // 'postgres' or 'sqlite'
let initialized = false;

function determineDriver() {
  if (process.env.DATABASE_DRIVER === 'sqlite') return 'sqlite';
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('sqlite')) return 'sqlite';
  if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL && !process.env.POSTGRES_HOST) {
    return 'sqlite';
  }
  return 'postgres';
}

function getSqliteDb() {
  if (!sqliteDb) {
    const { DatabaseSync } = require('node:sqlite');
    let dbPath = ':memory:';
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('sqlite://')) {
      dbPath = process.env.DATABASE_URL.replace('sqlite://', '');
    } else if (process.env.SQLITE_DB_PATH) {
      dbPath = process.env.SQLITE_DB_PATH;
    }
    sqliteDb = new DatabaseSync(dbPath);
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
  }
  return sqliteDb;
}

function getPool() {
  if (!pool) {
    if (process.env.DATABASE_URL) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
      });
    } else {
      pool = new Pool({
        host: process.env.POSTGRES_HOST || '127.0.0.1',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || 'postgres',
        database: process.env.POSTGRES_DB || 'tmdb_sync',
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
      });
    }
    pool.on('error', (err) => {
      console.error('[db] Unexpected error on idle PostgreSQL client:', err.message);
    });
  }
  return pool;
}

async function initDb(maxRetries = 5, retryDelayMs = 2000) {
  activeDriver = determineDriver();

  if (activeDriver === 'sqlite') {
    const db = getSqliteDb();
    // Split and execute SQLite schema
    const statements = SCHEMA_SQL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      db.exec(stmt);
    }
    initialized = true;
    console.log('[db] SQLite database initialized successfully');
    return;
  }

  // PostgreSQL initialization with retry loop for container orchestration
  const p = getPool();
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      attempt++;
      await p.query(SCHEMA_SQL);
      initialized = true;
      console.log(`[db] PostgreSQL database schema initialized successfully (attempt ${attempt})`);
      return;
    } catch (err) {
      console.warn(`[db] PostgreSQL connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt >= maxRetries) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[db] Falling back to in-memory SQLite database for local non-production environment');
          activeDriver = 'sqlite';
          return initDb();
        }
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function normalizeSqliteParams(params) {
  return params.map((val) => (typeof val === 'boolean' ? (val ? 1 : 0) : val));
}

async function query(text, params = []) {
  if (!initialized) {
    await initDb();
  }

  if (activeDriver === 'sqlite') {
    const db = getSqliteDb();
    const isSelect = /^\s*SELECT/i.test(text);
    // Replace PostgreSQL $1, $2 with ? for SQLite
    const sqliteSql = text.replace(/\$\d+/g, '?');
    const stmt = db.prepare(sqliteSql);
    const normalized = normalizeSqliteParams(params);
    if (isSelect) {
      const rows = stmt.all(...normalized);
      return { rows, rowCount: rows.length };
    } else {
      const result = stmt.run(...normalized);
      return { rows: [], rowCount: result.changes };
    }
  }

  const p = getPool();
  return p.query(text, params);
}

async function withTransaction(fn) {
  if (!initialized) {
    await initDb();
  }

  if (activeDriver === 'sqlite') {
    const db = getSqliteDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const tx = {
        query: async (text, params = []) => {
          const isSelect = /^\s*SELECT/i.test(text);
          const sqliteSql = text.replace(/\$\d+/g, '?');
          const stmt = db.prepare(sqliteSql);
          const normalized = normalizeSqliteParams(params);
          if (isSelect) {
            const rows = stmt.all(...normalized);
            return { rows, rowCount: rows.length };
          } else {
            const result = stmt.run(...normalized);
            return { rows: [], rowCount: result.changes };
          }
        }
      };
      const result = await fn(tx);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        // ignore rollback errors if transaction was not active
      }
      throw err;
    }
  }

  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      query: (text, params) => client.query(text, params)
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch (e) {
      // ignore
    }
    sqliteDb = null;
  }
  initialized = false;
}

function getActiveDriver() {
  return activeDriver;
}

module.exports = {
  initDb,
  query,
  withTransaction,
  closeDb,
  getActiveDriver
};
