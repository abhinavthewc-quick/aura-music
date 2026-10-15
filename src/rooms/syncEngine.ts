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

/** The parts of a media element this engine needs. */
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
}

export interface SyncEngineOptions {
  /** How often to re-check our position against the room's expectation. */
  correctionIntervalMs?: number;
  /** How often to ping the server for clock sync. */
  clockIntervalMs?: number;
  /** Called when we give up trying (repeated load failures). */
  onError?: (message: string) => void;
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

  constructor(options: SyncEngineOptions = {}) {
    this.opts = {
      correctionIntervalMs: options.correctionIntervalMs ?? 3000,
      clockIntervalMs: options.clockIntervalMs ?? 10000,
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

  attach(target: SyncTarget): void {
    this.target = target;
  }

  detach(): void {
    this.stop();
    this.target = null;
    this.playback = null;
  }

  /** Feed a clock-sync reply. */
  onPong(sentAt: number, serverTime: number): void {
    this.clock.addSample(sentAt, serverTime);
  }

  start(sendPing: () => void): void {
    if (this.started) return;
    this.started = true;
    sendPing();
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
    await this.converge(true);
  }

  /**
   * Periodic check. If the room moved on without telling us (we were
   * backgrounded, the socket blipped) this pulls us back.
   */
  private async tick(): Promise<void> {
    if (!this.playback || !this.target) return;
    await this.converge(false);
  }

  /**
   * Bring the local element in line with the room.
   * @param force true when the change is authoritative and must be applied
   *             even if the difference is small (someone pressed pause).
   */
  private async converge(force: boolean): Promise<void> {
    const target = this.target;
    const playback = this.playback;
    if (!target || !playback) return;

    // No track requested yet — nothing to do.
    if (!playback.trackKey) {
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

    // Where should the playhead be, right now, according to the room?
    const elapsed = playback.playing ? Math.max(0, this.clock.serverNow() - playback.updatedAt) : 0;
    const expected = playback.positionMs + elapsed;
    const actual = target.getPositionMs();
    const drift = actual - expected;
    this.lastDriftMs = drift;

    const needsSeek =
      force ||
      applyingTrack ||
      !Number.isFinite(expected) ||
      Math.abs(drift) > DRIFT_HARD_MS ||
      // Jumping tracks but landing nowhere near the start is always wrong.
      (applyingTrack && Math.abs(drift) > DRIFT_SOFT_MS);

    if (needsSeek) {
      target.seek(Math.max(0, Math.min(expected, safeDuration(target))));
      if (drift > DRIFT_HARD_MS || applyingTrack) this.corrections++;
    }

    // Playing/paused convergence. Note we deliberately let small drift stand
    // rather than nudging constantly — audible micro-seeks are worse than
    // 100ms of drift.
    if (playback.playing) {
      if (!target.isPlaying()) {
        try { await target.play(); } catch { /* autoplay blocked; UI will prompt */ }
      }
    } else if (target.isPlaying()) {
      target.pause();
    }
  }
}

function safeDuration(target: SyncTarget): number {
  const d = Number((target as unknown as { durationMs?: number }).durationMs);
  return Number.isFinite(d) && d > 0 ? d : Number.MAX_SAFE_INTEGER;
}