// Editing key times by hand (ADR 0015): what the rows and lanes show, and what
// a drag, a nudge or a delete does to a layer's tracks. It edits when, not
// what. Pure, so it is unit tested without a browser. keys.ts is the keyboard.

import { timeToFrame } from '../engine/time';
import type { Key, Layer, Track } from '../engine/types';

/** One key of one track, by its place in the track. */
export interface KeyRef {
  param: string;
  index: number;
}

/** A diamond: every key of the row or lane in one frame. */
export interface KeyMark {
  /** The frame the keys are on. Negative for a key before the scene starts. */
  frame: number;
  /** Where it shows, inside [0, total]. */
  at: number;
  params: readonly string[];
  /** True when a key here is tied to a spoken word (ADR 0016). */
  anchored?: boolean;
}

/** A selected param's own row of diamonds, under its layer's row. */
export interface KeyLane {
  param: string;
  keys: readonly KeyMark[];
}

/** A selected diamond. `param` is its lane's, or null for the row's, which holds every param's key at that time. */
export interface SelectedKey {
  layerId: string;
  param: string | null;
  frame: number;
}

/** What a timeline drag holds: a diamond, a row's bar, or the two keys of a fade at a bar's end. */
export type KeyTarget = ({ kind: 'key' } & SelectedKey) | { kind: 'bar'; layerId: string } | { kind: 'edge'; layerId: string; pair: readonly [number, number] };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const EPS = 1e-9;

/** The diamonds for these tracks, in time order. */
export function keyMarks(tracks: readonly Track[] | undefined, fps: number, total: number): KeyMark[] {
  const frames = new Map<number, string[]>();
  const anchored = new Set<number>();
  for (const track of tracks ?? []) {
    for (const key of track.keys) {
      const frame = timeToFrame(key.t, fps);
      const params = frames.get(frame);
      if (!params) frames.set(frame, [track.param]);
      else if (!params.includes(track.param)) params.push(track.param);
      if (key.word !== undefined) anchored.add(frame);
    }
  }
  return [...frames].sort((a, b) => a[0] - b[0]).map(([frame, params]) => ({ frame, at: clamp(frame, 0, total), params, ...(anchored.has(frame) ? { anchored: true } : {}) }));
}

export function keyLanes(tracks: readonly Track[] | undefined, fps: number, total: number): KeyLane[] {
  return (tracks ?? []).map((track) => ({ param: track.param, keys: keyMarks([track], fps, total) }));
}

/** The keys a diamond stands for: on a lane that param's, on the row every param's. */
export function keysAt(tracks: readonly Track[] | undefined, frame: number, fps: number, param: string | null): KeyRef[] {
  return (tracks ?? []).flatMap((track) =>
    param !== null && track.param !== param
      ? []
      : track.keys.flatMap((key, index) => (timeToFrame(key.t, fps) === frame ? [{ param: track.param, index }] : [])),
  );
}

/** A frame's time, short enough to read in the file, rounded up since a time just under a frame belongs to the frame before. */
export function keyTime(frame: number, fps: number): number {
  return Math.max(0, Math.ceil((frame / fps) * 1e6 - 1e-6) / 1e6);
}

/** Each moved track's first and last moved key, for finding the neighbours that stay put. */
function movedEnds(refs: readonly KeyRef[]): Map<string, { first: number; last: number }> {
  const ends = new Map<string, { first: number; last: number }>();
  for (const { param, index } of refs) {
    const end = ends.get(param);
    ends.set(param, end ? { first: Math.min(end.first, index), last: Math.max(end.last, index) } : { first: index, last: index });
  }
  return ends;
}

/** The frames a diamond's keys can land on: inside the scene, and short of any key of the same param that isn't moving. */
export function landRange(tracks: readonly Track[], refs: readonly KeyRef[], fps: number, total: number): { min: number; max: number } {
  let min = 0;
  let max = total;
  for (const [param, { first, last }] of movedEnds(refs)) {
    const keys = tracks.find((t) => t.param === param)?.keys ?? [];
    const before = keys[first - 1];
    const after = keys[last + 1];
    if (before) min = Math.max(min, Math.floor(before.t * fps + EPS) + 1);
    if (after) max = Math.min(max, Math.ceil(after.t * fps - EPS) - 1);
  }
  return { min, max };
}

/** The tracks with `refs` landed on `frame`. Two keys of one track in that frame keep their gap. */
export function landKeys(tracks: readonly Track[], refs: readonly KeyRef[], frame: number, fps: number): Track[] {
  const ends = movedEnds(refs);
  const time = keyTime(frame, fps);
  return tracks.map((track) => {
    const end = ends.get(track.param);
    if (!end) return track;
    const from = track.keys[end.first].t;
    return { ...track, keys: track.keys.map((key, i) => (i >= end.first && i <= end.last ? { ...detached(key), t: i === end.first ? time : tidy(time + key.t - from) } : key)) };
  });
}

const tidy = (t: number) => Math.round(t * 1e6) / 1e6;

/** A key moved by hand lets go of its word, or the word would put it straight back (ADR 0016). */
function detached(key: Key): Key {
  const { word: _word, ...rest } = key;
  return rest;
}

/** `t` moved by whole frames. A key on a frame stays exactly on one. */
function shifted(t: number, frames: number, fps: number): number {
  const at = t * fps + frames;
  return at >= 0 && Math.abs(at - Math.round(at)) < 1e-3 ? keyTime(Math.round(at), fps) : tidy(t + frames / fps);
}

/** How many whole frames some keys can move together, either way. Keys already outside the scene don't hold the others back. */
export function shiftRange(tracks: readonly Track[], refs: readonly KeyRef[], fps: number, total: number): { min: number; max: number } {
  let min = -Infinity;
  let max = Infinity;
  const moved = movedEnds(refs);
  for (const { param, index } of refs) {
    const track = tracks.find((t) => t.param === param);
    const key = track?.keys[index];
    if (!track || !key) continue;
    const at = key.t * fps;
    const end = moved.get(param)!;
    if (at >= -EPS) min = Math.max(min, Math.ceil(-at - EPS));
    if (at <= total + EPS) max = Math.min(max, Math.floor(total - at + EPS));
    const before = track.keys[end.first - 1];
    const after = track.keys[end.last + 1];
    if (index === end.first && before) min = Math.max(min, Math.floor((before.t - key.t) * fps + EPS) + 1);
    if (index === end.last && after) max = Math.min(max, Math.ceil((after.t - key.t) * fps - EPS) - 1);
  }
  return { min, max };
}

export function shiftKeys(tracks: readonly Track[], refs: readonly KeyRef[], frames: number, fps: number): Track[] {
  return tracks.map((track) => {
    const moving = new Set(refs.flatMap((r) => (r.param === track.param ? [r.index] : [])));
    return moving.size === 0 ? track : { ...track, keys: track.keys.map((key, i) => (moving.has(i) ? { ...detached(key), t: shifted(key.t, frames, fps) } : key)) };
  });
}

function allKeys(tracks: readonly Track[]): KeyRef[] {
  return tracks.flatMap((track) => track.keys.map((_, index) => ({ param: track.param, index })));
}

/** How many whole frames a layer's timing can shift, keeping its keys and overrides in the scene. */
export function layerShiftRange(layer: Layer, fps: number, total: number): { min: number; max: number } {
  const tracks = layer.tracks ?? [];
  let { min, max } = shiftRange(tracks, allKeys(tracks), fps, total);
  for (const o of layer.overrides ?? []) {
    min = Math.max(min, -o.from);
    max = Math.min(max, total - o.to);
  }
  return { min, max };
}

/** The layer with all its keys and overrides `frames` later: its timing. Its mask's keys go along. */
export function shiftLayer(layer: Layer, frames: number, fps: number): Layer {
  const all = (tracks: readonly Track[]) => shiftKeys(tracks, allKeys(tracks), frames, fps);
  return {
    ...layer,
    ...(layer.tracks ? { tracks: all(layer.tracks) } : {}),
    ...(layer.overrides ? { overrides: layer.overrides.map((o) => ({ ...o, from: o.from + frames, to: o.to + frames })) } : {}),
    ...(layer.mask?.tracks ? { mask: { ...layer.mask, tracks: all(layer.mask.tracks) } } : {}),
  };
}

/** The layer after a timeline drag: `to` is a diamond's frame, or the frames a bar or a fade moved. `frame` is where a diamond landed. */
export function moveTarget(layer: Layer, target: KeyTarget, to: number, fps: number, total: number): { layer: Layer; frame: number | null } {
  const tracks = layer.tracks ?? [];
  if (target.kind === 'key') {
    const refs = keysAt(tracks, target.frame, fps, target.param);
    const { min, max } = landRange(tracks, refs, fps, total);
    if (refs.length === 0 || min > max) return { layer, frame: target.frame };
    const frame = clamp(to, min, max);
    return frame === target.frame ? { layer, frame } : { layer: { ...layer, tracks: landKeys(tracks, refs, frame, fps) }, frame };
  }
  if (target.kind === 'bar') {
    const { min, max } = layerShiftRange(layer, fps, total);
    const frames = min > max ? 0 : clamp(to, min, max);
    return { layer: frames === 0 ? layer : shiftLayer(layer, frames, fps), frame: null };
  }
  const refs = target.pair.map((index) => ({ param: 'opacity', index }));
  const { min, max } = shiftRange(tracks, refs, fps, total);
  const frames = min > max ? 0 : clamp(to, min, max);
  return { layer: frames === 0 ? layer : { ...layer, tracks: shiftKeys(tracks, refs, frames, fps) }, frame: null };
}

/** The layer with these keys tied to a spoken word, at its time (ADR 0016). */
export function anchorKeys(layer: Layer, refs: readonly KeyRef[], word: string, t: number): Layer {
  const tracks = (layer.tracks ?? []).map((track) => {
    const anchoring = new Set(refs.flatMap((r) => (r.param === track.param ? [r.index] : [])));
    if (anchoring.size === 0) return track;
    const keys = track.keys.map((key, i) => (anchoring.has(i) ? { ...key, t, word } : key));
    return { ...track, keys: [...keys].sort((a, b) => a.t - b.t) };
  });
  return { ...layer, tracks };
}

/** The layer without these keys. A track that loses its last key goes, and its value stays as the param, so the look doesn't jump. */
export function deleteKeys(layer: Layer, refs: readonly KeyRef[]): Layer {
  const params = { ...layer.params };
  const tracks = (layer.tracks ?? []).flatMap((track) => {
    const gone = new Set(refs.flatMap((r) => (r.param === track.param ? [r.index] : [])));
    const keys = track.keys.filter((_, i) => !gone.has(i));
    if (keys.length > 0) return [{ ...track, keys }];
    params[track.param] = track.keys[track.keys.length - 1].v;
    return [];
  });
  const { tracks: _tracks, params: _params, ...rest } = layer;
  return { ...rest, ...(Object.keys(params).length > 0 ? { params } : {}), ...(tracks.length > 0 ? { tracks } : {}) };
}
