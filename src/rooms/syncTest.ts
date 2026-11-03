/* A convergence test for two independent audio pipelines.
 *
 * Earlier verification measured each device's drift against the server's
 * expectation, which is always near zero and therefore proves nothing. The
 * only number that matters is the distance *between* two people, so this test
 * builds two genuinely separate AudioContexts — two render clocks, two output
 * heads — and measures how far apart they actually are.
 *
 * It runs in a browser because there is nowhere else to fake a real output
 * pipeline: getOutputTimestamp(), decodeAudioData and autoplay policy are all
 * part of what is being measured.
 *
 * Two scenarios:
 *   1. Scheduled start, both devices ready in time. Proves that agreeing on a
 *      start moment removes startup divergence entirely.
 *   2. One device starts 1200ms late, as a slow phone would. Proves the
 *      convergence loop actually walks it back — the old 120ms deadband let
 *      two devices sit 240ms apart and call that "in sync".
 *
 * Plus a check that the reported position tracks a rate change. Deriving the
 * playhead from elapsed wall-clock is the obvious way to write it and it is
 * silently wrong under correction: the audio speeds up but the reported
 * position does not, so the loop sees the same drift forever and leaves the
 * track running fast. That bug was found by watching the live UI sit at
 * exactly -100ms and "gently correcting" indefinitely.
 */

import { WebAudioTarget } from './audioEngine';
import { SyncEngine, type SyncTarget } from './syncEngine';
import type { PlaybackState } from './protocol';
import type { ResolvedTrack } from './audioTarget';

const SAMPLE_MS = 100;
/** Steady-state bound we are willing to accept between two listeners, in ms. */
const SPREAD_BUDGET_MS = 60;
const TIGHT_BUDGET_MS = 30;
/** How far ahead a start is announced, giving both devices time to decode. */
const LEAD_MS = 2500;

const TRACK: ResolvedTrack = {
  key: 'tone',
  videoId: null,
  url: toneDataUri(40),
  title: 'Sync test tone',
  artist: 'local',
  durationMs: 40_000,
};

/** A 440Hz tone as a WAV data URI, so the test needs no network. */
function toneDataUri(seconds: number): string {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // A louder beat every second, so the test is still useful by ear and any
    // discontinuity is obvious if you listen to it.
    const beat = i % rate === 0;
    v.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * (beat ? 12000 : 4000)), true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192) as unknown as number[]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

/**
 * Wraps a target so its scheduled start lands `delayMs` later than agreed —
 * what a device that was still downloading when the room said "go" would do.
 */
function startLate(target: SyncTarget, delayMs: number): SyncTarget {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'schedulePlay') {
        const fn = (t as SyncTarget).schedulePlay;
        if (!fn) return undefined;
        return (at: number, from: number, now: number) => fn.call(t, at + delayMs, from, now);
      }
      const value = Reflect.get(t, prop, t) as unknown;
      return typeof value === 'function' ? value.bind(t) : value;
    },
  }) as SyncTarget;
}

interface Scenario {
  name: string;
  lateByMs: number;
  runMs: number;
  /** Ignore samples before this, so decode and catch-up is not counted. */
  settleMs: number;
  budgetMs: number;
}

interface ScenarioResult {
  name: string;
  samples: number;
  maxSpreadMs: number;
  finalSpreadMs: number;
  budgetMs: number;
  pass: boolean;
  /** Worst gap seen anywhere, including while the late device was catching up. */
  peakSpreadMs: number;
  /** The late device has to have genuinely been late, or nothing is proven. */
  didDiverge: boolean;
  outputLatencyMs: { a: number | null; b: number | null };
  timeline: string[];
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const targetA = new WebAudioTarget({ resolve: (key) => (key === TRACK.key ? TRACK : null) });
  const targetB = new WebAudioTarget({ resolve: (key) => (key === TRACK.key ? TRACK : null) });

  // Both contexts must be running before anything can be scheduled against
  // them; a suspended context's clock does not advance.
  await targetA.unlock();
  await targetB.unlock();

  await targetA.load(TRACK.key);
  await targetB.load(TRACK.key);

  const engineA = new SyncEngine({ correctionIntervalMs: SAMPLE_MS });
  const engineB = new SyncEngine({ correctionIntervalMs: SAMPLE_MS });
  engineA.attach(targetA);
  engineB.attach(s.lateByMs ? startLate(targetB, s.lateByMs) : targetB);
  engineA.start(() => {});
  engineB.start(() => {});

  // The referee agrees one start moment and tells both clients the same thing.
  const startAt = Date.now() + LEAD_MS;
  const playback: PlaybackState = {
    trackKey: TRACK.key,
    videoId: null,
    positionMs: 0,
    playing: true,
    updatedAt: startAt,
    startAt,
    rev: 0,
  };

  await engineA.onPlayback(playback);
  await engineB.onPlayback(playback);

  const timeline: string[] = [];
  const deadline = startAt + s.runMs;
  const settleAt = startAt + s.settleMs;
  let maxSpread = 0;
  let peakSpread = 0;
  let finalSpread = 0;
  let count = 0;

  while (Date.now() < deadline) {
    await sleep(SAMPLE_MS);
    // Reading both engines in the same tick is the same as reading them at the
    // same instant: each derives its position from its own render clock.
    const gap = Math.abs(engineA.positionMs - engineB.positionMs);
    if (gap > peakSpread) peakSpread = gap;

    // Keep the whole story, including the divergence and the catch-up.
    if (count % 10 === 0) {
      timeline.push(`${((Date.now() - startAt) / 1000).toFixed(1)}s ${gap.toFixed(0)}ms`);
    }

    if (Date.now() < settleAt) continue;
    finalSpread = gap;
    if (gap > maxSpread) maxSpread = gap;
    count++;
  }

  const latencies = {
    a: targetA.latencyMeasured ? +targetA.outputLatencyMs.toFixed(1) : null,
    b: targetB.latencyMeasured ? +targetB.outputLatencyMs.toFixed(1) : null,
  };

  engineA.stop(); engineB.stop();
  targetA.dispose(); targetB.dispose();

  // If the sabotage did not take effect, a passing spread means nothing — the
  // test never created the problem it claims to have solved.
  const didDiverge = peakSpread > s.lateByMs * 0.8;

  return {
    name: s.name,
    samples: count,
    maxSpreadMs: +maxSpread.toFixed(1),
    finalSpreadMs: +finalSpread.toFixed(1),
    budgetMs: s.budgetMs,
    pass: count > 0 && maxSpread <= s.budgetMs && (!s.lateByMs || didDiverge),
    peakSpreadMs: +peakSpread.toFixed(1),
    didDiverge,
    outputLatencyMs: latencies,
    timeline,
  };
}

/**
 * Position must reflect the rate the audio is actually playing at.
 *
 * Returns the observed ratio: 1.0 is correct, and anything near 1.02 while
 * playing at 1.02 means the reported position ignored the rate change.
 */
async function rateTrackingCheck(): Promise<{ pass: boolean; observedRatio: number; rate: number }> {
  const target = new WebAudioTarget({ resolve: (key) => (key === TRACK.key ? TRACK : null) });
  await target.unlock();
  await target.load(TRACK.key);
  await target.play();
  await sleep(400);

  const rate = 1.02;
  const before = target.getPositionMs();
  const wallBefore = performance.now();
  target.setRate(rate);
  await sleep(2000);
  const advanced = target.getPositionMs() - before;
  const wallElapsed = performance.now() - wallBefore;
  const observedRatio = advanced / wallElapsed;

  target.pause();
  target.dispose();
  return { pass: Math.abs(observedRatio - rate) < 0.004, observedRatio: +observedRatio.toFixed(5), rate };
}

/**
 * Pausing must actually stop the audio, and must keep stopping it.
 *
 * Regression: converge() used to seek before it paused. Under Web Audio a seek
 * is a stop-and-restart, so the pause left a running source; the next tick saw
 * the playhead advancing past a frozen expectation, sought again, and the track
 * stuttered in one spot forever. Only a real source run for a few seconds after
 * the pause catches that, so this plays through the engine's own tick loop
 * rather than calling pause() once and asserting on it.
 */
async function pauseStaysPausedCheck(): Promise<{
  pass: boolean; movedAfterPauseMs: number; position: number; restartsAfterPause: number;
}> {
  const target = new WebAudioTarget({ resolve: (key) => (key === TRACK.key ? TRACK : null) });
  await target.unlock();
  await target.load(TRACK.key);

  const engine = new SyncEngine({ correctionIntervalMs: 100 });
  engine.attach(target);
  engine.start(() => {});

  const startAt = Date.now() + 1200;
  const playing: PlaybackState = {
    trackKey: TRACK.key, videoId: null, positionMs: 0,
    playing: true, updatedAt: startAt, startAt, rev: 0,
  };
  await engine.onPlayback(playing);
  await sleep(2500);
  const whilePlaying = engine.positionMs;
  if (!target.isPlaying()) {
    target.dispose();
    return { pass: false, movedAfterPauseMs: -1, position: whilePlaying, restartsAfterPause: -1 };
  }

  // Pause, and report the playhead the way the UI does.
  const paused: PlaybackState = {
    ...playing, playing: false, startAt: null,
    positionMs: whilePlaying, updatedAt: Date.now(),
  };
  await engine.onPlayback(paused);
  const atPause = engine.positionMs;
  // A pause legitimately tears down one source. Anything started after this
  // point is the churn, so count from here rather than from construction.
  const startsAtPause = target.starts;

  // Let the correction loop run. Any movement means something restarted it.
  await sleep(2500);
  const later = engine.positionMs;
  const restartsAfterPause = target.starts - startsAtPause;

  engine.stop();
  target.dispose();
  // Any sizeable movement means something restarted it. A small negative
  // reading is just the sub-millisecond settle of the final integrate() call.
  const moved = later - atPause;
  return {
    pass: Math.abs(moved) < 5 && restartsAfterPause === 0,
    movedAfterPauseMs: +moved.toFixed(1),
    position: +atPause.toFixed(1),
    restartsAfterPause,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'scheduled start, both devices ready in time',
    lateByMs: 0,
    runMs: 6000,
    settleMs: 800,
    budgetMs: TIGHT_BUDGET_MS,
  },
  {
    name: 'one device starts 1200ms late (slow phone)',
    lateByMs: 1200,
    runMs: 14000,
    // The late device has to re-seat itself first. That is the catch-up doing
    // its job, not the steady state we are measuring.
    settleMs: 5000,
    budgetMs: SPREAD_BUDGET_MS,
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const out = document.getElementById('out') as HTMLPreElement;
  const write = (s: string) => { out.textContent += s + '\n'; };
  out.textContent = '';

  const results: ScenarioResult[] = [];

  write('▸ pause stays paused');
  const pauseCheck = await pauseStaysPausedCheck();
  write(`   playhead moved ${pauseCheck.movedAfterPauseMs} ms in the 2.5s after pausing (from ${pauseCheck.position} ms)`);
  write(`   sources restarted after pausing  ${pauseCheck.restartsAfterPause}`);
  write(`   ${pauseCheck.pass ? 'PASS' : 'FAIL'}\n`);

  write('▸ reported position tracks the playback rate');
  const rateCheck = await rateTrackingCheck();
  write(`   asked for ${rateCheck.rate}×, measured ${rateCheck.observedRatio}×`);
  write(`   ${rateCheck.pass ? 'PASS' : 'FAIL'}\n`);

  for (const s of SCENARIOS) {
    write(`▸ ${s.name}`);
    const r = await runScenario(s);
    results.push(r);
    write(`   output latency measured  A ${r.outputLatencyMs.a ?? '?'} ms · B ${r.outputLatencyMs.b ?? '?'} ms`);
    write(`   peak gap, whole run      ${r.peakSpreadMs} ms`);
    write(`   steady-state gap         ${r.finalSpreadMs} ms  (max ${r.maxSpreadMs} ms, budget ${r.budgetMs} ms)`);
    write(`   timeline                 ${r.timeline.join('  ')}`);
    write(`   ${r.pass ? 'PASS' : 'FAIL'}\n`);
  }

  const pass = results.every((r) => r.pass) && rateCheck.pass && pauseCheck.pass;
  write(pass ? 'ALL PASS' : 'FAILED');
  (window as unknown as { __result: unknown }).__result = { pass, pauseCheck, rateCheck, results };
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('run') as HTMLButtonElement | null;
  btn?.addEventListener('click', () => {
    btn.disabled = true;
    void main();
  });
});