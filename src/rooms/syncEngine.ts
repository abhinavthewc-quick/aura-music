/* Keeps this browser's audio in step with the room.
 *
 * The engine never decides *what* should be playing — the server referee does.
 * Its only job is to make the local media element agree with that decision,
 * and to do it without the listener noticing.
 *
 * The media element is reached through the `SyncTarget` interface rather than
 * touching `state.audio` directly, so this file stays testable and can be
 * driven by a synthetic target in development.
 */

import { ClockSync } from './clock';
import { DRIFT_HARD_MS, DRIFT_SOFT_MS, type PlaybackState } from './protocol';

/** The parts of an audio engine this file needs. */
export interface SyncTarget {
  getTrackKey(): string | null;
  getPositionMs(): number;
  isPlaying(): boolean;
  isBuffering(): boolean;
  /** Load a track by key; resolves when it is ready to be seeked. */
  load(trackKey: string): Promise<void>;
  seek(ms: number): void;
  play(): Promise<void>;
  pause(): void;
  /** Total track length in ms, when known. */
  getDurationMs?(): number;
  /**
   * Begin playback at an absolute moment on the room server's clock. Optional:
   * a target that cannot schedule simply starts as soon as it is told to.
   */
  schedulePlay?(atServerMs: number, fromMs: number, serverNowMs: number): boolean;
  /** True while a scheduled start is still in the future. */
  hasPendingStart?(): boolean;
  /** The server time of the start this target has queued, or null if none.
   * Lets the engine avoid cancelling and re-scheduling a correct start on
   * every correction tick — doing that is exactly what desyncs devices. */
  getScheduledStart?(): { atServerMs: number; fromMs: number } | null;
  /** Resume a context suspended by autoplay policy. */
  unlock?(): Promise<boolean>;
  /**
   * Optional playback-rate control. When present, small drift is corrected by
   * nudging the rate instead of seeking — a seek is audible, a 1-2% rate change
   * is not.
   */
  setRate?(rate: number): void;
}

/** Rate used to drift back into alignment. ~2% is inaudible for short bursts. */
const NUDGE_RATE = 0.02;
/** Beyond this a nudge cannot catch up in reasonable time — seek instead. */
const NUDGE_MAX_MS = DRIFT_HARD_MS;
/** How long past the agreed moment a device may still be holding its own
 * scheduled start before the engine gives up on it. */
const PENDING_START_GRACE_MS = 6000;

export interface SyncEngineOptions {
  /** How often to re-check our position against the room's expectation. */
  correctionIntervalMs?: number;
  /** How often to ping the server for clock sync. */
  clockIntervalMs?: number;
  /** Called when we give up trying (repeated load failures). */
  onError?: (message: string) => void;
  /** Drift below which no correction is applied (default 20 ms). */
  softMs?: number;
  /** Drift beyond which a hard seek is used instead of a nudge (default 150 ms). */
  hardMs?: number;
}

export class SyncEngine {
  private clock = new ClockSync();
  private target: SyncTarget | null = null;
  private playback: PlaybackState | null = null;
  private opts: Required<Omit<SyncEngineOptions, 'onError'>> & Pick<SyncEngineOptions, 'onError'>;

  private correctionTimer: number | null = null;
  private clockTimer: number | null = null;
  private started = false;

  /** Diagnostics surfaced in the room UI. */
  lastDriftMs = 0;
  corrections = 0;
  private failures = 0;
  /** True while a gentle rate correction is in progress. */
  private nudging = false;
  /** Server time of a pending start, or null. */
  private pendingStartServerMs: number | null = null;

  private setRate(target: SyncTarget, delta: number): void {
    if (!target.setRate) return;
    try { target.setRate(1 + delta); } catch { /* element refused */ }
  }

  constructor(options: SyncEngineOptions = {}) {
    this.opts = {
      correctionIntervalMs: options.correctionIntervalMs ?? 500,
      clockIntervalMs: options.clockIntervalMs ?? 3000,
      softMs: options.softMs ?? DRIFT_SOFT_MS,
      hardMs: options.hardMs ?? DRIFT_HARD_MS,
      onError: options.onError,
    };
  }

  get serverNow(): number {
    return this.clock.serverNow();
  }

  get clockReady(): boolean {
    return this.clock.ready;
  }

  /** How far ahead of this machine's clock the room server runs. */
  get clockOffsetMs(): number {
    return this.clock.offsetMs;
  }

  /** Round trip of the most trustworthy recent clock sample. */
  get clockRtt(): number {
    return this.clock.bestRtt;
  }

  /** True when we are close enough to the room that the UI should read "live". */
  get inSync(): boolean {
    return Math.abs(this.lastDriftMs) < DRIFT_HARD_MS;
  }

  /** True while a gentle rate correction is running (vs a hard seek). */
  get isNudging(): boolean {
    return this.nudging;
  }

  /**
   * Where this device's audio actually is right now.
   *
   * The server cannot know this — it only ever holds the position from the
   * last seek. Whoever presses pause must therefore send their real position,
   * or the server would tell every other device to jump back to the last seek
   * point and the progress bar would snap to zero.
   */
  get positionMs(): number {
    return this.target ? this.target.getPositionMs() : 0;
  }

  /** Length of the current track, when the target knows it. */
  get durationMs(): number {
    return this.target?.getDurationMs?.() ?? 0;
  }

  /** True while every device is waiting for the same agreed start moment. */
  get hasPendingStart(): boolean {
    return this.pendingStartServerMs !== null;
  }

  /** Milliseconds until the agreed start, or null when there is none. */
  get startInMs(): number | null {
    if (this.pendingStartServerMs === null) return null;
    return Math.max(0, this.pendingStartServerMs - this.clock.serverNow());
  }

  /**
   * Give the audio engine another chance after an autoplay block. Called from
   * the UI's first real interaction.
   */
  resumeIfBlocked(): void {
    void this.target?.unlock?.().then((ok) => {
      if (ok) void this.converge();
    });
  }

  attach(target: SyncTarget): void {
    this.target = target;
  }

  detach(): void {
    this.stop();
    this.target = null;
    this.playback = null;
    this.pendingStartServerMs = null;
  }

  /** Feed a clock-sync reply. */
  onPong(sentAt: number, serverTime: number): void {
    this.clock.addSample(sentAt, serverTime);
  }

  start(sendPing: () => void): void {
    if (this.started) return;
    this.started = true;
    sendPing();
    // A burst up front: the offset estimate is weakest exactly when someone
    // joins, which is also when they are most likely to start playing. The
    // lowest-RTT sample wins, so a few quick tries land a good one early.
    window.setTimeout(sendPing, 120);
    window.setTimeout(sendPing, 320);
    window.setTimeout(sendPing, 700);
    this.clockTimer = window.setInterval(sendPing, this.opts.clockIntervalMs);
    this.correctionTimer = window.setInterval(() => void this.tick(), this.opts.correctionIntervalMs);
  }

  stop(): void {
    this.started = false;
    if (this.clockTimer !== null) { window.clearInterval(this.clockTimer); this.clockTimer = null; }
    if (this.correctionTimer !== null) { window.clearInterval(this.correctionTimer); this.correctionTimer = null; }
  }

  /** Authoritative state arrived from the referee. Converge on it. */
  async onPlayback(playback: PlaybackState): Promise<void> {
    this.playback = playback;
    await this.converge();
  }

  /**
   * Periodic check. If the room moved on without telling us (we were
   * backgrounded, the socket blipped) this pulls us back.
   */
  private async tick(): Promise<void> {
    if (!this.playback || !this.target) return;
    await this.converge();
  }

  /**
   * Bring the local audio in line with the room.
   */
  private async converge(): Promise<void> {
    const target = this.target;
    const playback = this.playback;
    if (!target || !playback) return;

    // No track requested yet — nothing to do.
    if (!playback.trackKey) {
      this.pendingStartServerMs = null;
      target.pause();
      return;
    }

    const applyingTrack = target.getTrackKey() !== playback.trackKey;

    if (applyingTrack) {
      this.failures = 0;
      try {
        await target.load(playback.trackKey);
      } catch (err) {
        this.failures++;
        if (this.failures >= 3) {
          this.opts.onError?.(`could not load that track (${(err as Error).message || 'unknown error'})`);
        }
        return;
      }
    }

    const serverNow = this.clock.serverNow();

    // Waiting for the agreed start moment. Every device in the room was told
    // the same startAt, so the only thing that matters is whether that moment
    // has arrived yet. While waiting, hold the playhead at the agreed
    // position and queue one start — and crucially, do NOT cancel and
    // re-schedule a start that is already correct: the old loop paused and
    // rescheduled on every 500 ms tick, which is precisely what desynced
    // devices on almost every press of play.
    //
    // The second half of the condition matters just as much. A source queued
    // for the room's moment stays "pending" for the frames between startAt and
    // the instant it actually fires, and for those frames it reports itself as
    // not playing. Leaving that window early makes the play/pause block at the
    // bottom call play(), which throws the agreed start away and restarts the
    // source a scheduling headroom later — so every device begins at its own
    // slightly different instant. That is the very spread an agreed moment
    // exists to kill, and it showed up as 20-60 ms of start-up divergence.
    const startAt = playback.playing ? playback.startAt : null;
    const beforeStart = startAt != null && serverNow < startAt;
    const holdingOwnStart =
      !beforeStart &&
      startAt != null &&
      target.hasPendingStart?.() === true &&
      serverNow < startAt + PENDING_START_GRACE_MS;

    if (startAt != null && (beforeStart || holdingOwnStart)) {
      this.pendingStartServerMs = startAt;
      const scheduled = target.getScheduledStart?.();
      const alreadyScheduled =
        scheduled != null && Math.abs(scheduled.atServerMs - startAt) < 500;

      if (!alreadyScheduled && beforeStart) {
        // Cancel anything queued at the wrong time, then schedule the room's
        // moment. Pausing also cancels a start that has not fired yet.
        if (target.isPlaying() || target.hasPendingStart?.()) target.pause();
        if (applyingTrack || Math.abs(target.getPositionMs() - playback.positionMs) > 1) {
          target.seek(playback.positionMs);
        }
        this.setRate(target, 0);
        this.nudging = false;
        this.lastDriftMs = 0;
        await target.unlock?.();
        target.schedulePlay?.(startAt, playback.positionMs, serverNow);
      } else if (holdingOwnStart) {
        // The moment is here and this device's own start is about to fire.
        // Re-arming it would move the downbeat; hold still and let it land.
        this.setRate(target, 0);
        this.nudging = false;
        this.lastDriftMs = 0;
      }
      return;
    }

    // The agreed moment has passed (or is not set): converge normally. A
    // device that missed the start — still decoding when it fired — lands here
    // and joins mid-track on the next tick instead of waiting forever.
    this.pendingStartServerMs = null;

    // Where should the playhead be, right now, according to the room?
    const elapsed = playback.playing ? Math.max(0, serverNow - playback.updatedAt) : 0;
    const expected = playback.positionMs + elapsed;
    const actual = target.getPositionMs();
    const drift = actual - expected;
    this.lastDriftMs = drift;

    const magnitude = Math.abs(drift);
    const mustSeek =
      applyingTrack ||
      !Number.isFinite(expected) ||
      magnitude > this.opts.hardMs;

    // Paused: stop, and do not touch the playhead.
    //
    // This has to come first. A seek while the room is paused is a
    // stop-and-restart under Web Audio, which leaves the source playing; the
    // play/pause block below then sees a running source and leaves it alone.
    // The next tick finds the playhead advancing past a frozen expectation,
    // seeks again, and the track stutters in place indefinitely.
    if (!playback.playing) {
      this.pendingStartServerMs = null;
      if (target.isPlaying() || target.hasPendingStart?.()) target.pause();
      this.setRate(target, 0);
      this.nudging = false;
      // The pause message carries the authoritative position, and the target
      // already holds it from pausing, so there is nothing left to correct.
      this.lastDriftMs = 0;
      return;
    }

    if (mustSeek) {
      // Big or deliberate jump: land exactly where the room is.
      target.seek(Math.max(0, Math.min(expected, safeDuration(target))));
      this.setRate(target, 0);
      this.nudging = false;
      if (magnitude > this.opts.hardMs || applyingTrack) this.corrections++;
    } else if (magnitude > this.opts.softMs && target.setRate) {
      // Small drift: ease back with a slight rate change rather than a seek.
      // A seek here is the single most audible thing a sync system can do —
      // it is what makes these tools feel "janky" to the people using them.
      // The rate scales with the error so a 100ms gap closes faster than a
      // 20ms one, while staying inaudible at both ends.
      const strength = Math.min(NUDGE_RATE, Math.max(0.005, magnitude / 2000));
      target.setRate(drift > 0 ? 1 - strength : 1 + strength);
      this.nudging = true;
    } else if (this.nudging) {
      this.setRate(target, 0);
      this.nudging = false;
    }

    // Only reached while playing. Paused returned above.
    if (!target.isPlaying()) {
      try { await target.play(); } catch { /* autoplay blocked; UI will prompt */ }
    }
  }
}

function safeDuration(target: SyncTarget): number {
  const d = Number(target.getDurationMs?.());
  return Number.isFinite(d) && d > 0 ? d : Number.MAX_SAFE_INTEGER;
}