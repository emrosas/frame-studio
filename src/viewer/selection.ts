// Selection logic for the viewer: the frame range (I and O, typed from and
// to), click cycling, labels, and reading a selection back from the URL.
// Pure, so it is unit tested without a browser.

import { formatTimecode, parseTimecode, sceneLayers } from '../engine';
import type { RigRegistry, Scene } from '../engine/types';
import { clampFrame } from './clock';

/** A frame range [from, to): from is included, to is not. */
export interface FrameRange {
  from: number;
  to: number;
}

/** Separates layer and part in labels: "bear › nose". */
export const CHEVRON = '›';

/**
 * I: the in point goes to `frame`. Without a range the out point is the end
 * of the scene. In past the out point moves out to in + 1.
 */
export function markIn(range: FrameRange | null, frame: number, frameCount: number): FrameRange {
  const from = clampFrame(frame, frameCount);
  if (!range) return { from, to: frameCount };
  if (from >= range.to) return { from, to: from + 1 };
  return { from, to: range.to };
}

/**
 * O: the out point goes to `frame`, stored exclusive as to = frame + 1, so
 * the range includes the frame on screen. Without a range the in point is 0.
 * Out before the in point moves in to out - 1.
 */
export function markOut(range: FrameRange | null, frame: number, frameCount: number): FrameRange {
  const to = clampFrame(frame, frameCount) + 1;
  if (!range) return { from: 0, to };
  if (to <= range.from) return { from: to - 1, to };
  return { from: range.from, to };
}

/** Why [from, to) is not a valid range for a scene of frameCount frames, or null when it is. */
export function rangeError(from: unknown, to: unknown, frameCount: number): string | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return `from and to must be integer frames, got ${String(from)} and ${String(to)}`;
  }
  const f = from as number;
  const t = to as number;
  if (f < 0 || f > frameCount - 1) return `from must be a frame from 0 to ${frameCount - 1}, got ${f}`;
  if (t < 1 || t > frameCount) return `to must be from 1 to ${frameCount} (to is exclusive), got ${t}`;
  if (f >= t) return `from (${f}) must be before to (${t}); to is exclusive, so [${f}, ${f + 1}) is one frame`;
  return null;
}

export type FrameParse = { ok: true; frame: number } | { ok: false; error: string };

/** A frame number ("41") or an MM:SS:FF timecode ("00:03:05") at the scene fps. */
export function parseFrameText(text: string, fps: number): FrameParse {
  const t = text.trim();
  if (/^\d+$/.test(t)) return { ok: true, frame: Number(t) };
  if (t.includes(':')) {
    try {
      return { ok: true, frame: parseTimecode(t, fps) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, error: `enter a frame number or a timecode like 00:01:06, got ${JSON.stringify(t)}` };
}

export type RangeEdit = { ok: true; range: FrameRange } | { ok: false; error: string };

/**
 * A typed value for one end of the range. Without a range the other end is
 * the whole scene. An empty field means that end of the scene (0 or
 * frameCount). Any problem is an error and changes nothing.
 */
export function editRangeEnd(range: FrameRange | null, end: 'from' | 'to', text: string, fps: number, frameCount: number): RangeEdit {
  const empty = text.trim() === '';
  const parsed: FrameParse = empty ? { ok: true, frame: end === 'from' ? 0 : frameCount } : parseFrameText(text, fps);
  if (!parsed.ok) return parsed;
  const base = range ?? { from: 0, to: frameCount };
  const next = end === 'from' ? { from: parsed.frame, to: base.to } : { from: base.from, to: parsed.frame };
  const error = rangeError(next.from, next.to, frameCount);
  return error ? { ok: false, error } : { ok: true, range: next };
}

export interface RangeText {
  /** "[12, 36)" or "all frames". */
  interval: string;
  /** "00:01:00 – 00:03:00", empty without a range. */
  timecodes: string;
  /** "24 frames". */
  count: string;
}

export function describeRange(range: FrameRange | null, fps: number, frameCount: number): RangeText {
  const plural = (n: number) => `${n} frame${n === 1 ? '' : 's'}`;
  if (!range) return { interval: 'all frames', timecodes: '', count: plural(frameCount) };
  return {
    interval: `[${range.from}, ${range.to})`,
    timecodes: `${formatTimecode(range.from, fps)} – ${formatTimecode(range.to, fps)}`,
    count: plural(range.to - range.from),
  };
}

export function layerLabel(layerId: string | null, partId: string | null | undefined): string {
  if (!layerId) return '';
  return partId ? `${layerId} ${CHEVRON} ${partId}` : layerId;
}

// ---- click cycling ----

export interface ClickSpot {
  /** Scene key plus version: a hot edit between clicks starts over. */
  scene: string;
  frame: number;
  /** Client position in CSS pixels. */
  x: number;
  y: number;
}

export interface ClickMemo extends ClickSpot {
  /** The layer this click sequence selected last. */
  layerId: string | null;
}

/**
 * A click cycles when it lands within `tolerance` CSS px of the click that
 * started the sequence, on the same frame and scene version, and the layer
 * that sequence picked is still the selection.
 */
export function isRepeatClick(prev: ClickMemo | null, click: ClickSpot, selectedLayer: string | null, tolerance = 4): boolean {
  if (!prev || prev.layerId === null || prev.layerId !== selectedLayer) return false;
  if (prev.scene !== click.scene || prev.frame !== click.frame) return false;
  return Math.hypot(click.x - prev.x, click.y - prev.y) <= tolerance;
}

/** The candidate after `current` (top first), wrapping to the top. The top one when current is not a candidate. */
export function nextCandidate(ids: readonly string[], current: string | null): string | null {
  if (ids.length === 0) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  return ids[(i + 1) % ids.length];
}

// ---- URL ----

/** Raw ?layer=&part=&from=&to= values. */
export interface SelectionParams {
  layer: string | null;
  part: string | null;
  from: string | null;
  to: string | null;
}

/** What a selection is checked against: each layer id with the parts its rigs declare. */
export interface SceneShape {
  fps: number;
  frameCount: number;
  layers: ReadonlyMap<string, readonly string[]>;
}

/**
 * Layer ids in draw order, each with the parts declared by its rig and by any
 * rig its overrides swap in (a variant may add parts to its base's).
 */
export function sceneShape(scene: Scene, registry: RigRegistry, frameCount: number): SceneShape {
  const layers = new Map<string, readonly string[]>();
  for (const layer of sceneLayers(scene)) {
    const rigIds = [layer.rig, ...(layer.overrides ?? []).flatMap((o) => (o.rig ? [o.rig] : []))];
    const parts = new Set<string>();
    for (const id of rigIds) for (const part of registry.get(id)?.parts ?? []) parts.add(part);
    layers.set(layer.id, [...parts]);
  }
  return { fps: scene.fps, frameCount, layers };
}

export interface ResolvedSelection {
  layerId: string | null;
  partId: string | null;
  range: FrameRange | null;
  /** One line per value that was dropped, for the console. */
  ignored: string[];
}

/**
 * Checks URL selection values against a scene and drops the bad ones: an
 * unknown layer (and its part), a part the layer's rigs do not declare, and a
 * range that does not fit the scene. A missing range end is the scene's own.
 */
export function resolveSelectionParams(params: SelectionParams, shape: SceneShape): ResolvedSelection {
  const ignored: string[] = [];
  let layerId: string | null = null;
  let partId: string | null = null;
  if (params.layer !== null) {
    if (shape.layers.has(params.layer)) layerId = params.layer;
    else ignored.push(`layer=${params.layer}: no such layer`);
  }
  if (params.part !== null) {
    if (layerId === null) ignored.push(`part=${params.part}: no valid layer`);
    else if (shape.layers.get(layerId)?.includes(params.part)) partId = params.part;
    else ignored.push(`part=${params.part}: layer "${layerId}" has no such part`);
  }
  let range: FrameRange | null = null;
  if (params.from !== null || params.to !== null) {
    const from = params.from === null ? { ok: true as const, frame: 0 } : parseFrameText(params.from, shape.fps);
    const to = params.to === null ? { ok: true as const, frame: shape.frameCount } : parseFrameText(params.to, shape.fps);
    const error = !from.ok ? from.error : !to.ok ? to.error : rangeError(from.frame, to.frame, shape.frameCount);
    if (error === null && from.ok && to.ok) range = { from: from.frame, to: to.frame };
    else ignored.push(`from=${params.from ?? ''}&to=${params.to ?? ''}: ${error}`);
  }
  return { layerId, partId, range, ignored };
}
