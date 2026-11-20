import { expect, test } from '@playwright/test';
import {
  LEVEL_CEILING,
  LIMITER_LOOKAHEAD_MS,
  MAX_LEVEL_ADJUSTMENT_DB,
  applyLevel,
  bufferChannels,
  matchBufferToReference,
  matchLevelToReference,
  matchingGainDb,
  measureLoudness,
} from '../../src/core/loudness';

const RATE = 48_000;

// Unit tests run in plain Node, which has no AudioBuffer constructor; provide a
// minimal stand-in so the buffer helpers' code paths are covered without a
// browser. The real constructor is exercised by the e2e suite.
class AudioBufferStub {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  private store: Float32Array[];
  constructor(options: {length: number; sampleRate: number; numberOfChannels: number}) {
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.numberOfChannels = options.numberOfChannels;
    this.store = Array.from({length: options.numberOfChannels}, () => new Float32Array(options.length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(index: number): Float32Array { return this.store[index]; }
  copyToChannel(source: Float32Array, index: number): void { this.store[index].set(source); }
}
(globalThis as any).AudioBuffer ??= AudioBufferStub;

/** Deterministic stereo material with broadband content: tones plus noise. */
function makeAudio(seconds: number, seed = 7): Float32Array[] {
  const length = Math.round(seconds * RATE);
  const left = new Float32Array(length), right = new Float32Array(length);
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff * 2 - 1;
  };
  for (let i = 0; i < length; i++) {
    const t = i / RATE;
    const value = .3 * Math.sin(2 * Math.PI * 220 * t) +
      .25 * Math.sin(2 * Math.PI * 550 * t + .7) +
      .2 * Math.sin(2 * Math.PI * 3000 * t + 1.1) +
      .08 * random();
    left[i] = value;
    right[i] = value * .9;
  }
  return [left, right];
}

/** Tone-only material (no per-sample noise), built at an arbitrary rate. */
function makeToneAudio(seconds: number, rate: number): Float32Array[] {
  const length = Math.round(seconds * rate);
  const left = new Float32Array(length), right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const value = .3 * Math.sin(2 * Math.PI * 220 * t) +
      .25 * Math.sin(2 * Math.PI * 550 * t + .7) +
      .2 * Math.sin(2 * Math.PI * 3000 * t + 1.1);
    left[i] = value;
    right[i] = value * .9;
  }
  return [left, right];
}

function maxAbsDeviation(channels: Float32Array[], ceiling: number): number {
  let worst = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      const violation = Math.abs(sample) - ceiling;
      if (violation > worst) worst = violation;
    }
  }
  return worst;
}

test('silence and short inputs measure as unmeasurable', () => {
  expect(measureLoudness([new Float32Array(RATE), new Float32Array(RATE)], RATE).lufs).toBe(-Infinity);
  expect(measureLoudness([], RATE).lufs).toBe(-Infinity);
  expect(measureLoudness([new Float32Array(100)], RATE).lufs).toBe(-Infinity);
  expect(measureLoudness([new Float32Array(100)], RATE).peak).toBe(0);
});

test('scaling audio by known dB shifts measured loudness by the same amount', () => {
  const audio = makeAudio(2);
  const base = measureLoudness(audio, RATE);
  const lowered = measureLoudness(applyLevel(audio, -10), RATE);
  expect(lowered.lufs - base.lufs).toBeCloseTo(-10, 1);
  expect(lowered.peak).toBeCloseTo(base.peak * 10 ** (-10 / 20), 3);
});

test('measurement is unaffected by sample rate', () => {
  // 48 kHz and 24 kHz both decimate to the same 8 kHz analysis rate, so the
  // same analog program (tones only; per-sample noise is not rate-invariant)
  // must measure identically at either input rate.
  const at48k = measureLoudness(makeToneAudio(2, RATE), RATE);
  const at24k = measureLoudness(makeToneAudio(2, 24_000), 24_000);
  expect(Math.abs(at48k.lufs - at24k.lufs)).toBeLessThan(.1);
});

test('matching gain is the reference/target gap and clamps to the safety bounds', () => {
  expect(matchingGainDb({lufs: -10, peak: 1}, {lufs: -20, peak: .5})).toBeCloseTo(10);
  expect(matchingGainDb({lufs: -20, peak: 1}, {lufs: -10, peak: .5})).toBeCloseTo(-10);
  expect(matchingGainDb({lufs: -5, peak: 1}, {lufs: -40, peak: .1})).toBe(MAX_LEVEL_ADJUSTMENT_DB);
  expect(matchingGainDb({lufs: -40, peak: 1}, {lufs: -5, peak: .1})).toBe(-MAX_LEVEL_ADJUSTMENT_DB);
  expect(matchingGainDb(null, {lufs: -10, peak: 1})).toBe(0);
  expect(matchingGainDb({lufs: -10, peak: 1}, null)).toBe(0);
  expect(matchingGainDb({lufs: -Infinity, peak: 0}, {lufs: -10, peak: 1})).toBe(0);
  expect(matchingGainDb({lufs: -10, peak: 1}, {lufs: -Infinity, peak: 0})).toBe(0);
});

test('applyLevel rides peaks to the ceiling and stays bit-transparent below it', () => {
  const audio = makeAudio(2);
  const gain = 10 ** (12 / 20);
  const boosted = applyLevel(audio, 12);
  // Peak safety: assert a single worst-case deviation instead of per-sample expects.
  expect(maxAbsDeviation(boosted, LEVEL_CEILING + 1e-6)).toBeLessThanOrEqual(0);
  // A program that already fits under the ceiling is a single multiply: no
  // limiter, no gain curve, no per-sample deviation from pure gain.
  const quiet = applyLevel(makeAudio(2), -20);
  const lifted = applyLevel(quiet, 3);
  expect(maxAbsDeviation(lifted, LEVEL_CEILING + 1e-6)).toBeLessThanOrEqual(0);
  let worstLinear = 0;
  for (let i = 0; i < quiet[0].length; i++) {
    worstLinear = Math.max(worstLinear, Math.abs(lifted[0][i] - quiet[0][i] * 10 ** (3 / 20)));
  }
  expect(worstLinear).toBeLessThan(1e-6);
  // A quiet program lifted 14 dB keeps its loudness gain through the limiter.
  const veryQuiet = applyLevel(makeAudio(1), -20);
  const hardLifted = applyLevel(veryQuiet, 14);
  expect(measureLoudness(hardLifted, RATE).lufs - measureLoudness(veryQuiet, RATE).lufs).toBeCloseTo(14, 1);
});

test('limiting scales the waveform instead of bending samples, so a boosted tone stays clean', () => {
  // The soft-knee shaper this replaced bent every sample above its knee and
  // measured heavy harmonic distortion on a boosted sine. Scaling must not:
  // a steady tone leaves the limiter as a sinusoid at a lower level.
  const seconds = 1;
  const length = Math.round(seconds * RATE);
  const frequency = 220;
  const source = new Float32Array(length);
  for (let i = 0; i < length; i++) source[i] = .5 * Math.sin(2 * Math.PI * frequency * i / RATE);

  const boosted = applyLevel([source], 12, RATE)[0];
  expect(maxAbsDeviation([boosted], LEVEL_CEILING + 1e-6)).toBeLessThanOrEqual(0);

  // Compare against the best-fit sinusoid at the same frequency: a scaling
  // limiter leaves only amplitude error, a waveshaper leaves harmonic residue.
  let dot = 0, norm = 0;
  for (let i = 0; i < length; i++) {
    const basis = Math.sin(2 * Math.PI * frequency * i / RATE);
    dot += boosted[i] * basis;
    norm += basis * basis;
  }
  const fitted = dot / norm;
  let residual = 0, energy = 0;
  for (let i = 0; i < length; i++) {
    const basis = Math.sin(2 * Math.PI * frequency * i / RATE);
    residual += (boosted[i] - fitted * basis) ** 2;
    energy += (fitted * basis) ** 2;
  }
  // Harmonic residue stays under 1% of the fundamental's energy.
  expect(residual / energy).toBeLessThan(.01);
});

test('the lookahead window pulls gain down before a transient arrives', () => {
  // Quiet bed, then a loud burst. With lookahead the gain must already be
  // reduced ahead of the burst, so the attack is not clamped after the fact.
  const length = RATE;
  const source = new Float32Array(length);
  const burstStart = Math.round(.5 * RATE);
  for (let i = 0; i < length; i++) {
    source[i] = i < burstStart ? .05 * Math.sin(2 * Math.PI * 220 * i / RATE) : .9 * Math.sin(2 * Math.PI * 220 * i / RATE);
  }
  const boosted = applyLevel([source], 12, RATE)[0];
  expect(maxAbsDeviation([boosted], LEVEL_CEILING + 1e-6)).toBeLessThanOrEqual(0);

  // Immediately before the burst the output must already be attenuated well
  // below what a lookahead-free limiter would have produced.
  const lookaheadFrames = Math.round(LIMITER_LOOKAHEAD_MS / 1000 * RATE);
  const probe = burstStart - Math.round(lookaheadFrames / 2);
  const unscaled = Math.abs(source[probe]) * 10 ** (12 / 20);
  expect(Math.abs(boosted[probe])).toBeLessThan(unscaled * .95);
});

test('closed-loop match brings a quiet rendition to the reference within tolerance', () => {
  const referenceLufs = measureLoudness(makeAudio(6, 3), RATE).lufs;
  const rendition = applyLevel(makeAudio(6, 7), -9.5);
  const result = matchLevelToReference(rendition, RATE, referenceLufs);
  expect(result).not.toBeNull();
  expect(result!.gainDb).toBeGreaterThan(8);
  expect(Math.abs(result!.lufs - referenceLufs)).toBeLessThanOrEqual(.5);
  expect(maxAbsDeviation(result!.channels, LEVEL_CEILING + 1e-6)).toBeLessThanOrEqual(0);
});

test('match leaves already-matched audio untouched and returns null below threshold', () => {
  const audio = makeAudio(4);
  const referenceLufs = measureLoudness(audio, RATE).lufs;
  expect(matchLevelToReference(audio, RATE, referenceLufs)).toBeNull();
  expect(matchLevelToReference(applyLevel(audio, -.4), RATE, referenceLufs)).toBeNull();
});

test('match respects the maximum adjustment cap and stays peak-safe', () => {
  const referenceLufs = measureLoudness(makeAudio(2), RATE).lufs;
  const result = matchLevelToReference(applyLevel(makeAudio(2), -30), RATE, referenceLufs);
  expect(result).not.toBeNull();
  expect(result!.gainDb).toBeLessThanOrEqual(MAX_LEVEL_ADJUSTMENT_DB);
  expect(maxAbsDeviation(result!.channels, LEVEL_CEILING + 1e-6)).toBeLessThanOrEqual(0);
});

test('inputs are never mutated by matching', () => {
  const rendition = applyLevel(makeAudio(2), -9);
  const snapshot = rendition.map((channel) => Float32Array.from(channel));
  const referenceLufs = measureLoudness(rendition, RATE).lufs + 9;
  matchLevelToReference(rendition, RATE, referenceLufs);
  expect(rendition.map((channel, index) => {
    let identical = channel.length === snapshot[index].length;
    for (let i = 0; identical && i < channel.length; i++) identical = channel[i] === snapshot[index][i];
    return identical;
  })).toEqual([true, true]);
});

test('buffer helpers read and rebuild AudioBuffers without altering inputs', () => {
  const channels = makeAudio(1);
  const template = new AudioBuffer({length: channels[0].length, sampleRate: RATE, numberOfChannels: 2});
  template.copyToChannel(channels[0] as Float32Array<ArrayBuffer>, 0);
  template.copyToChannel(channels[1] as Float32Array<ArrayBuffer>, 1);
  const read = bufferChannels(template);
  expect(read).toHaveLength(2);
  const lufs = measureLoudness(read, RATE).lufs;
  const {buffer, gainDb} = matchBufferToReference(template, lufs);
  expect(buffer).toBe(template);
  expect(gainDb).toBe(0);
  expect(measureLoudness(bufferChannels(buffer), RATE).lufs).toBeCloseTo(lufs, 5);
});
