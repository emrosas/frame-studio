// Audio time from the scene's frame math (ticket 04, "Recommendation for M7").
// Audio renders at 48 kHz, and scenes with audio have an fps that divides
// 48000, so every frame starts on a whole sample and audio and video agree.

import { frameCount, timeToFrame } from '../engine/time';
import type { AudioCue, Scene } from '../engine/types';

export const SAMPLE_RATE = 48000;

/** Samples per frame at `fps`. The validator guarantees a whole number for scenes with audio. */
export function samplesPerFrame(fps: number): number {
  return SAMPLE_RATE / fps;
}

/** The scene's length in samples: its frame count times samples per frame. */
export function sceneSamples(scene: Pick<Scene, 'fps' | 'duration'>): number {
  return frameCount(scene) * samplesPerFrame(scene.fps);
}

/** Context time of sample n, for start() and stop(). */
export function sourceTime(n: number): number {
  return n / SAMPLE_RATE;
}

/**
 * Context time for automation that must take effect on sample n. Half a
 * sample early, because a plain time lands one sample late about 6% of the
 * time at 25, 30 and 60 fps (ticket 04).
 */
export function paramTime(n: number): number {
  return Math.max(0, (n - 0.5) / SAMPLE_RATE);
}

/** A cue's span, snapped to the frames it starts and ends on, in samples and context seconds. */
export interface CueTimes {
  startSample: number;
  endSample: number;
  /** sourceTime(startSample). */
  start: number;
  /** sourceTime(endSample). */
  end: number;
  fps: number;
}

export function cueTimes(cue: Pick<AudioCue, 'start' | 'end'>, fps: number): CueTimes {
  const spf = samplesPerFrame(fps);
  const startSample = timeToFrame(cue.start, fps) * spf;
  const endSample = Math.max(startSample + spf, timeToFrame(cue.end, fps) * spf);
  return { startSample, endSample, start: sourceTime(startSample), end: sourceTime(endSample), fps };
}

/** The sample a time inside a cue lands on, snapped to its frame, e.g. for repeated blips. */
export function frameSample(t: number, fps: number): number {
  return timeToFrame(t, fps) * samplesPerFrame(fps);
}
