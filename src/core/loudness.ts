/**
 * Loudness matching for preprocessed renditions.
 *
 * The sub-bass renderer adds a large amount of gain, then attenuates the whole
 * render linearly so its decoded peak fits under -1 dBFS. That attenuation also
 * scales down the untouched mid/high content, so a "Bass" or "Bass + Reverb"
 * file arrives ~8.5 LU below its own song's original. Switching from a quiet
 * rendition to the loud original makes the listener reach for the system volume
 * twice for one song.
 *
 * This module measures integrated loudness per ITU-R BS.1770-4 (K-weighting
 * plus the -70 LUFS absolute and -10 LU relative gates) so a rendition can be
 * lifted to the loudness of the same song's original. Originals are never
 * altered: they are the reference every rendition is matched against, which is
 * exactly what stops volume jumping between songs.
 *
 * Everything operates on plain channel data so it is testable without a
 * browser, and so playback nodes stay untouched.
 */

/** Peak ceiling for a boosted rendition. Leaves headroom for the output chain. */
export const LEVEL_CEILING = 0.891; // -1.00 dBFS
/** Above this amplitude the peak is shaped instead of scaled, so loudness survives. */
export const LEVEL_KNEE = 0.7;
/** A rendition is never lifted or cut further than this. */
export const MAX_LEVEL_ADJUSTMENT_DB = 15;
/** Below this the correction is inaudible and not worth rewriting the buffer. */
export const MIN_LEVEL_ADJUSTMENT_DB = 0.5;
/** Residual loudness error that ends the correction loop. */
export const LEVEL_TOLERANCE_LU = 0.5;
/** K-weighting and gating are broadband measures; 8 kHz keeps them accurate and cheap. */
const ANALYSIS_RATE = 8000;

export interface LoudnessStats {
  /** Integrated loudness in LUFS. -Infinity for silence. */
  lufs: number;
  /** Largest absolute sample value across channels. */
  peak: number;
}

export interface LevelMatchResult {
  /** Corrected channel data. Fresh arrays; inputs are never mutated. */
  channels: Float32Array[];
  /** Total level correction applied, in dB. */
  gainDb: number;
  /** Loudness of the corrected audio. */
  lufs: number;
  /** Sample peak of the corrected audio. */
  peak: number;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** BS.1770 K-weighting stage 1: +4 dB high shelf. */
function shelfStage(sampleRate: number): Biquad {
  const f0 = 1681.9744509555319, Q = 0.7071752369554196, gainDb = 3.999843853973347;
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw = Math.cos(w0), sqrtA = Math.sqrt(A);
  const a0 = (A + 1) - (A - 1) * cosw + 2 * sqrtA * alpha;
  return {
    b0: A * ((A + 1) + (A - 1) * cosw + 2 * sqrtA * alpha) / a0,
    b1: -2 * A * ((A - 1) + (A + 1) * cosw) / a0,
    b2: A * ((A + 1) + (A - 1) * cosw - 2 * sqrtA * alpha) / a0,
    a1: 2 * ((A - 1) - (A + 1) * cosw) / a0,
    a2: ((A + 1) - (A - 1) * cosw - 2 * sqrtA * alpha) / a0,
  };
}

/** BS.1770 K-weighting stage 2: RLB high-pass. */
function highPassStage(sampleRate: number): Biquad {
  const f0 = 38.13547087602444, Q = 0.5003270373238773;
  const w0 = 2 * Math.PI * f0 / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: -(1 + cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: -2 * cosw / a0,
    a2: (1 - alpha) / a0,
  };
}

function filter(input: Float32Array, stage: Biquad): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = stage.b0 * x + stage.b1 * x1 + stage.b2 * x2 - stage.a1 * y1 - stage.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; output[i] = y;
  }
  return output;
}

/** Averaging decimation. Loudness is a broadband weighted-energy measure, so a
 * box filter's mild treble roll-off affects the reference and the rendition
 * alike and cancels out of the difference this module actually uses. */
function decimate(input: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return input;
  const length = Math.floor(input.length / factor);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) sum += input[base + j];
    output[i] = sum / factor;
  }
  return output;
}

function decimationFactor(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
}

/** Integrated loudness (LUFS) and sample peak of already-decoded audio. */
export function measureLoudness(channels: Float32Array[], sampleRate: number): LoudnessStats {
  if (!channels.length || !(sampleRate > 0)) return { lufs: -Infinity, peak: 0 };
  const factor = decimationFactor(sampleRate);
  const rate = sampleRate / factor;
  const shelf = shelfStage(rate), highPass = highPassStage(rate);

  let peak = 0;
  const weighted: Float32Array[] = [];
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i]);
      if (value > peak) peak = value;
    }
    weighted.push(filter(filter(decimate(channel, factor), shelf), highPass));
  }

  const blockSize = Math.round(.4 * rate), hop = Math.round(.1 * rate);
  const frames = Math.min(...weighted.map((channel) => channel.length));
  if (frames < blockSize) return { lufs: -Infinity, peak };

  // Gating blocks carry the mean square energy of all channels of that block.
  const energies: number[] = [];
  for (let start = 0; start + blockSize <= frames; start += hop) {
    let sum = 0;
    for (const channel of weighted) {
      let energy = 0;
      for (let i = start; i < start + blockSize; i++) energy += channel[i] * channel[i];
      sum += energy / blockSize;
    }
    energies.push(sum);
  }
  if (!energies.length) return { lufs: -Infinity, peak };

  const loudness = (energy: number) => -0.691 + 10 * Math.log10(Math.max(energy, 1e-20));
  // Absolute gate: blocks quieter than -70 LUFS never count.
  const absolute = energies.filter((energy) => loudness(energy) > -70);
  if (!absolute.length) return { lufs: -Infinity, peak };
  // Relative gate: blocks more than 10 LU under the gated mean are dropped.
  const mean = absolute.reduce((total, energy) => total + energy, 0) / absolute.length;
  const relative = loudness(mean) - 10;
  const gated = absolute.filter((energy) => loudness(energy) > relative);
  const kept = gated.length ? gated : absolute;
  const finalMean = kept.reduce((total, energy) => total + energy, 0) / kept.length;
  return { lufs: loudness(finalMean), peak };
}

/**
 * Level correction in dB that brings `target` to the loudness of `reference`.
 * Returns 0 when either side is unmeasurable (silence, missing audio) so an
 * unknown rendition keeps its original level instead of guessing.
 */
export function matchingGainDb(reference: LoudnessStats | null | undefined, target: LoudnessStats | null | undefined): number {
  if (!reference || !target) return 0;
  if (!Number.isFinite(reference.lufs) || !Number.isFinite(target.lufs)) return 0;
  const gain = reference.lufs - target.lufs;
  if (!Number.isFinite(gain)) return 0;
  return Math.max(-MAX_LEVEL_ADJUSTMENT_DB, Math.min(MAX_LEVEL_ADJUSTMENT_DB, gain));
}

/** Soft knee shaper: linear below the knee, tanh above it, ceiling never exceeded. */
function shape(sample: number, knee: number, ceiling: number): number {
  const magnitude = Math.abs(sample);
  if (magnitude <= knee) return sample;
  const span = ceiling - knee;
  if (!(span > 0)) return Math.sign(sample) * ceiling;
  const limited = knee + span * Math.tanh((magnitude - knee) / span);
  return Math.sign(sample) * limited;
}

/**
 * Apply a level correction to decoded channels, shaping any peak that would
 * pass the ceiling. The gain is written into the samples rather than a playback
 * node so the result is deterministic and measurable, and so a boosted
 * rendition can never clip the shared output graph.
 */
export function applyLevel(channels: Float32Array[], gainDb: number, knee = LEVEL_KNEE, ceiling = LEVEL_CEILING): Float32Array[] {
  const gain = Math.pow(10, gainDb / 20);
  if (!Number.isFinite(gain) || gain === 1) return channels;
  return channels.map((channel) => {
    const output = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) output[i] = shape(channel[i] * gain, knee, ceiling);
    return output;
  });
}

/** True when a correction is worth applying at all. */
export function isLevelCorrectionWorthwhile(gainDb: number): boolean {
  return Number.isFinite(gainDb) && Math.abs(gainDb) >= MIN_LEVEL_ADJUSTMENT_DB;
}

/** Read a decoded buffer as plain channel data for analysis. */
export function bufferChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let index = 0; index < buffer.numberOfChannels; index++) {
    channels.push(buffer.getChannelData(index));
  }
  return channels;
}

/**
 * Closed-loop match: lift `channels` to `referenceLufs`, shaping peaks under the
 * ceiling, then re-measure and top up once — soft-knee shaping absorbs part of
 * the first gain step, so one extra pass closes most of the residual gap.
 * Returns null when no meaningful correction is needed or possible; inputs are
 * never mutated.
 */
export function matchLevelToReference(
  channels: Float32Array[],
  sampleRate: number,
  referenceLufs: number,
  targetStats?: LoudnessStats,
): LevelMatchResult | null {
  if (!Number.isFinite(referenceLufs)) return null;
  const stats = targetStats ?? measureLoudness(channels, sampleRate);
  const gainDb = matchingGainDb({lufs: referenceLufs, peak: stats.peak}, stats);
  if (!isLevelCorrectionWorthwhile(gainDb)) return null;

  let current = channels;
  let applied = 0;
  let lufs = stats.lufs, peak = stats.peak;
  for (let pass = 0; pass < 2; pass++) {
    const step = pass === 0
      ? gainDb
      : matchingGainDb({lufs: referenceLufs, peak}, {lufs, peak});
    if (!isLevelCorrectionWorthwhile(step) && pass > 0) break;
    if (applied + step > MAX_LEVEL_ADJUSTMENT_DB || applied + step < -MAX_LEVEL_ADJUSTMENT_DB) break;
    current = applyLevel(current, step);
    applied += step;
    const measured = measureLoudness(current, sampleRate);
    lufs = measured.lufs; peak = measured.peak;
    if (Math.abs(referenceLufs - lufs) <= LEVEL_TOLERANCE_LU) break;
  }
  return {channels: current, gainDb: applied, lufs, peak};
}

/** Convenience overload: measure a decoded AudioBuffer directly. */
export function measureAudioBuffer(buffer: AudioBuffer): LoudnessStats {
  return measureLoudness(bufferChannels(buffer), buffer.sampleRate);
}

/**
 * Convenience overload: match a decoded AudioBuffer to `referenceLufs`, writing
 * the corrected samples into a copy of `buffer` when a correction applies.
 * Returns the input buffer unchanged when no meaningful correction applies.
 */
export function matchBufferToReference(buffer: AudioBuffer, referenceLufs: number): {buffer: AudioBuffer; gainDb: number} {
  const stats = measureAudioBuffer(buffer);
  if (!Number.isFinite(referenceLufs) || !Number.isFinite(stats.lufs)) return {buffer, gainDb: 0};
  const result = matchLevelToReference(bufferChannels(buffer), buffer.sampleRate, referenceLufs, stats);
  if (!result) return {buffer, gainDb: 0};
  return {buffer: toAudioBuffer(buffer, result.channels), gainDb: result.gainDb};
}

/** Build a buffer sharing `template`'s format from corrected channel data. */
export function toAudioBuffer(template: AudioBuffer, channels: Float32Array[]): AudioBuffer {
  const output = new AudioBuffer({
    length: template.length,
    sampleRate: template.sampleRate,
    numberOfChannels: channels.length,
  });
  for (let index = 0; index < channels.length; index++) output.copyToChannel(channels[index] as Float32Array<ArrayBuffer>, index);
  return output;
}
