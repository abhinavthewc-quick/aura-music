-- Automatic Wikimedia data never participates in manual profiles, aliases,
-- track ownership, profile versions, or artist-directory revisions.
CREATE TABLE IF NOT EXISTS artist_metadata_cache (
  artist_key TEXT PRIMARY KEY NOT NULL CHECK (length(artist_key) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('ready', 'not-found', 'ambiguous', 'retry')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 16384),
  fetched_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  CHECK (status <> 'ready' OR metadata_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS artist_metadata_active_leases
  ON artist_metadata_cache (lease_until) WHERE lease_token IS NOT NULL;

-- A single atomic reservation coordinates all Pages isolates. Active jobs are
-- counted from unexpired per-key leases, so a crashed isolate cannot leak a
-- permanent slot. UTC-day accounting bounds new-key/public-read amplification.
CREATE TABLE IF NOT EXISTS artist_metadata_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day_start INTEGER NOT NULL DEFAULT 0,
  jobs_started INTEGER NOT NULL DEFAULT 0 CHECK (jobs_started >= 0),
  next_lookup_at INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO artist_metadata_budget (id) VALUES (1);
