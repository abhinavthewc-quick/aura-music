-- Operational telemetry and audit history; existing audio records stay intact.
CREATE TABLE IF NOT EXISTS audio_worker_runs (
  owner TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  parallelism INTEGER NOT NULL,
  recipe TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  finished_at INTEGER,
  attempted INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS audio_job_progress (
  track_ref TEXT PRIMARY KEY REFERENCES audio_tracks(ref) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  stage TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_processing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_ref TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_processing_events_track ON audio_processing_events(track_ref, id DESC);
