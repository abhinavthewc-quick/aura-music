/* Cloudflare Pages Function: POST /api/v1/home/mind-read
 *
 * Edge-native Telepathy Engine running on Cloudflare V8 isolates.
 * Pure mathematical scoring (sub-5ms execution, zero AI).
 */

interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  PREBUFFER_BASE_URL?: string;
  TELEMETRY_KV?: KVNamespaceLike;
}

interface TelemetryEventPayload {
  userId: string;
  trackId: string;
  eventType: string;
  completionRatio?: number;
  timeBlock: string;
  dayType: string;
  audioRoute: string;
  weather?: string;
  createdAt?: string;
}

interface EnrichedTrackPayload {
  trackId: string;
  songName: string;
  artist: string;
  bpm?: number;
  energy?: number;
  acousticWarmth?: number;
  onsetDensity?: number;
  valence?: number;
  arousal?: number;
  nostalgiaIndex?: number;
  catharsisScore?: number;
  egoBoost?: number;
  focusCompatibility?: number;
  primaryState: string;
  idealTimeBlocks: string[];
  idealWeather: string[];
  psychoVector: number[];
}

interface MindReadRequestPayload {
  userId: string;
  currentTimeBlock: string;
  dayType: string;
  audioRoute: string;
  currentWeather?: string;
  candidates?: EnrichedTrackPayload[];
  userEvents?: TelemetryEventPayload[];
}

const EVENT_WEIGHTS: Record<string, number> = {
  SEARCH_AND_PLAY: 4.0,
  LOOP_ENABLED: 3.5,
  VOLUME_SPIKE: 3.0,
  SCRUB_BACK: 2.5,
  HERO_CARD_PLAY: 2.0,
  FULL_LISTEN: 1.0,
  EARLY_SKIP: -4.0,
  INTERRUPTED_MIDWAY: 0.0,
};

const DECAY_LAMBDA = 0.025; // per hour

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function computeCosineSimilarity(a: number[], b: number[]): number {
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

function generateBadge(zI: number, oI: number, audioRoute: string, timeBlock: string): string {
  if (zI > 0) return 'Finish where you left off';
  if (oI > 8.0) return 'Still in your head?';
  if (audioRoute === 'car_bluetooth') return 'For the drive';
  if (timeBlock === 'late_night_3am') return 'Late night wavelength';
  return 'Right on cue';
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store, no-cache',
    },
  });
}

export const onRequestOptions = async (): Promise<Response> => {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
};

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  const startTime = Date.now();
  let body: MindReadRequestPayload;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON payload' }, 400);
  }

  const {
    userId,
    currentTimeBlock = 'night_wind_down',
    dayType = 'weekday',
    audioRoute = 'headphones',
    currentWeather = 'clear',
    candidates = [],
    userEvents = [],
  } = body;

  if (!userId) {
    return jsonResponse({ error: 'userId is required' }, 400);
  }

  // Fallback candidate seed if none provided in request
  const trackCandidates: EnrichedTrackPayload[] = candidates.length > 0 ? candidates : [
    {
      trackId: 'trk_after_dark',
      songName: 'After Dark',
      artist: 'Mr.Kitty',
      primaryState: 'melancholic_release',
      idealTimeBlocks: ['night_wind_down', 'late_night_3am'],
      idealWeather: ['clear_night', 'rain'],
      psychoVector: [0.3, 0.7, 0.3, 0.4, 0.8, 0.7, 0.2, 0.8],
    },
    {
      trackId: 'trk_space_song',
      songName: 'Space Song',
      artist: 'Beach House',
      primaryState: 'melancholic_release',
      idealTimeBlocks: ['night_wind_down', 'late_night_3am'],
      idealWeather: ['clear_night'],
      psychoVector: [0.32, 0.68, 0.31, 0.42, 0.82, 0.71, 0.21, 0.79],
    },
    {
      trackId: 'trk_cant_hold_us',
      songName: "Can't Hold Us",
      artist: 'Macklemore',
      primaryState: 'dopamine_hype',
      idealTimeBlocks: ['morning_commute', 'work_hours'],
      idealWeather: ['sunny'],
      psychoVector: [0.95, 0.1, 0.9, 0.95, 0.1, 0.6, 0.9, 0.1],
    },
  ];

  const tNowMs = Date.now();
  const prebufferBase = (env.PREBUFFER_BASE_URL || 'https://cdn.app.com/chunks').replace(/\/$/, '');

  // 1. Group events by trackId
  const eventsMap = new Map<string, TelemetryEventPayload[]>();
  for (const ev of userEvents) {
    const list = eventsMap.get(ev.trackId) || [];
    list.push(ev);
    eventsMap.set(ev.trackId, list);
  }

  // 2. Score candidate tracks
  const scored = trackCandidates.map((trk) => {
    const evs = eventsMap.get(trk.trackId) || [];

    // O_i: Obsession Momentum (14-day exponential decay)
    const cutoff14d = tNowMs - 14 * 24 * 3600 * 1000;
    let oI = 0.0;
    for (const ev of evs) {
      const evTime = ev.createdAt ? new Date(ev.createdAt).getTime() : tNowMs;
      if (evTime >= cutoff14d) {
        const weight = EVENT_WEIGHTS[ev.eventType] || 0.0;
        const dtHours = Math.max(0, tNowMs - evTime) / (3600 * 1000);
        oI += weight * Math.exp(-DECAY_LAMBDA * dtHours);
      }
    }

    // C_i: Context Match
    const posMatches: number[] = [];
    for (const ev of evs) {
      const weight = EVENT_WEIGHTS[ev.eventType] || 0.0;
      if (weight <= 0) continue;
      let m = 0.0;
      if (ev.timeBlock === currentTimeBlock) m += 0.40;
      if (ev.audioRoute === audioRoute) m += 0.30;
      if (ev.dayType === dayType) m += 0.15;
      if ((ev.weather || 'clear') === currentWeather) m += 0.15;
      posMatches.push(m);
    }
    posMatches.sort((a, b) => b - a);
    const top5 = posMatches.slice(0, 5);
    const avgM = top5.length ? top5.reduce((s, v) => s + v, 0) / top5.length : 0.0;
    const bonus = trk.idealTimeBlocks.includes(currentTimeBlock) && trk.idealWeather.includes(currentWeather) ? 0.25 : 0.0;
    const cI = avgM + bonus;

    // Z_i: Zeigarnik Boost
    const cutoff8h = tNowMs - 8 * 3600 * 1000;
    const recent = userEvents.filter((e) => (e.createdAt ? new Date(e.createdAt).getTime() : 0) >= cutoff8h);
    recent.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const trkRecent = recent.filter((e) => e.trackId === trk.trackId);
    let zI = 0.0;
    const intIdx = trkRecent.findIndex((e) => e.eventType === 'INTERRUPTED_MIDWAY');
    if (intIdx !== -1) {
      const skipped = trkRecent.slice(0, intIdx).some((e) => e.eventType === 'EARLY_SKIP');
      if (!skipped) zI = 3.5;
    }

    // F_i: Fatigue Damper
    const cutoff90m = tNowMs - 90 * 60 * 1000;
    const cutoff5d = tNowMs - 5 * 24 * 3600 * 1000;
    let completed90m = false;
    let loopEnabled = false;
    let fullPlays5d = 0;
    for (const ev of evs) {
      const evTime = ev.createdAt ? new Date(ev.createdAt).getTime() : 0;
      if (evTime >= cutoff90m) {
        if (ev.eventType === 'LOOP_ENABLED') loopEnabled = true;
        if (ev.eventType === 'FULL_LISTEN' || (ev.completionRatio || 0) >= 0.80) completed90m = true;
      }
      if (evTime >= cutoff5d) {
        if (ev.eventType === 'FULL_LISTEN' || (ev.completionRatio || 0) >= 0.80) fullPlays5d++;
      }
    }
    let fI = 1.0;
    if (completed90m && !loopEnabled) fI = 0.08;
    else if (fullPlays5d > 18 && evs[0]?.eventType === 'EARLY_SKIP') fI = 0.05;

    // S_i: Final Telepathy Score
    const sI = ((0.45 * oI) + (0.35 * cI * 10.0) + (0.20 * zI)) * fI;
    return { track: trk, sI, oI, cI, zI, fI };
  });

  scored.sort((a, b) => b.sI - a.sI);
  const hero = scored[0];

  // 3. Fallback selection
  const cutoff72h = tNowMs - 72 * 3600 * 1000;
  const played72h = new Set(
    userEvents
      .filter((e) => (e.createdAt ? new Date(e.createdAt).getTime() : 0) >= cutoff72h && e.eventType !== 'EARLY_SKIP')
      .map((e) => e.trackId)
  );

  let slot2: EnrichedTrackPayload | null = null;
  let bestSim = -1.0;
  for (const trk of trackCandidates) {
    if (trk.trackId === hero.track.trackId || played72h.has(trk.trackId)) continue;
    if (!trk.idealTimeBlocks.includes(currentTimeBlock)) continue;
    const sim = computeCosineSimilarity(hero.track.psychoVector, trk.psychoVector);
    if (sim > bestSim) {
      bestSim = sim;
      slot2 = trk;
    }
  }
  if (!slot2) {
    slot2 = trackCandidates.find((t) => t.trackId !== hero.track.trackId) || null;
  }

  let slot3: EnrichedTrackPayload | null = null;
  for (const s of scored) {
    if (s.track.trackId === hero.track.trackId || (slot2 && s.track.trackId === slot2.trackId)) continue;
    const sim = computeCosineSimilarity(hero.track.psychoVector, s.track.psychoVector);
    if (s.track.primaryState !== hero.track.primaryState && sim < 0.50) {
      slot3 = s.track;
      break;
    }
  }
  if (!slot3) {
    slot3 = trackCandidates.find(
      (t) => t.trackId !== hero.track.trackId && (!slot2 || t.trackId !== slot2.trackId)
    ) || null;
  }

  const badge = generateBadge(hero.zI, hero.oI, audioRoute, currentTimeBlock);
  const pivots = [];
  if (slot2) {
    pivots.push({ slot: 2, track_id: slot2.trackId, ui_badge: 'Same vibe, fresh track' });
  }
  if (slot3) {
    pivots.push({ slot: 3, track_id: slot3.trackId, ui_badge: 'Switch the energy' });
  }

  return jsonResponse({
    hero_slot_1: {
      track_id: hero.track.trackId,
      song_name: hero.track.songName,
      artist: hero.track.artist,
      telepathy_score: Number(hero.sI.toFixed(2)),
      prebuffer_audio_bytes_url: `${prebufferBase}/${hero.track.trackId}_first_10s.aac`,
      psychological_ui_badge: badge,
    },
    orthogonal_pivots: pivots,
    _edge_latency_ms: Date.now() - startTime,
  });
};
