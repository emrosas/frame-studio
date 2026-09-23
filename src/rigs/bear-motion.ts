/**
 * The bear's cycles, each a pure function of the layer time t and a seeded
 * Rng. Nothing is carried between frames: seeking to t gives the same answer
 * as playing to it.
 */
import type { Rng } from '../engine/types';
import { TAU } from './parts/math';

/** Shortest and longest automatic blink, in seconds. */
export const BLINK_MIN = 0.1;
export const BLINK_MAX = 0.2;

/**
 * Eyelid closure from the automatic blinks at time t: 1 inside a blink, 0
 * outside. `rate` is blinks per minute; 0 never blinks. The schedule is drawn
 * from `rng` from time 0 onward, a gap then a blink, over and over, so the
 * same rng and t always give the same answer. The first gap is never shorter
 * than 0.25 s, so the eyes are open at t = 0.
 */
export function blinkClosure(rng: Rng, rate: number, t: number): number {
  if (!(rate > 0) || !(t > 0)) return 0;
  const mean = 60 / rate;
  let cursor = 0;
  for (let n = 0; n < 1e6; n++) {
    const gap = n === 0 ? 0.25 + mean * rng.range(0.2, 1) : mean * rng.range(0.5, 1.35);
    const start = cursor + gap;
    const length = rng.range(BLINK_MIN, BLINK_MAX);
    if (t < start) return 0;
    if (t < start + length) return 1;
    cursor = start + length;
  }
  return 0;
}

/**
 * The breath at time t, from 0 (breathed out) to 1 (breathed in): a raised
 * cosine with a seeded period of 2.8 to 3.6 s and a seeded phase.
 */
export function breathCycle(rng: Rng, t: number): number {
  const period = rng.range(2.8, 3.6);
  const phase = rng.range(0, TAU);
  return 0.5 - 0.5 * Math.cos((TAU * t) / period + phase);
}

/** The wave at time t, from -1 to 1: `speed` waves per second from a seeded phase. */
export function waveCycle(rng: Rng, speed: number, t: number): number {
  const phase = rng.range(0, TAU);
  return Math.sin(TAU * speed * t + phase);
}
