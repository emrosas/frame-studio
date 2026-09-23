import { ease } from './easing';
import type { Params, ParamValue, Track } from './types';

/**
 * Value of a track at time t (seconds). Keys are sorted by t, strictly
 * increasing (validateScene enforces this). Numbers interpolate with the
 * easing of the key being arrived at; anything else steps.
 */
export function evaluateTrack(track: Track, t: number): ParamValue {
  const keys = track.keys;
  const n = keys.length;
  if (n === 0) throw new Error(`track "${track.param}" has no keys`);
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;

  // Binary search for the last key with key.t <= t. Invariant: keys[lo].t <= t < keys[hi].t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  if (typeof a.v === 'number' && typeof b.v === 'number') {
    return a.v + (b.v - a.v) * ease(b.ease, (t - a.t) / (b.t - a.t));
  }
  return a.v;
}

export function evaluateTracks(tracks: readonly Track[] | undefined, t: number): Params {
  const out: Params = {};
  if (!tracks) return out;
  for (const track of tracks) out[track.param] = evaluateTrack(track, t);
  return out;
}
