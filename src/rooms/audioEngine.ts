/* Web Audio playback for rooms.
 *
 * Replaces <audio> for room playback, for one reason: an HTMLAudioElement only
 * tells us where it is in ~33ms steps, and it hides the one number that decides
 * when sound actually leaves the speaker. With Web Audio we schedule against
 * AudioContext.currentTime (sub-millisecond) and measure the distance between
 * the render clock and the output head, so every listener converges on the
 * moment the sound is *audible* rather than the moment JavaScript thinks it is.
 *
 * The cost, stated plainly: a track must be fetched and decoded whole before it
 * can play, which costs a few seconds and a lot of RAM for a five-minute
 * stereo track. Only the most recent track is kept decoded.
 */

import type { SyncTarget } from './syncEngine';
import type { ResolvedTrack } from './audioTarget';

/** Small scheduling headroom so start() is never called in the past. */
const SCHEDULE_AHEAD_S = 0.06;

/**
 * One decoded track is ~100MB, so we keep exactly this many and no more.
 * Evicting is safe even mid-playback: a running AudioBufferSourceNode holds its
 * own reference to the buffer, so the track still plays to the end.
 */
const MAX_BUFFERED = 1;

/** How far the output head may trail the render clock before we distrust it. */
const MAX_PLAUSIBLE_LATENCY_S = 2;

/** Smoothing for the measured latency. Output latency wanders; drift does not. */
const LATENCY_EMA = 0.08;

export interface WebAudioTargetOptions {
  resolve: (trackKey: string) => ResolvedTrack | null;
  onTrackChanged?: (track: ResolvedTrack) => void;
  onLoading?: (loading: boolean) => void;
  onError?: (message: string) => void;
  /** Called if the browser refuses to start audio until a gesture happens. */
  onBlocked?: (blocked: boolean) => void;
  /** Fired when a track reaches its end on its own. */
  onEnded?: () => void;
}

export class WebAudioTarget implements SyncTarget {
  private ctx: AudioContext;
  private gain: GainNode;
  private source: AudioBufferSourceNode | null = null;

  private track: ResolvedTrack | null = null;
  private currentKey: string | null = null;
  /** Decoded buffers, oldest first. Kept tiny on purpose — see MAX_BUFFERED. */
  private buffers = new Map<string, AudioBuffer>();

  /** ctx.currentTime at which the current source begins, and its track offset. */
  private startedAtCtx = 0;
  private offsetAtStartS = 0;
  private playing = false;
  /** True between scheduling a start and the moment that start actually arrives. */
  private startPending = false;
  private loading = false;
  private blocked = false;
  private loadToken = 0;

  /**
   * Measured gap between the render clock and the frame currently reaching the
   * speaker, smoothed. This is the number `getOutputTimestamp()` exists to
   * give us, and it is what makes two different devices agree on what is
   * actually audible rather than merely what their graphs believe.
   */
  private latencyS = 0;
  private hasLatency = false;

  private opts: WebAudioTargetOptions;

  constructor(opts: WebAudioTargetOptions) {
    this.opts = opts;
    const Ctor: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || window.AudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.seedLatencyFallback();
  }

  /* ---------------- the audible clock ---------------- */

  /** Whatever the browser will admit to before we have measured anything. */
  private seedLatencyFallback(): void {
    const anyCtx = this.ctx as AudioContext & { outputLatency?: number };
    const reported = anyCtx.outputLatency || this.ctx.baseLatency || 0;
    this.latencyS = Math.max(0, Math.min(reported, MAX_PLAUSIBLE_LATENCY_S));
  }

  /**
   * Re-measure the render-to-speaker gap.
   *
   * `getOutputTimestamp()` reports the audio-clock position of the frame that
   * is leaving the device right now. Subtracting it from `currentTime` gives the
   * output latency directly, measured rather than guessed — which is strictly
   * better than subtracting a reported `outputLatency`, and the only reason
   * this file exists instead of an `<audio>` element.
   */
  private sampleLatency(): void {
    if (this.ctx.state !== 'running') return;
    let ts: AudioTimestamp | undefined;
    try { ts = this.ctx.getOutputTimestamp?.(); } catch { ts = undefined; }
    if (!ts) return;
    // A running-but-idle context reports zeros; that is not a measurement.
    if (!ts.contextTime || !ts.performanceTime) return;

    const gap = this.ctx.currentTime - ts.contextTime;
    if (!Number.isFinite(gap) || gap < 0 || gap > MAX_PLAUSIBLE_LATENCY_S) return;

    this.latencyS = this.hasLatency ? this.latencyS + (gap - this.latencyS) * LATENCY_EMA : gap;
    this.hasLatency = true;
  }

  /**
   * The audio-clock position of the sound currently reaching the speaker.
   * Everything downstream compares this, never `ctx.currentTime`.
   */
  private audibleCtxNow(): number {
    this.sampleLatency();
    return this.ctx.currentTime - this.latencyS;
  }

  /** Latency between our render clock and the speaker, in ms. Diagnostics only. */
  get outputLatencyMs(): number {
    return this.latencyS * 1000;
  }

  /** True once `getOutputTimestamp()` has given us a real reading. */
  get latencyMeasured(): boolean {
    return this.hasLatency;
  }

  /**
   * Maps this device's audio clock onto the wall clock, so server timestamps
   * can be compared against what is being heard. Returns null when the browser
   * cannot answer.
   */
  audibleClock(): { contextTime: number; performanceTime: number } | null {
    let ts: AudioTimestamp | undefined;
    try { ts = this.ctx.getOutputTimestamp?.(); } catch { ts = undefined; }
    if (!ts || !ts.contextTime || !ts.performanceTime) return null;
    return { contextTime: ts.contextTime, performanceTime: ts.performanceTime };
  }

  /**
   * Position of the audio *at the speaker*, not in the graph. Subtracting the
   * output latency is what makes two devices with different pipelines agree on
   * what is actually being heard at a given instant.
   */
  getPositionMs(): number {
    if (!this.playing && !this.startPending) return this.offsetAtStartS * 1000;
    // Before the scheduled start the source has not begun, so the playhead is
    // wherever it was parked — never negative, never advanced.
    const audible = this.audibleCtxNow();
    const elapsed = Math.max(0, audible - this.startedAtCtx);
    return (elapsed + this.offsetAtStartS) * 1000;
  }

  getTrackKey(): string | null { return this.currentKey; }
  isPlaying(): boolean {
    if (!this.playing) return false;
    // A scheduled start is not playing until its moment arrives.
    if (this.startPending && this.ctx.currentTime < this.startedAtCtx) return false;
    return true;
  }
  isBuffering(): boolean { return this.loading || !this.track; }
  getDurationMs(): number { return this.track?.durationMs ?? 0; }

  /** True when autoplay policy is refusing to let the context run. */
  isBlocked(): boolean { return this.blocked; }

  /** True while a start is queued for a future moment. */
  hasPendingStart(): boolean {
    return this.startPending && this.ctx.currentTime < this.startedAtCtx;
  }

  /* ---------------- loading ---------------- */

  async load(trackKey: string): Promise<void> {
    if (this.currentKey === trackKey && this.track) return;

    const track = this.opts.resolve(trackKey);
    if (!track) throw new Error('that track is not in the shared library');

    const token = ++this.loadToken;
    this.currentKey = trackKey;
    this.startPending = false;
    this.stopSource();

    let buffer = this.buffers.get(trackKey);
    if (!buffer) {
      this.loading = true;
      this.opts.onLoading?.(true);
      let decoded: AudioBuffer;
      try {
        decoded = await this.fetchAndDecode(track);
      } finally {
        if (token === this.loadToken) {
          this.loading = false;
          this.opts.onLoading?.(false);
        }
      }
      if (token !== this.loadToken) return;      // superseded by a newer load
      buffer = decoded;
      this.buffers.set(trackKey, buffer);
      while (this.buffers.size > MAX_BUFFERED) {
        const oldest = this.buffers.keys().next().value;
        if (oldest === undefined) break;
        this.buffers.delete(oldest);
      }
    }

    this.track = { ...track, durationMs: Math.round(buffer.duration * 1000) };
    this.offsetAtStartS = 0;
    this.playing = false;
    this.opts.onTrackChanged?.(this.track);
  }

  private async fetchAndDecode(track: ResolvedTrack): Promise<AudioBuffer> {
    const res = await fetch(track.url);
    if (!res.ok) throw new Error(`could not download that track (HTTP ${res.status})`);
    const raw = await res.arrayBuffer();
    try {
      return await this.ctx.decodeAudioData(raw);
    } catch {
      throw new Error('that track could not be decoded');
    }
  }

  /* ---------------- transport ---------------- */

  private buildSource(): AudioBufferSourceNode | null {
    if (!this.track) return null;
    const buffer = this.buffers.get(this.currentKey ?? '');
    if (!buffer) return null;

    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1;
    src.connect(this.gain);
    src.onended = () => {
      // Ignore teardown we caused ourselves; only a natural end counts.
      if (this.source !== src) return;
      const dur = src.buffer ? src.buffer.duration : 0;
      this.source = null;
      this.playing = false;
      this.startPending = false;
      this.offsetAtStartS = dur;
      this.opts.onEnded?.();
    };
    return src;
  }

  private stopSource(): void {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* ignore */ }
      this.source = null;
    }
    this.playing = false;
    this.startPending = false;
  }

  /**
   * Start (or restart) playback at `offsetS`, beginning `delayS` from now.
   * Scheduling ahead rather than firing immediately is what makes the position
   * arithmetic exact instead of approximate.
   */
  private startAt(offsetS: number, delayS = SCHEDULE_AHEAD_S): boolean {
    const src = this.buildSource();
    if (!src || !this.track) return false;
    const dur = src.buffer ? src.buffer.duration : this.track.durationMs / 1000;
    const clamped = Math.max(0, Math.min(offsetS, Math.max(0, dur - 0.02)));

    const when = this.ctx.currentTime + Math.max(0.005, delayS);
    src.start(when, clamped);
    this.source = src;
    this.startedAtCtx = when;
    this.offsetAtStartS = clamped;
    this.playing = true;
    this.startPending = when > this.ctx.currentTime;
    return true;
  }

  async play(): Promise<void> {
    if (!(await this.unlock())) throw new Error('audio is blocked');
    this.startAt(this.getPositionMs() / 1000);
  }

  /**
   * Start at an absolute moment on the room server's clock. The delta from
   * *now* is what actually matters, so any error in the server-clock estimate
   * cancels out — every client is scheduled by the same relative offset.
   */
  schedulePlay(atServerMs: number, fromMs: number, serverNowMs: number): boolean {
    const delayS = (atServerMs - serverNowMs) / 1000;
    if (!Number.isFinite(delayS) || delayS < 0 || delayS > 30) return false;
    return this.startAt(Math.max(0, fromMs) / 1000, delayS);
  }

  /** Best-effort context resume. False means a gesture is still required. */
  async unlock(): Promise<boolean> {
    // Read through a helper: TypeScript narrows `state` optimistically after
    // the await below, which would make the second check look impossible.
    const state = (): AudioContextState => this.ctx.state;
    if (state() === 'running') {
      this.blocked = false;
      this.opts.onBlocked?.(false);
      return true;
    }
    try { await this.ctx.resume(); } catch { /* needs a gesture */ }
    const running = state() === 'running';
    this.blocked = !running;
    this.opts.onBlocked?.(!running);
    if (running) this.seedLatencyFallback();
    return running;
  }

  pause(): void {
    // Capture the real position before tearing the graph down, otherwise we
    // would lose the playhead entirely.
    const at = this.getPositionMs() / 1000;
    this.stopSource();
    this.offsetAtStartS = at;
  }

  /**
   * Seeking is a stop-and-restart, which is genuinely sample-accurate with
   * Web Audio — no rounding to the nearest frame the way an element does.
   */
  seek(ms: number): void {
    const dur = this.getDurationMs() / 1000;
    const target = dur > 0
      ? Math.max(0, Math.min(ms / 1000, dur - 0.02))
      : Math.max(0, ms / 1000);
    this.offsetAtStartS = target;
    if (this.playing) this.startAt(target);
  }

  setRate(rate: number): void {
    if (!this.source) return;
    const r = Math.max(0.5, Math.min(2, rate));
    try { this.source.playbackRate.value = r; } catch { /* node gone */ }
  }

  setVolume(v: number): void {
    try { this.gain.gain.value = Math.max(0, Math.min(1, v)); } catch { /* ignore */ }
  }

  dispose(): void {
    this.stopSource();
    this.buffers.clear();
    void this.ctx.close().catch(() => {});
  }
}

export function createWebAudioTarget(opts: WebAudioTargetOptions): WebAudioTarget {
  return new WebAudioTarget(opts);
}