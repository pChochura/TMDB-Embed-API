-- TMDB Embed API - Auth & Preferences Sync Database Schema
-- Compatible with PostgreSQL 12+

-- 1. Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

-- 2. Watch Progress & History
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

-- 3. Watchlist
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

-- 4. Favorites
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

-- 5. User Preferences (Key-Value)
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT NOT NULL,
    pref_key TEXT NOT NULL,
    pref_value TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, pref_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pref_user_updated ON user_preferences(user_id, updated_at);
