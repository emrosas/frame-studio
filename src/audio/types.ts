import type { ParamSchema, Rng } from '../engine/types';
import type { ParamReader } from '../rigs/parts/params';
import type { CueTimes } from './timing';

/**
 * A procedural sound. Like a rig, it is code plus a param schema, and the
 * same cue, seed and params always give the same samples.
 *
 * Rules (ticket 04):
 * - Build the whole graph in schedule(). Nothing may be scheduled later.
 * - No input gets more than two connections; sum with mix().
 * - Randomness comes from `rng`, never an unseeded source.
 * - Buffers play at playbackRate 1 with loop points on whole samples.
 * - Automation that must hit a frame uses paramTime().
 */
export interface AudioGenerator {
  id: string;
  description?: string;
  params: ParamSchema;
  /** Builds the cue's sound, playing from `times.start` to `times.end` in context seconds, into `out`. */
  schedule(ctx: BaseAudioContext, out: AudioNode, times: CueTimes, params: ParamReader, rng: Rng): void;
}

export type GeneratorRegistry = ReadonlyMap<string, AudioGenerator>;
