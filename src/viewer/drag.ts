// Dragging a layer on the canvas (ADR 0015): how far a pointer's move takes a
// layer's x and y, and what a drag writes. Pure, so it is unit tested without a
// browser. The preview is a patched copy of the scene through the normal
// render, so the engine never hears about a drag.

import { cameraView, defaultParams, quantizeTime, resolveLayer, SCENE_LAYER_PARAMS, scenePlacement, stageSize, timeToFrame } from '../engine';
import { BACKGROUND_ID, type Layer, type ParamSpec, type RigRegistry, type Scene, type Track, type World } from '../engine/types';
import { spanLabel, type FrameRange } from './selection';

export interface Position {
  x: number;
  y: number;
}

/** How a param's units show on screen. */
export interface DragScale {
  /** CSS pixels per output pixel. */
  fit: number;
  /** Output pixels per stage pixel. */
  pixel: number;
  /** The camera's zoom on this layer, after its depth. */
  zoom: number;
  /** A pixel stage, where a layer lands on whole pixels. */
  whole: boolean;
}

export function dragScale(scene: Scene, layer: Layer, frame: number, cssWidth: number): DragScale {
  return {
    fit: cssWidth / scene.size[0],
    pixel: scene.pixel?.scale ?? 1,
    zoom: cameraView(scene, layer, frame)?.zoom ?? 1,
    whole: scene.pixel !== undefined,
  };
}

/** Params per CSS pixel. */
const unit = (scale: DragScale) => 1 / (scale.fit * scale.pixel * (scale.zoom || 1));

/** A pointer's move in CSS pixels as a change to x and y. */
export function dragDelta(dx: number, dy: number, scale: DragScale): Position {
  return { x: dx * unit(scale), y: dy * unit(scale) };
}

/** Shift keeps the drag on the axis it has gone further along. */
export function lockAxis(dx: number, dy: number): Position {
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
}

/** Whole pixels on a pixel stage; elsewhere two decimals, so the file stays readable. */
export function landValue(value: number, scale: DragScale): number {
  return scale.whole ? Math.round(value) : Math.round(value * 100) / 100;
}

/** The x and y that put a layer on the stage's centre lines: a rig's x and y are its place on the stage, a clip's an offset from where it sits. */
export function stageCentre(scene: Scene, layer: Layer, frame: number): Position {
  if (layer.scene !== undefined || layer.file !== undefined) return { x: 0, y: 0 };
  const [width, height] = stageSize(scene);
  const view = cameraView(scene, layer, frame);
  return { x: width / 2 + (view?.x ?? 0), y: height / 2 + (view?.y ?? 0) };
}

/** `value` pulled to `centre` within `px` CSS pixels. */
export function snapCentre(value: number, centre: number, scale: DragScale, px = 6): { value: number; snapped: boolean } {
  return Math.abs(value - centre) <= px * unit(scale) ? { value: centre, snapped: true } : { value, snapped: false };
}

/** Where a layer can move, and what its params allow. */
export interface Movable extends Position {
  bounds: { x: ParamSpec; y: ParamSpec };
}

/** The layer's x and y on this frame, or null when its rig has no numeric x and y. */
export function movable(layer: Layer, scene: Scene, frame: number, registry: RigRegistry, world: World): Movable | null {
  if (layer.scene !== undefined || layer.file !== undefined) {
    const { x, y } = scenePlacement(layer, scene, frame);
    return { x, y, bounds: { x: SCENE_LAYER_PARAMS.x, y: SCENE_LAYER_PARAMS.y } };
  }
  const { rig, params } = resolveLayer(layer, scene, frame, registry, world);
  const { x, y } = rig.params;
  const at = { ...defaultParams(rig), ...params };
  if (x?.type !== 'number' || y?.type !== 'number' || typeof at.x !== 'number' || typeof at.y !== 'number') return null;
  return { x: at.x, y: at.y, bounds: { x, y } };
}

export function withinBounds(value: number, spec: ParamSpec): number {
  if (spec.type !== 'number') return value;
  return Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, value));
}

/** The frame a drag lands on. */
export interface DragMoment {
  frame: number;
  fps: number;
  /** The selected range. An override is written only when the frame is inside it. */
  range: FrameRange | null;
}

export type PositionWrite = { ok: true; layer: Layer } | { ok: false; error: string };

/** The tracks with a key at the time, updated in its frame or inserted with the ease of the key before it. */
function withKey(tracks: readonly Track[], param: string, t: number, v: number, fps: number): Track[] {
  return tracks.map((track) => {
    if (track.param !== param) return track;
    const frame = timeToFrame(t, fps);
    const same = track.keys.findIndex((key) => timeToFrame(key.t, fps) === frame);
    if (same >= 0) return { ...track, keys: track.keys.map((key, i) => (i === same ? { ...key, v } : key)) };
    const at = track.keys.findIndex((key) => key.t > t);
    const end = at < 0 ? track.keys.length : at;
    const ease = track.keys[end - 1]?.ease;
    return { ...track, keys: [...track.keys.slice(0, end), { t, v, ...(ease !== undefined ? { ease } : {}) }, ...track.keys.slice(end)] };
  });
}

/**
 * The layer with its position set at a moment, the rule from ADR 0015. A range around the frame: an override on
 * that range. Otherwise each axis by itself: an override already setting it on this frame, which outranks the
 * rest; a key at the playhead if it has a track; else its param. An axis `from` says didn't move stays as it is.
 */
export function writePosition(layer: Layer, to: Position, from: Position, moment: DragMoment): PositionWrite {
  const { frame, fps, range } = moment;
  if (range && frame >= range.from && frame < range.to) {
    const overrides = layer.overrides ?? [];
    const exact = overrides.find((o) => o.from === range.from && o.to === range.to);
    if (!exact && overrides.some((o) => o.from < range.to && o.to > range.from)) {
      return { ok: false, error: `"${layer.id}" has an override crossing ${spanLabel(range, fps)}. Set the range to match it, or clear the range.` };
    }
    const position = { x: to.x, y: to.y };
    const next = exact ? overrides.map((o) => (o === exact ? { ...o, params: { ...o.params, ...position } } : o)) : [...overrides, { ...range, params: position }];
    return { ok: true, layer: { ...layer, overrides: [...next].sort((a, b) => a.from - b.from) } };
  }
  let next = layer;
  for (const axis of ['x', 'y'] as const) {
    if (to[axis] === from[axis]) continue;
    const value = to[axis];
    const active = next.overrides?.find((o) => frame >= o.from && frame < o.to && o.params?.[axis] !== undefined);
    if (active) next = { ...next, overrides: next.overrides!.map((o) => (o === active ? { ...o, params: { ...o.params, [axis]: value } } : o)) };
    else if (next.tracks?.some((t) => t.param === axis)) next = { ...next, tracks: withKey(next.tracks, axis, quantizeTime(frame, fps, next.stepFps), value, fps) };
    else next = { ...next, params: { ...next.params, [axis]: value } };
  }
  return { ok: true, layer: next };
}

/** The scene with these layers in place of its own, for showing an edit before its file arrives. */
export function withLayers(scene: Scene, layers: ReadonlyMap<string, Layer>): Scene {
  const background = layers.get(BACKGROUND_ID);
  const { id: _id, ...spec } = background ?? { id: '' };
  return {
    ...scene,
    ...(background ? { background: spec } : {}),
    layers: scene.layers.map((layer) => layers.get(layer.id) ?? layer),
  };
}
