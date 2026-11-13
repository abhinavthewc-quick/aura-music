-- Phase 2: Database & Telemetry Schema (PostgreSQL)
-- Master Agent Specification Migration

CREATE TABLE IF NOT EXISTS tracks_enriched (
    track_id VARCHAR(64) PRIMARY KEY,
    song_name TEXT NOT NULL,
    artist TEXT NOT NULL,
    bpm FLOAT,
    energy FLOAT,
    acoustic_warmth FLOAT,
    onset_density FLOAT,
    valence FLOAT,
    arousal FLOAT,
    nostalgia_index FLOAT,
    catharsis_score FLOAT,
    ego_boost FLOAT,
    focus_compatibility FLOAT,
    primary_state VARCHAR(50),
    ideal_time_blocks TEXT[],
    ideal_weather TEXT[],
    psycho_vector FLOAT[], -- 8-dimensional array: [energy, acoustic_warmth, valence, arousal, nostalgia_index, catharsis_score, ego_boost, focus_compatibility]
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_telemetry_events (
    event_id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    track_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    -- Allowed event_types:
    -- 'SEARCH_AND_PLAY'     (User manually searched for this specific track)
    -- 'HERO_CARD_PLAY'      (User tapped the Slot #1 prediction within 5s of app open)
    -- 'FULL_LISTEN'         (Listened > 80% of duration)
    -- 'VOLUME_SPIKE'        (User raised volume >= 15% mid-track)
    -- 'SCRUB_BACK'          (User rewound track 10-45 seconds to replay a section)
    -- 'LOOP_ENABLED'        (User toggled single-track repeat)
    -- 'INTERRUPTED_MIDWAY'  (App closed or audio disconnected between 25% and 75% completion)
    -- 'EARLY_SKIP'          (Skipped under 10 seconds)
    completion_ratio FLOAT DEFAULT 0.0,
    time_block VARCHAR(32) NOT NULL,   -- 'early_morning', 'morning_commute', 'work_hours', 'evening_commute', 'night_wind_down', 'late_night_3am'
    day_type VARCHAR(16) NOT NULL,     -- 'weekday' or 'weekend'
    audio_route VARCHAR(32) NOT NULL,  -- 'headphones', 'car_bluetooth', 'phone_speaker', 'external_speaker'
    weather VARCHAR(32) DEFAULT 'clear',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_user_time ON user_telemetry_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_track_time ON user_telemetry_events(track_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_enriched_primary_state ON tracks_enriched(primary_state);
