-- Individual track corrections take precedence over an earlier artist rename.
-- A later intentional batch rename can replace them in the same transaction.
CREATE TABLE IF NOT EXISTS artist_track_edits (
  track_id TEXT PRIMARY KEY NOT NULL,
  artist_name TEXT NOT NULL CHECK (length(artist_name) BETWEEN 1 AND 200),
  updated INTEGER NOT NULL
);
