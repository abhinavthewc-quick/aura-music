/* Psycho-Acoustic Enrichment & "Slot #1" Telepathy Engine.
 *
 * Cloudflare Edge & Local-First Architecture.
 * Purely mathematical calculations — zero AI / LLM dependencies.
 *
 * Formulas:
 * - Obsession Momentum: O_i = sum_k W_k * exp(-0.025 * delta_t_hours)
 * - Contextual Match: C_i = avg(top 5 M_k) + bonus (0.25 if ideal block & weather match)
 * - Zeigarnik Loop Boost: Z_i = 3.5 if interrupted midway in last 8h and not skipped
 * - Fatigue Damper: F_i = 0.08 (played in 90m), 0.05 (habituation + early skip), else 1.0
 * - Final Telepathy Score: S_i = ((0.45 * O_i) + (0.35 * C_i * 10) + (0.20 * Z_i)) * F_i
 */

export type PsychologicalState =
  | 'late_night_introspection'
  | 'dopamine_hype'
  | 'melancholic_release'
  | 'deep_focus'
  | 'commute_cruise'
  | 'workout_aggression'
  | 'sunday_calm';

export type TimeBlock =
  | 'early_morning'
  | 'morning_commute'
  | 'work_hours'
  | 'evening_commute'
  | 'night_wind_down'
  | 'late_night_3am';

export type DayType = 'weekday' | 'weekend';

export type AudioRoute =
  | 'headphones'
  | 'car_bluetooth'
  | 'phone_speaker'
  | 'external_speaker';

export type TelemetryEventType =
  | 'SEARCH_AND_PLAY'
  | 'HERO_CARD_PLAY'
  | 'FULL_LISTEN'
  | 'VOLUME_SPIKE'
  | 'SCRUB_BACK'
  | 'LOOP_ENABLED'
  | 'INTERRUPTED_MIDWAY'
  | 'EARLY_SKIP';

export interface TelemetryEvent {
  eventId?: number;
  userId: string;
  trackId: string;
  eventType: TelemetryEventType;
  completionRatio: number;
  timeBlock: TimeBlock;
  dayType: DayType;
  audioRoute: AudioRoute;
  weather: string;
  createdAt: string; // ISO string
}

export interface EnrichedTrack {
  trackId: string;
  songName: string;
  artist: string;
  bpm: number;
  energy: number;
  acousticWarmth: number;
  onsetDensity: number;
  valence: number;
  arousal: number;
  nostalgiaIndex: number;
  catharsisScore: number;
  egoBoost: number;
  focusCompatibility: number;
  primaryState: PsychologicalState;
  idealTimeBlocks: TimeBlock[];
  idealWeather: string[];
  // 8D vector: [energy, warmth, valence, arousal, nostalgia, catharsis, ego, focus]
  psychoVector: number[];
}

export interface MindReadRequest {
  userId: string;
  currentTimeBlock: TimeBlock;
  dayType: DayType;
  audioRoute: AudioRoute;
  currentWeather: string;
}

export interface HeroSlot1 {
  trackId: string;
  songName: string;
  artist: string;
  telepathyScore: number;
  prebufferAudioBytesUrl: string;
  psychologicalUiBadge: string;
}

export interface OrthogonalPivot {
  slot: number;
  trackId: string;
  uiBadge: string;
}

export interface MindReadResponse {
  heroSlot1: HeroSlot1;
  orthogonalPivots: OrthogonalPivot[];
}

// 4.1 Event Intent Weights (W_event)
export const EVENT_WEIGHTS: Record<TelemetryEventType, number> = {
  SEARCH_AND_PLAY: 4.0,
  LOOP_ENABLED: 3.5,
  VOLUME_SPIKE: 3.0,
  SCRUB_BACK: 2.5,
  HERO_CARD_PLAY: 2.0,
  FULL_LISTEN: 1.0,
  EARLY_SKIP: -4.0,
  INTERRUPTED_MIDWAY: 0.0,
};

export const DECAY_LAMBDA = 0.025; // per hour (half-life ≈ 27.7 hours)

/* =========================================================================
   PURE MATHEMATICAL PSYCHO-ACOUSTIC VECTOR TRANSFORMS (NO AI)
   ========================================================================= */

const STATE_CENTROIDS: Record<PsychologicalState, number[]> = {
  late_night_introspection: [0.25, 0.85, 0.35, 0.25, 0.85, 0.60, 0.20, 0.85],
  dopamine_hype:            [0.85, 0.20, 0.85, 0.85, 0.25, 0.70, 0.85, 0.25],
  melancholic_release:      [0.30, 0.75, 0.15, 0.35, 0.90, 0.90, 0.20, 0.65],
  deep_focus:               [0.25, 0.80, 0.55, 0.25, 0.40, 0.30, 0.25, 0.95],
  commute_cruise:           [0.65, 0.45, 0.65, 0.60, 0.50, 0.55, 0.70, 0.55],
  workout_aggression:       [0.95, 0.15, 0.50, 0.95, 0.15, 0.85, 0.95, 0.20],
  sunday_calm:              [0.25, 0.85, 0.75, 0.20, 0.70, 0.40, 0.30, 0.80],
};

const STATE_TIME_BLOCKS: Record<PsychologicalState, TimeBlock[]> = {
  late_night_introspection: ['night_wind_down', 'late_night_3am'],
  dopamine_hype: ['evening_commute', 'morning_commute', 'work_hours'],
  melancholic_release: ['night_wind_down', 'late_night_3am', 'evening_commute'],
  deep_focus: ['work_hours', 'early_morning'],
  commute_cruise: ['morning_commute', 'evening_commute'],
  workout_aggression: ['morning_commute', 'evening_commute', 'work_hours'],
  sunday_calm: ['early_morning', 'night_wind_down'],
};

const STATE_WEATHER: Record<PsychologicalState, string[]> = {
  late_night_introspection: ['clear_night', 'rain', 'overcast'],
  dopamine_hype: ['sunny', 'storm'],
  melancholic_release: ['rain', 'overcast', 'clear_night'],
  deep_focus: ['rain', 'overcast', 'sunny'],
  commute_cruise: ['sunny', 'clear_night'],
  workout_aggression: ['storm', 'sunny'],
  sunday_calm: ['sunny', 'clear_night', 'overcast'],
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Pure mathematical derivation of the 8D psycho-vector from audio features.
 */
export function deriveMathematicalPsychoProfile(
  trackId: string,
  songName: string,
  artist: string,
  bpm: number,
  energy: number,
  acousticWarmth: number,
  onsetDensity: number,
  releaseYear?: number
): EnrichedTrack {
  const e = clamp(energy, 0.0, 1.0);
  const w = clamp(acousticWarmth, 0.0, 1.0);
  const odNorm = clamp(onsetDensity / 8.0, 0.0, 1.0);

  // 1. Valence: Brighter sound (1-W) + BPM drive
  const valence = clamp(0.45 + (0.35 * ((bpm - 80.0) / 100.0)) + (0.20 * (1.0 - w)), 0.05, 0.95);

  // 2. Arousal: Russell's Circumplex (Energy + BPM + Onsets)
  const arousal = clamp((0.45 * e) + (0.35 * (bpm / 180.0)) + (0.20 * odNorm), 0.05, 0.98);

  // 3. Nostalgia Index: Warmth + lower arousal + age factor
  const yearDelta = Math.max(0, 2026 - (releaseYear || 2018));
  const yearFactor = Math.min(1.0, yearDelta / 30.0);
  const nostalgia = clamp((0.45 * w) + (0.35 * (1.0 - arousal)) + (0.20 * yearFactor), 0.05, 0.95);

  // 4. Catharsis Score: Arousal + emotional polarity
  const catharsis = clamp((0.50 * arousal) + (0.50 * Math.abs(valence - 0.5) * 2.0), 0.05, 0.95);

  // 5. Ego Boost: Energy + rhythmic onsets + arousal
  const ego = clamp((0.45 * e) + (0.35 * odNorm) + (0.20 * arousal), 0.05, 0.95);

  // 6. Focus Compatibility: Low onsets + warmth + steady energy
  const focus = clamp((0.45 * (1.0 - odNorm)) + (0.35 * w) + (0.20 * (1.0 - Math.abs(e - 0.35))), 0.05, 0.95);

  const vector = [
    Number(e.toFixed(4)),
    Number(w.toFixed(4)),
    Number(valence.toFixed(4)),
    Number(arousal.toFixed(4)),
    Number(nostalgia.toFixed(4)),
    Number(catharsis.toFixed(4)),
    Number(ego.toFixed(4)),
    Number(focus.toFixed(4)),
  ];

  // Centroid argmin classifier
  let bestState: PsychologicalState = 'commute_cruise';
  let minDist = Infinity;
  for (const [st, centroid] of Object.entries(STATE_CENTROIDS) as [PsychologicalState, number[]][]) {
    let d = 0;
    for (let i = 0; i < 8; i++) {
      const diff = vector[i] - centroid[i];
      d += diff * diff;
    }
    d = Math.sqrt(d);
    if (d < minDist) {
      minDist = d;
      bestState = st;
    }
  }

  return {
    trackId,
    songName,
    artist,
    bpm: Number(bpm.toFixed(2)),
    energy: Number(e.toFixed(4)),
    acousticWarmth: Number(w.toFixed(4)),
    onsetDensity: Number(onsetDensity.toFixed(4)),
    valence: Number(valence.toFixed(4)),
    arousal: Number(arousal.toFixed(4)),
    nostalgiaIndex: Number(nostalgia.toFixed(4)),
    catharsisScore: Number(catharsis.toFixed(4)),
    egoBoost: Number(ego.toFixed(4)),
    focusCompatibility: Number(focus.toFixed(4)),
    primaryState: bestState,
    idealTimeBlocks: STATE_TIME_BLOCKS[bestState],
    idealWeather: STATE_WEATHER[bestState],
    psychoVector: vector,
  };
}

/* =========================================================================
   MATHEMATICAL SCORING ENGINE (SUB-20MS)
   ========================================================================= */

export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0.0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0.0;
  return clamp(dot / (Math.sqrt(normA) * Math.sqrt(normB)), -1.0, 1.0);
}

/**
 * 4.2.1 Obsession Momentum (O_i) — Earworm Decay Curve
 */
export function computeObsessionMomentum(
  eventsForTrack: TelemetryEvent[],
  tNowMs: number
): number {
  const cutoff14d = tNowMs - 14 * 24 * 3600 * 1000;
  let momentum = 0.0;

  for (const ev of eventsForTrack) {
    const evTime = new Date(ev.createdAt).getTime();
    if (isNaN(evTime) || evTime < cutoff14d) continue;

    const weight = EVENT_WEIGHTS[ev.eventType] || 0.0;
    const dtHours = Math.max(0, tNowMs - evTime) / (3600 * 1000);
    const decay = Math.exp(-DECAY_LAMBDA * dtHours);
    momentum += weight * decay;
  }

  return momentum;
}

/**
 * 4.2.2 Contextual Sub-Persona Match (C_i) — State-Dependent Memory
 */
export function computeContextMatch(
  eventsForTrack: TelemetryEvent[],
  track: EnrichedTrack,
  currentTimeBlock: TimeBlock,
  currentDayType: DayType,
  currentAudioRoute: AudioRoute,
  currentWeather: string
): number {
  const positiveMatches: number[] = [];

  for (const ev of eventsForTrack) {
    const weight = EVENT_WEIGHTS[ev.eventType] || 0.0;
    if (weight <= 0.0) continue; // Positive events only

    let mK = 0.0;
    if (ev.timeBlock === currentTimeBlock) mK += 0.40;
    if (ev.audioRoute === currentAudioRoute) mK += 0.30;
    if (ev.dayType === currentDayType) mK += 0.15;
    if (ev.weather === currentWeather) mK += 0.15;

    positiveMatches.push(mK);
  }

  let avgM = 0.0;
  if (positiveMatches.length > 0) {
    positiveMatches.sort((a, b) => b - a);
    const top5 = positiveMatches.slice(0, 5);
    avgM = top5.reduce((sum, val) => sum + val, 0) / top5.length;
  }

  // +0.25 bonus if current time block & weather match ideal blocks/weather
  let bonus = 0.0;
  if (
    track.idealTimeBlocks.includes(currentTimeBlock) &&
    track.idealWeather.includes(currentWeather)
  ) {
    bonus = 0.25;
  }

  return avgM + bonus;
}

/**
 * 4.2.3 Zeigarnik Unfinished Loop Boost (Z_i)
 */
export function computeZeigarnikBoost(
  allRecentEvents: TelemetryEvent[],
  candidateTrackId: string,
  tNowMs: number
): number {
  const cutoff8h = tNowMs - 8 * 3600 * 1000;
  const recent = allRecentEvents.filter(
    (e) => new Date(e.createdAt).getTime() >= cutoff8h
  );
  if (!recent.length) return 0.0;

  // Sort descending by created_at
  recent.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Track events in last 8h
  const trackEvents = recent.filter((e) => e.trackId === candidateTrackId);
  if (!trackEvents.length) return 0.0;

  const interruptedIdx = trackEvents.findIndex(
    (e) => e.eventType === 'INTERRUPTED_MIDWAY'
  );
  if (interruptedIdx === -1) return 0.0;

  // Check if track was skipped subsequent to the interruption
  const subsequent = trackEvents.slice(0, interruptedIdx);
  const wasSkipped = subsequent.some((e) => e.eventType === 'EARLY_SKIP');
  if (wasSkipped) return 0.0;

  return 3.5;
}

/**
 * 4.2.4 Satiation & Receptor Fatigue Damper (F_i)
 */
export function computeFatigueDamper(
  eventsForTrack: TelemetryEvent[],
  tNowMs: number
): number {
  const cutoff90m = tNowMs - 90 * 60 * 1000;
  const cutoff5d = tNowMs - 5 * 24 * 3600 * 1000;

  let completedIn90m = false;
  let loopEnabledRecently = false;
  let fullPlays5d = 0;

  for (const ev of eventsForTrack) {
    const evTime = new Date(ev.createdAt).getTime();
    if (isNaN(evTime)) continue;

    if (evTime >= cutoff90m) {
      if (ev.eventType === 'LOOP_ENABLED') loopEnabledRecently = true;
      if (ev.eventType === 'FULL_LISTEN' || ev.completionRatio >= 0.80) {
        completedIn90m = true;
      }
    }

    if (evTime >= cutoff5d) {
      if (ev.eventType === 'FULL_LISTEN' || ev.completionRatio >= 0.80) {
        fullPlays5d++;
      }
    }
  }

  // Played to completion within 90 minutes without loop
  if (completedIn90m && !loopEnabledRecently) {
    return 0.08;
  }

  // > 18 full plays in last 5 days AND last interaction was EARLY_SKIP
  if (fullPlays5d > 18 && eventsForTrack.length > 0) {
    const sorted = [...eventsForTrack].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    if (sorted[0]?.eventType === 'EARLY_SKIP') {
      return 0.05;
    }
  }

  return 1.0;
}

/**
 * 4.2.5 Final Telepathy Score (S_i)
 */
export function computeTelepathyScore(
  oI: number,
  cI: number,
  zI: number,
  fI: number
): number {
  const base = 0.45 * oI + 0.35 * (cI * 10.0) + 0.20 * zI;
  return Number((base * fI).toFixed(4));
}

/**
 * Psychological UI Badge Rules
 */
export function generatePsychologicalBadge(
  zI: number,
  oI: number,
  audioRoute: AudioRoute,
  currentTimeBlock: TimeBlock
): string {
  if (zI > 0) return 'Finish where you left off';
  if (oI > 8.0) return 'Still in your head?';
  if (audioRoute === 'car_bluetooth') return 'For the drive';
  if (currentTimeBlock === 'late_night_3am') return 'Late night wavelength';
  return 'Right on cue';
}

/**
 * Cold-Start Protocol (Users with < 5 events)
 */
export function coldStartRankTracks(
  catalog: EnrichedTrack[],
  request: MindReadRequest
): { track: EnrichedTrack; score: number }[] {
  const ranked = catalog.map((trk) => {
    let matchScore = 0.0;
    if (trk.idealTimeBlocks.includes(request.currentTimeBlock)) matchScore += 0.50;
    if (trk.idealWeather.includes(request.currentWeather)) matchScore += 0.30;

    if (request.audioRoute === 'car_bluetooth' && ['commute_cruise', 'dopamine_hype'].includes(trk.primaryState)) {
      matchScore += 0.20;
    } else if (request.audioRoute === 'headphones' && ['deep_focus', 'late_night_introspection', 'melancholic_release'].includes(trk.primaryState)) {
      matchScore += 0.20;
    } else if (['sunday_calm', 'dopamine_hype'].includes(trk.primaryState)) {
      matchScore += 0.20;
    }

    return { track: trk, score: matchScore };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Phase 4: Orthogonal Fallbacks Selection
 */
export function selectOrthogonalSlots(
  candidates: { track: EnrichedTrack; sI: number; oI: number; cI: number; zI: number; fI: number }[],
  allCatalog: EnrichedTrack[],
  telemetry30d: TelemetryEvent[],
  request: MindReadRequest,
  prebufferBaseUrl = 'https://cdn.app.com/chunks',
  tNowMs = Date.now()
): MindReadResponse {
  if (!candidates.length) {
    throw new Error('No candidate tracks available');
  }

  // 1. Slot #1 (Hero Track): argmax(S_i)
  const hero = candidates[0];
  const heroBadge = generatePsychologicalBadge(
    hero.zI,
    hero.oI,
    request.audioRoute,
    request.currentTimeBlock
  );

  // 2. Tracks played in the last 72 hours
  const cutoff72h = tNowMs - 72 * 3600 * 1000;
  const played72hIds = new Set(
    telemetry30d
      .filter((e) => new Date(e.createdAt).getTime() >= cutoff72h && e.eventType !== 'EARLY_SKIP')
      .map((e) => e.trackId)
  );

  // 3. Slot #2 (Contextual Twin, Fresh Track):
  // Not played in 72h, cosine similarity >= 0.85, matching current_time_block
  let slot2Candidate: EnrichedTrack | null = null;
  let bestTwinSim = -1.0;
  const pool = allCatalog.length ? allCatalog : candidates.map((c) => c.track);

  for (const trk of pool) {
    if (trk.trackId === hero.track.trackId) continue;
    if (played72hIds.has(trk.trackId)) continue;
    if (!trk.idealTimeBlocks.includes(request.currentTimeBlock)) continue;

    const sim = computeCosineSimilarity(hero.track.psychoVector, trk.psychoVector);
    if (sim > bestTwinSim) {
      bestTwinSim = sim;
      slot2Candidate = trk;
    }
  }

  // Fallback if no unplayed track matched
  if (!slot2Candidate) {
    for (const trk of pool) {
      if (trk.trackId !== hero.track.trackId) {
        const sim = computeCosineSimilarity(hero.track.psychoVector, trk.psychoVector);
        if (sim > bestTwinSim) {
          bestTwinSim = sim;
          slot2Candidate = trk;
        }
      }
    }
  }

  // 4. Slot #3 (The Orthogonal Pivot):
  // Highest scoring candidate whose primary_state != Slot #1 and cosine similarity < 0.50
  let slot3Candidate: EnrichedTrack | null = null;
  for (const c of candidates) {
    if (c.track.trackId === hero.track.trackId) continue;
    if (slot2Candidate && c.track.trackId === slot2Candidate.trackId) continue;

    const sim = computeCosineSimilarity(hero.track.psychoVector, c.track.psychoVector);
    if (c.track.primaryState !== hero.track.primaryState && sim < 0.50) {
      slot3Candidate = c.track;
      break;
    }
  }

  // Fallback for Slot 3
  if (!slot3Candidate) {
    for (const c of candidates) {
      if (c.track.trackId !== hero.track.trackId && (!slot2Candidate || c.track.trackId !== slot2Candidate.trackId)) {
        if (c.track.primaryState !== hero.track.primaryState) {
          slot3Candidate = c.track;
          break;
        }
      }
    }
  }
  if (!slot3Candidate && candidates.length > 1) {
    slot3Candidate = candidates[1].track.trackId !== slot2Candidate?.trackId
      ? candidates[1].track
      : (candidates[2]?.track || candidates[1].track);
  }

  const pivots: OrthogonalPivot[] = [];
  if (slot2Candidate) {
    pivots.push({
      slot: 2,
      trackId: slot2Candidate.trackId,
      uiBadge: 'Same vibe, fresh track',
    });
  }
  if (slot3Candidate) {
    pivots.push({
      slot: 3,
      trackId: slot3Candidate.trackId,
      uiBadge: 'Switch the energy',
    });
  }

  return {
    heroSlot1: {
      trackId: hero.track.trackId,
      songName: hero.track.songName,
      artist: hero.track.artist,
      telepathyScore: Number(hero.sI.toFixed(2)),
      prebufferAudioBytesUrl: `${prebufferBaseUrl}/${hero.track.trackId}_first_10s.aac`,
      psychologicalUiBadge: heroBadge,
    },
    orthogonalPivots: pivots,
  };
}

/* =========================================================================
   LOCAL-FIRST CLIENT TELEMETRY COLLECTOR & STORAGE
   ========================================================================= */

const TELEMETRY_STORAGE_KEY = 'aura_telemetry_events_v1';
const MAX_STORED_EVENTS = 400;

export function loadStoredTelemetry(): TelemetryEvent[] {
  try {
    const raw = localStorage.getItem(TELEMETRY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveStoredTelemetry(events: TelemetryEvent[]): void {
  try {
    const trimmed = events.slice(-MAX_STORED_EVENTS);
    localStorage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // quota exceeded or disabled
  }
}

export function logSubconsciousEvent(
  trackId: string,
  eventType: TelemetryEventType,
  completionRatio = 0.0,
  audioRoute: AudioRoute = 'headphones',
  weather = 'clear'
): TelemetryEvent {
  const event: TelemetryEvent = {
    userId: 'local_user',
    trackId,
    eventType,
    completionRatio,
    timeBlock: detectCurrentTimeBlock(),
    dayType: detectCurrentDayType(),
    audioRoute,
    weather,
    createdAt: new Date().toISOString(),
  };

  const existing = loadStoredTelemetry();
  existing.push(event);
  saveStoredTelemetry(existing);

  // Dispatch background beacon to Cloudflare Pages Functions if reachable
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(
        '/api/v1/telemetry/events',
        new Blob([JSON.stringify(event)], { type: 'application/json' })
      );
    }
  } catch {
    // offline or ignored
  }

  return event;
}

export function detectCurrentTimeBlock(date = new Date()): TimeBlock {
  const hour = date.getHours();
  if (hour >= 3 && hour < 6) return 'late_night_3am';
  if (hour >= 6 && hour < 9) return 'early_morning';
  if (hour >= 9 && hour < 12) return 'morning_commute';
  if (hour >= 12 && hour < 17) return 'work_hours';
  if (hour >= 17 && hour < 21) return 'evening_commute';
  return 'night_wind_down';
}

export function detectCurrentDayType(date = new Date()): DayType {
  const day = date.getDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}
