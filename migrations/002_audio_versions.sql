-- The archive holds bytes; D1 owns processing state and published renditions.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS audio_tracks (
  ref TEXT PRIMARY KEY,
  original_id TEXT NOT NULL UNIQUE,
  original_path TEXT NOT NULL,
  original_hash TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_renditions (
  track_ref TEXT NOT NULL REFERENCES audio_tracks(ref) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('bass', 'bass-reverb')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  path TEXT,
  duration REAL,
  bytes INTEGER,
  sha256 TEXT,
  recipe TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (track_ref, mode),
  CHECK (status != 'ready' OR (path IS NOT NULL AND bytes > 0))
);
CREATE INDEX IF NOT EXISTS audio_renditions_work ON audio_renditions(status, retry_after);
CREATE INDEX IF NOT EXISTS audio_tracks_lease ON audio_tracks(active, lease_until);
