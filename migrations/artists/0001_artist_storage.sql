-- Uploaded portraits are immutable, bounded to 1.5 MiB (below D1's 2 MiB row
-- limit). Profile, image, aliases and track overrides commit in one D1 batch.
CREATE TABLE IF NOT EXISTS artist_profiles (
  artist_key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  img TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  genres TEXT NOT NULL DEFAULT '[]',
  social TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  source TEXT NOT NULL CHECK (source IN ('admin', 'manifest')),
  mutation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artist_aliases (
  alias_key TEXT PRIMARY KEY NOT NULL,
  artist_key TEXT NOT NULL REFERENCES artist_profiles(artist_key)
);
CREATE INDEX IF NOT EXISTS artist_aliases_profile ON artist_aliases(artist_key);

CREATE TABLE IF NOT EXISTS artist_images (
  image_id TEXT PRIMARY KEY NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 12 AND 1572864),
  etag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artist_track_overrides (
  track_id TEXT PRIMARY KEY NOT NULL,
  artist_key TEXT NOT NULL REFERENCES artist_profiles(artist_key),
  artist_name TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artist_track_overrides_profile ON artist_track_overrides(artist_key);

CREATE TABLE IF NOT EXISTS artist_catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO artist_catalog_state (id, revision) VALUES (1, 0);
