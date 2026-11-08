-- BandBook band database (Cloudflare D1). Safe to run more than once.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  folder TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'cho',      -- cho | pdf | image
  text TEXT NOT NULL DEFAULT '',
  mime TEXT,
  file_name TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS songs_seq ON songs(seq);
CREATE TABLE IF NOT EXISTS setlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL DEFAULT '{}',
  rev INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS setlists_seq ON setlists(seq);
-- each member's private annotations
CREATE TABLE IF NOT EXISTS ink (
  member_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  json TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, song_id)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', '0');
INSERT OR IGNORE INTO meta (key, value) VALUES ('folders', '[]');
