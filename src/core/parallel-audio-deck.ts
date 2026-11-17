import type { AudioVersion } from './audio-versions';
import { bufferChannels, matchLevelToReference, measureAudioBuffer, toAudioBuffer, type LoudnessStats } from './loudness';

export type VersionSources = Partial<Record<AudioVersion, string[]>>;
export type VersionLoadState = 'loading' | 'ready' | 'failed';
export const VERSION_FADE_SECONDS = .12;
interface Voice { source: AudioBufferSourceNode; gain: GainNode }
interface Output { context: AudioContext; destination: AudioNode }

/** The native element remains the transport/Media Session clock. Prepared
 * renditions share one Web Audio clock; switching only moves their gains.
 * No file is processed, and no transport source is replaced during a switch. */
export class ParallelAudioDeck {
  readonly states: Partial<Record<AudioVersion, VersionLoadState>> = {};
  requested: AudioVersion = 'original';
  active: AudioVersion = 'original';
  private buffers = new Map<AudioVersion, AudioBuffer>();
  private sourceBuffers = new Map<AudioVersion, AudioBuffer>();
  private gains = new Map<AudioVersion, number>();
  private reference: LoudnessStats | null = null;
  private voices = new Map<AudioVersion, Voice>();
  private abort: AbortController | null = null;
  private generation = 0;
  private activation = 0;
  private output: Output | null = null;
  private master: GainNode | null = null;
  private engaged = false;
  private ownsMute = false;
  private previousMute = false;
  private startTime = 0;
  private startOffset = 0;
  private running = false;
  private enabled = false;
  private sources: VersionSources = {};
  private observedContext: AudioContext | null = null;
  private contextChanged = () => {
    if (!this.enabled) return;
    if (this.output.context.state !== 'running') this.stopVoices();
    else if (!this.running && !this.transport.paused) void this.activate();
  };

  get loaded(): boolean { return this.enabled; }

  constructor(
    private transport: HTMLAudioElement,
    private getOutput: () => Output,
    private changed: (version: AudioVersion, message: string) => void,
  ) {
    transport.addEventListener('playing', () => { if (this.enabled) void this.activate(); });
    for (const event of ['pause', 'waiting', 'seeking', 'ended']) {
      transport.addEventListener(event, () => { this.activation++; this.stopVoices(); });
    }
    transport.addEventListener('seeked', () => { if (this.enabled && !transport.paused) void this.activate(); });
    transport.addEventListener('ratechange', () => {
      this.stopVoices(); if (this.enabled && !transport.paused) void this.activate();
    });
    transport.addEventListener('volumechange', () => {
      if (this.master) this.master.gain.setTargetAtTime(transport.volume, this.output.context.currentTime, .01);
    });
  }

  load(sources: VersionSources, preferred: AudioVersion): void {
    this.dispose();
    this.enabled = true;
    this.sources = sources;
    this.requested = preferred;
    this.abort = new AbortController();
    const generation = this.generation;
    try {
      this.output = this.getOutput();
      if (this.observedContext !== this.output.context) {
        this.observedContext?.removeEventListener('statechange', this.contextChanged);
        this.observedContext = this.output.context;
        this.observedContext.addEventListener('statechange', this.contextChanged);
      }
      this.master = this.output.context.createGain();
      this.master.gain.value = this.transport.volume;
      this.master.connect(this.output.destination);
      // Unlock in the selecting gesture, before downloads finish.
      void this.output.context.resume().catch(() => {});
    } catch {
      this.enabled = false;
      this.changed('original', 'Sound switching is unavailable in this browser. Using Original.');
      return;
    }
    for (const version of Object.keys(sources) as AudioVersion[]) this.states[version] = 'loading';
    // All three preparations start together. Each has independent retries.
    for (const [version, urls] of Object.entries(sources) as [AudioVersion, string[]][]) {
      void this.prepare(version, urls, generation);
    }
    this.notify();
  }

  select(version: AudioVersion): void {
    if (!this.enabled) return;
    this.requested = version;
    this.activation++;
    if (this.states[version] === 'failed' && this.sources[version]) {
      this.states[version] = 'loading';
      void this.prepare(version, this.sources[version], this.generation);
    }
    this.notify();
    void this.activate();
  }

  private async prepare(version: AudioVersion, urls: string[], generation: number): Promise<void> {
    const signal = this.abort.signal;
    const context = this.output.context;
    for (const url of [...new Set(urls)]) {
      if (generation !== this.generation) return;
      // A hung source must not keep its direct-HF fallback pending forever.
      const attempt = new AbortController();
      const cancel = () => attempt.abort();
      signal.addEventListener('abort', cancel, {once: true});
      const timer = setTimeout(cancel, 30_000);
      try {
        const response = await fetch(url, {signal: attempt.signal});
        if (!response.ok) throw new Error('Audio unavailable');
        const bytes = await response.arrayBuffer();
        if (generation !== this.generation) return;
        const buffer = await context.decodeAudioData(bytes);
        if (generation !== this.generation) return;
        const ready = this.levelMatch(version, buffer);
        this.buffers.set(version, ready.buffer);
        this.states[version] = 'ready';
        if (this.running) this.addVoice(version);
        this.notify();
        void this.activate();
        return;
      } catch {
        if (generation !== this.generation || signal.aborted) return;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      }
    }
    if (generation !== this.generation) return;
    this.states[version] = 'failed';
    const requested = this.requested === version;
    if (requested) this.requested = this.active;
    this.notify(!requested || version === 'original' ? '' : `This sound couldn't load. Keeping ${this.active === 'original' ? 'Original' : 'your current sound'}.`);
    void this.activate();
  }

  private notify(message = ''): void {
    const pending = this.requested !== this.active && this.states[this.requested] === 'loading';
    this.changed(this.active, message || (pending ? 'Preparing your sound. Music keeps playing…' : ''));
  }

  /**
   * Level-match a decoded rendition to the song's original.
   *
   * Prepared renditions ship ~8.5 LU quieter than the original they belong to,
   * so switching variants jumped in loudness. Renditions are lifted to the
   * original's measured loudness (never the other way around) under a peak
   * ceiling. The original itself is only measured; it is never touched.
   *
   * A rendition can finish decoding before the original, so it is kept aside
   * untouched and matched as soon as the reference exists.
   */
  private levelMatch(version: AudioVersion, buffer: AudioBuffer): {buffer: AudioBuffer} {
    const stats = measureAudioBuffer(buffer);
    if (version === 'original') {
      this.reference = stats;
      // Re-match renditions that finished before the reference existed.
      for (const [other, source] of this.sourceBuffers) {
        if (other === 'original') continue;
        if (this.reference) this.buffers.set(other, this.matchedBuffer(other, source));
      }
      return {buffer};
    }
    if (!this.reference) {
      this.sourceBuffers.set(version, buffer);
      return {buffer};
    }
    return {buffer: this.matchedBuffer(version, buffer, stats)};
  }

  /** Apply the reference correction to a rendition's untouched source buffer. */
  private matchedBuffer(version: AudioVersion, source: AudioBuffer, precomputed?: LoudnessStats): AudioBuffer {
    const reference = this.reference;
    if (!reference || version === 'original') return source;
    const result = matchLevelToReference(bufferChannels(source), source.sampleRate, reference.lufs, precomputed);
    const applied = result?.gainDb ?? 0;
    this.gains.set(version, applied);
    return result ? toAudioBuffer(source, result.channels) : source;
  }

  private async activate(): Promise<void> {
    if (!this.enabled) return;
    if (this.requested === 'original' && this.states.original === 'failed' && this.engaged) {
      this.useNativeOriginal();
      return;
    }
    const target = this.buffers.has(this.requested) ? this.requested : this.active;
    const buffer = this.buffers.get(target);
    // The original native stream is already available while preparations run.
    if (!buffer) {
      if (target === 'original' && !this.engaged) { this.active = 'original'; this.notify(); }
      return;
    }
    if (buffer.duration <= this.transport.currentTime && !this.transport.ended) {
      this.useNativeOriginal('This sound has ended. Continuing with Original.');
      return;
    }
    if (this.transport.paused || this.transport.ended) {
      this.active = target;
      this.notify();
      return;
    }
    const generation = this.generation, activation = ++this.activation;
    const {context} = this.output;
    try { if (context.state !== 'running') await context.resume(); } catch { return; }
    if (generation !== this.generation || activation !== this.activation || this.transport.paused ||
        this.transport.seeking || context.state !== 'running') return;
    if (!this.running) {
      this.startTime = context.currentTime;
      this.startOffset = this.transport.currentTime;
      this.running = true;
      for (const version of this.buffers.keys()) this.addVoice(version);
    }
    if (!this.voices.has(target)) return;
    const handoff = !this.engaged;
    if (!this.ownsMute) {
      this.previousMute = this.transport.muted;
      this.ownsMute = true;
      this.transport.muted = true;
    }
    this.engaged = true;
    const when = Math.max(context.currentTime, this.startTime);
    // Linear complementary gains avoid boosting correlated versions at the
    // midpoint. Retargeting a fade holds its actual instantaneous gain.
    for (const [version, voice] of this.voices) {
      const gain = voice.gain.gain;
      // The first handoff replaces the same original at the same level. It
      // must not introduce a fade-in dip while downloads finish in the background.
      if (handoff && target === 'original' && version === target) gain.setValueAtTime(1, when);
      if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(when);
      else { const value = gain.value; gain.cancelScheduledValues(when); gain.setValueAtTime(value, when); }
      gain.linearRampToValueAtTime(version === target ? 1 : 0, when + VERSION_FADE_SECONDS);
    }
    this.active = target;
    this.notify();
  }

  private addVoice(version: AudioVersion): void {
    if (this.voices.has(version) || !this.running) return;
    const {context} = this.output, buffer = this.buffers.get(version);
    const when = Math.max(context.currentTime, this.startTime);
    const offset = this.startOffset + (when - this.startTime) * this.transport.playbackRate;
    if (!buffer || offset >= buffer.duration) return;
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = this.transport.playbackRate;
    gain.gain.value = 0;
    source.connect(gain).connect(this.master);
    source.start(when, Math.max(0, offset));
    this.voices.set(version, {source, gain});
  }

  private stopVoices(): void {
    for (const {source, gain} of this.voices.values()) {
      try { source.stop(); } catch { /* already ended */ }
      source.disconnect(); gain.disconnect();
    }
    this.voices.clear();
    this.running = false;
  }

  private useNativeOriginal(message = ''): void {
    this.stopVoices();
    if (this.ownsMute) this.transport.muted = this.previousMute;
    this.ownsMute = this.engaged = false;
    this.active = this.requested = 'original';
    this.notify(message);
  }

  dispose(): void {
    this.generation++;
    this.activation++;
    this.enabled = false;
    this.abort?.abort();
    this.abort = null;
    this.stopVoices();
    this.buffers.clear();
    this.sourceBuffers.clear();
    this.gains.clear();
    this.reference = null;
    this.sources = {};
    this.master?.disconnect();
    this.master = null;
    if (this.ownsMute) this.transport.muted = this.previousMute;
    this.ownsMute = this.engaged = false;
    this.active = this.requested = 'original';
    for (const key of Object.keys(this.states)) delete this.states[key];
  }
}
