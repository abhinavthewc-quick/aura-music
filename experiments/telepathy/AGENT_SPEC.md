# MASTER AGENT SPECIFICATION: Psycho-Acoustic Enrichment & "Slot #1" Telepathy Engine

## 1. SYSTEM OBJECTIVE
You are an autonomous backend and ML engineering agent. Your task is to build a two-part music recommendation engine designed to predict the exact single track (`Slot #1`) a user wants to hear the millisecond they open the app.

Currently, our database only stores `track_id`, `song_name`, and `artist`. You must build:
1. **The Enrichment Pipeline:** An asynchronous worker that takes `(track_id, song_name, artist, audio_path)` and generates a deep psycho-acoustic metadata profile.
2. **The Micro-Telemetry Collector:** An ingestion service that logs subconscious user behaviors (volume spikes, rewinds, interrupted sessions, device context).
3. **The Real-Time Slot #1 Scorer:** A sub-20ms ranking engine that computes a "Telepathy Score" on app launch and returns the #1 Hero Track alongside 2 orthogonal fallback tracks.

---

## 2. PHASE 1: METADATA ENRICHMENT PIPELINE
Create an asynchronous worker (`enrichment_worker.py`) triggered whenever a new track is added or when backfilling existing tracks.

### Step 1.1: Audio DSP Extraction (Using `librosa`)
If the audio file is available, extract the following normalized features (`0.0` to `1.0` where applicable):
- `bpm`: Tempo via `librosa.beat.beat_track`.
- `energy`: Mean Root Mean Square (RMS) energy via `librosa.feature.rms`, normalized against catalog min/max.
- `acoustic_warmth`: Inverse of the normalized spectral centroid (`1.0 - normalized(librosa.feature.spectral_centroid)`). Higher values = warmer/darker sound; lower values = brighter/sharper sound.
- `onset_density`: Average number of rhythmic onsets per second via `librosa.onset.onset_detect` (measures busyness/aggressiveness).

### Step 1.2: External Metadata & Lyrics Fetch
Query external APIs using `song_name` and `artist`:
1. **MusicBrainz / Last.fm API:** Fetch `release_year`, `top_tags` (micro-genres), and `language`.
2. **LRCLIB API (`https://lrclib.net/api/get`):** Fetch synced or plain lyrics using `track_name` and `artist_name`.

### Step 1.3: LLM Psycho-Acoustic Profiling
Pass the `song_name`, `artist`, `dsp_metrics`, `top_tags`, and `lyrics` to an LLM using structured JSON output mode. Use this exact system prompt:

> **SYSTEM PROMPT FOR ENRICHMENT LLM:**
> "You are a musicologist and behavioral psychologist. Analyze the provided song metadata, DSP acoustic metrics, and lyrics. Output ONLY a valid JSON object matching this exact schema:
> {
>   'valence': float (0.0 = devastatingly sad/bleak, 1.0 = euphoric/joyful),
>   'arousal': float (0.0 = ambient/sleep-inducing, 1.0 = chaotic/adrenaline-pumping),
>   'nostalgia_index': float (0.0 to 1.0, likelihood of triggering wistful/nostalgic memory),
>   'catharsis_score': float (0.0 to 1.0, emotional release intensity),
>   'ego_boost': float (0.0 to 1.0, confidence/power/swagger projection),
>   'focus_compatibility': float (0.0 to 1.0, suitability for deep work without lyrical distraction),
>   'primary_psychological_state': string (one of: ['late_night_introspection', 'dopamine_hype', 'melancholic_release', 'deep_focus', 'commute_cruise', 'workout_aggression', 'sunday_calm']),
>   'ideal_time_blocks': array of strings (subset of: ['early_morning', 'morning_commute', 'work_hours', 'evening_commute', 'night_wind_down', 'late_night_3am']),
>   'ideal_weather': array of strings (subset of: ['sunny', 'rain', 'overcast', 'storm', 'clear_night'])
> }"

---

## 3. PHASE 2: DATABASE & TELEMETRY SCHEMA (PostgreSQL)
Execute the following migrations to store enriched track profiles and psychological user telemetry.

```sql
CREATE TABLE tracks_enriched (
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

CREATE TABLE user_telemetry_events (
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

CREATE INDEX idx_telemetry_user_time ON user_telemetry_events(user_id, created_at DESC);
```

---

## 4. PHASE 3: THE REAL-TIME "SLOT #1" SCORING ENGINE

Create `telepathy_scorer.py`. When the user opens the app, the client sends a payload containing:
`{ user_id, current_time_block, day_type, audio_route, current_weather }`

The engine fetches the user's last 30 days of telemetry events and scores their top 50 candidate tracks using this exact mathematical pipeline:

### 4.1 Event Intent Weights (`W_event`)

Assign weights to historical interactions:

* `SEARCH_AND_PLAY`: `+4.0`
* `LOOP_ENABLED`: `+3.5`
* `VOLUME_SPIKE`: `+3.0`
* `SCRUB_BACK`: `+2.5`
* `HERO_CARD_PLAY`: `+2.0`
* `FULL_LISTEN`: `+1.0`
* `EARLY_SKIP`: `-4.0`

### 4.2 Component Calculations for Candidate Track `i` at Current Time `t_now`

1. **Obsession Momentum (`O_i`) — Earworm Decay Curve:**
Calculate exponential time decay over all events $k$ for track $i$ in the last 14 days. Use decay constant $\lambda = 0.025$ per hour (half-life $\approx 27.7$ hours):

$$O_i = \sum_{k} W_{\text{event}, k} \cdot e^{-0.025 \cdot \Delta t_{\text{hours}}(t_{\text{now}}, t_k)}$$


2. **Contextual Sub-Persona Match (`C_i`) — State-Dependent Memory:**
For each past positive event $k$ on track $i$, compute the context match score $M_k$:
* `+0.40` if `event.time_block == current_time_block`
* `+0.30` if `event.audio_route == current_audio_route`
* `+0.15` if `event.day_type == current_day_type`
* `+0.15` if `event.weather == current_weather`
Average the top 5 contextual matches for track $i$, and add `+0.25` bonus if `current_time_block` and `current_weather` match the track's LLM-generated `ideal_time_blocks` and `ideal_weather`.


3. **Zeigarnik Unfinished Loop Boost (`Z_i`):**
Check the user's very last session (within the last 8 hours). If track $i$ logged an `INTERRUPTED_MIDWAY` event (stopped between 25% and 75% completion because headphones disconnected or app closed) and was NOT skipped:
* Set $Z_i = 3.5$
* Otherwise, $Z_i = 0.0$


4. **Satiation & Receptor Fatigue Damper (`F_i`):**
Prevent burnout and repetitive loops:
* If track $i$ was played to completion within the last **90 minutes**: $F_i = 0.08$ (user just heard it; don't show it in Slot #1 unless `LOOP_ENABLED` was active).
* If track $i$ has $> 18$ full plays in the last 5 days AND the last interaction was an `EARLY_SKIP`: $F_i = 0.05$ (earworm habituation complete; retire from Slot #1).
* Otherwise: $F_i = 1.0$.


5. **Final Telepathy Score (`S_i`):**

$$S_i = \left( (0.45 \cdot O_i) + (0.35 \cdot C_i \cdot 10) + (0.20 \cdot Z_i) \right) \times F_i$$

---

## 5. PHASE 4: ORTHOGONAL FALLBACKS & API RESPONSE

Never return 3 identical-sounding songs. If Slot #1 is wrong because the user's mood suddenly shifted, Slot #2 and Slot #3 must represent alternative psychological states.

1. **Slot #1 (Hero Track):** The track with the maximum $S_i$.
2. **Slot #2 (Contextual Twin, Fresh Track):** A track the user has *not* played in the last 72 hours that has the highest cosine similarity (`>= 0.85`) in `psycho_vector` to Slot #1, matching `current_time_block`.
3. **Slot #3 (The Orthogonal Pivot):** The highest-scoring track from the user's candidates whose `primary_state` is different from Slot #1 and whose `psycho_vector` cosine similarity to Slot #1 is `< 0.50` (e.g., if Slot #1 is `melancholic_release`, Slot #3 should be `dopamine_hype` or `deep_focus`).

### Endpoint Specification: `POST /api/v1/home/mind-read`

Return this JSON structure in `< 30ms`:

```json
{
  "hero_slot_1": {
    "track_id": "trk_98231",
    "song_name": "After Dark",
    "artist": "Mr.Kitty",
    "telepathy_score": 9.42,
    "prebuffer_audio_bytes_url": "https://cdn.app.com/chunks/trk_98231_first_10s.aac",
    "psychological_ui_badge": "Back to where you left off" 
  },
  "orthogonal_pivots": [
    {
      "slot": 2,
      "track_id": "trk_10492",
      "ui_badge": "Same vibe, fresh track"
    },
    {
      "slot": 3,
      "track_id": "trk_55310",
      "ui_badge": "Switch the energy"
    }
  ]
}
```

### Rules for `psychological_ui_badge` Generation:

* If $Z_i > 0$: `"Finish where you left off"`
* Else if $O_i > 8.0$: `"Still in your head?"`
* Else if `audio_route == 'car_bluetooth'`: `"For the drive"`
* Else if `current_time_block == 'late_night_3am'`: `"Late night wavelength"`
* Else: `"Right on cue"`

---

## 6. COLD-START PROTOCOL (NEW USERS WITH 0 HISTORY)

If a user has `< 5` telemetry events:

1. Bypass $O_i$ and $Z_i$.
2. Rank catalog tracks exclusively by matching the user's `current_time_block`, `current_weather`, and `audio_route` against `tracks_enriched.ideal_time_blocks` and `ideal_weather`, weighted by global `HERO_CARD_PLAY` conversion rate in that exact time/weather bucket.
