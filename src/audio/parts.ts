// Small shared pieces for generators, the way src/rigs/parts serves rigs.

import type { Rng } from '../engine/types';
import { paramTime, SAMPLE_RATE, type CueTimes } from './timing';

/** Seconds to a whole number of samples. */
export function toSamples(seconds: number): number {
  return Math.round(seconds * SAMPLE_RATE);
}

/**
 * A gain that fades in over `attack` seconds from the cue start, holds `level`,
 * and fades out over `release` seconds to reach 0 at the cue end. If the two
 * fades are longer than the cue, both shrink in proportion.
 */
export function envelopeGain(ctx: BaseAudioContext, times: CueTimes, level: number, attack: number, release: number): GainNode {
  const amp = new GainNode(ctx, { gain: 0 });
  const length = times.endSample - times.startSample;
  let a = toSamples(attack);
  let r = toSamples(release);
  if (a + r > length) {
    const k = length / (a + r);
    a = Math.floor(a * k);
    r = Math.floor(r * k);
  }
  const g = amp.gain;
  g.setValueAtTime(0, paramTime(times.startSample));
  g.linearRampToValueAtTime(level, paramTime(times.startSample + a));
  g.setValueAtTime(level, paramTime(times.endSample - r));
  g.linearRampToValueAtTime(0, paramTime(times.endSample));
  return amp;
}

/**
 * One second of seeded white noise, for a looping AudioBufferSourceNode.
 * The loop covers the whole buffer, so it restarts on a whole sample.
 */
export function noiseBuffer(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const buffer = ctx.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = rng.next() * 2 - 1;
  return buffer;
}

/**
 * A smooth random walk from -1 to 1, `perSecond` points a second over the
 * cue, for setValueCurveAtTime. The first point is 0 so the sound starts on
 * its base value.
 */
export function wanderCurve(times: CueTimes, perSecond: number, rng: Rng): Float32Array {
  const seconds = (times.endSample - times.startSample) / SAMPLE_RATE;
  const count = Math.max(2, Math.ceil(seconds * perSecond) + 1);
  const curve = new Float32Array(count);
  let value = 0;
  let velocity = 0;
  for (let i = 1; i < count; i++) {
    velocity = velocity * 0.6 + rng.range(-0.5, 0.5);
    value = Math.max(-1, Math.min(1, value + velocity));
    curve[i] = value;
  }
  return curve;
}
