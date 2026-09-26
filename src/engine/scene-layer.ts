// Scene layers (ADR 0007): a scene placing another scene of its project.
// The shot is placed by offsets from where it would sit on its own, so the
// defaults draw it exactly as it draws alone. Its time is its own local time:
// frame f of the parent shows frame f - start + in of the shot, with no
// retiming.

import { activeOverride } from './overrides';
import { frameCount, quantizeTime, timeToFrame } from './time';
import { evaluateTracks } from './tracks';
import type { Layer, ParamSchema, Params, Scene } from './types';

/** The params a scene layer takes. Every one can have tracks and overrides. */
export const SCENE_LAYER_PARAMS: ParamSchema = {
  x: { type: 'number', default: 0, min: -100000, max: 100000, description: 'Moves the shot right by this many scene pixels.' },
  y: { type: 'number', default: 0, min: -100000, max: 100000, description: 'Moves the shot down by this many scene pixels.' },
  scale: { type: 'number', default: 1, min: 0, max: 100, description: 'Size of the shot, about its centre. 1 fills the stage.' },
  rotation: { type: 'number', default: 0, min: -36000, max: 36000, description: 'Turn of the shot about its centre, in degrees, clockwise.' },
  opacity: { type: 'number', default: 1, min: 0, max: 1, description: 'Opacity of the whole shot, 0 to 1. Keys make fades and crossfades.' },
  volume: { type: 'number', default: 1, min: 0, max: 4, description: "Loudness of the shot's sound. Keys make ducking and fades." },
  mute: { type: 'boolean', default: false, description: "Leaves the shot's sound out." },
};

/** Nesting deeper than this is refused, so a mistake can't recurse forever. */
export const MAX_SCENE_DEPTH = 4;

/** The frames of the parent a scene layer shows its shot on, and which shot frame the first one is. */
export interface SceneLayerSpan {
  /** First parent frame the shot shows on. */
  from: number;
  /** End of the shot in the parent, excluded. */
  to: number;
  /** The shot's frame at `from`. */
  in: number;
}

/**
 * Where a scene layer's shot shows in its parent. `start` is in the parent's
 * seconds, and the trim [in, out) in the shot's own; all snap to frames. A
 * missing `out` is the shot's end. The span also stops at the parent's end.
 */
export function sceneLayerSpan(layer: Layer, parent: Scene, shot: Scene): SceneLayerSpan {
  const from = timeToFrame(layer.start ?? 0, parent.fps);
  const inFrame = timeToFrame(layer.in ?? 0, parent.fps);
  // An out at the shot's end keeps a partial last frame, as leaving out does.
  const outFrame = layer.out === undefined || layer.out >= shot.duration ? frameCount(shot) : Math.min(frameCount(shot), timeToFrame(layer.out, parent.fps));
  return { from, to: Math.min(frameCount(parent), from + Math.max(0, outFrame - inFrame)), in: inFrame };
}

/** The shot's frame on parent frame `frame`, or null when the shot isn't showing. */
export function shotFrame(span: SceneLayerSpan, frame: number): number | null {
  return frame >= span.from && frame < span.to ? frame - span.from + span.in : null;
}

export interface SceneLayerPlacement {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  volume: number;
  mute: boolean;
}

/** A scene layer's placement on a parent frame: defaults < params < tracks < override params. */
export function scenePlacement(layer: Layer, parent: Scene, frame: number): SceneLayerPlacement {
  const t = quantizeTime(frame, parent.fps);
  const o = activeOverride(layer.overrides, frame);
  const merged: Params = { ...layer.params, ...evaluateTracks(layer.tracks, t), ...o?.params };
  const num = (key: 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume') => {
    const spec = SCENE_LAYER_PARAMS[key] as { default: number; min: number; max: number };
    const v = merged[key];
    const n = typeof v === 'number' && Number.isFinite(v) ? v : spec.default;
    return Math.min(spec.max, Math.max(spec.min, n));
  };
  return {
    x: num('x'),
    y: num('y'),
    scale: num('scale'),
    rotation: num('rotation'),
    opacity: num('opacity'),
    volume: num('volume'),
    mute: merged.mute === true,
  };
}

/** True when the placement draws the shot exactly where it draws alone. */
export function isIdentityPlacement(p: SceneLayerPlacement): boolean {
  return p.x === 0 && p.y === 0 && p.scale === 1 && p.rotation === 0;
}
