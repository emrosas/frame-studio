// Audio cues' volume (ADR 0007). A cue's generator params are fixed for the
// cue, but its loudness can have keys, like a layer's params, so a music bed
// can duck under a shot and fade out. Keys are in scene seconds.

import { quantizeTime } from './time';
import { evaluateTracks } from './tracks';
import type { AudioCue, ParamSchema } from './types';

/** What a cue's tracks can animate. */
export const CUE_PARAMS: ParamSchema = {
  volume: { type: 'number', default: 1, min: 0, max: 4, description: "Loudness of the cue's sound, 1 as the generator makes it. Keys make ducks and fades." },
};

/** The cue's volume on a frame of its scene, clamped to 0 to 4. */
export function cueVolume(cue: Pick<AudioCue, 'tracks'>, fps: number, frame: number): number {
  const v = evaluateTracks(cue.tracks, quantizeTime(frame, fps)).volume;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(4, Math.max(0, v)) : 1;
}
