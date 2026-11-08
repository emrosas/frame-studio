// What the timeline dock works out: the clock's text, the ruler's ticks, where
// a dragged clip lands, what a drag on a row snaps to, and when a layer is on
// screen. Pure, so it is unit tested without a browser.

import { quantizeTime } from '../engine/time';
import { evaluateTrack } from '../engine/tracks';
import type { Key, Layer } from '../engine/types';

/** A frame as a clock reads it, "0:01.00": minutes, seconds, hundredths. MM:SS:FF stays in the engine's timecode. */
export function formatClock(frame: number, fps: number): string {
  const hundredths = Math.floor((frame * 100) / fps + 1e-9);
  const minutes = Math.floor(hundredths / 6000);
  const seconds = Math.floor(hundredths / 100) % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}

export interface RulerTick {
  t: number;
  /** Set on labelled ticks. */
  label: string | null;
}

/** Seconds between labels, smallest first. */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
/** Labels stay at least this far apart. */
const MIN_LABEL_PX = 72;
const MIN_TICK_PX = 7;

function tickLabel(t: number, step: number): string {
  const minutes = Math.floor(t / 60);
  const seconds = t - minutes * 60;
  const whole = String(Math.floor(seconds)).padStart(2, '0');
  return step < 1 ? `${minutes}:${whole}.${String(Math.round((seconds % 1) * 100)).padStart(2, '0')}` : `${minutes}:${whole}`;
}

/** The ticks for `seconds` of timeline shown across `width` pixels: labels as often as they fit, unlabelled ticks between. */
export function rulerTicks(seconds: number, width: number): RulerTick[] {
  if (!(seconds > 0) || !(width > 0)) return [];
  const pxPerSecond = width / seconds;
  const step = STEPS.find((s) => s * pxPerSecond >= MIN_LABEL_PX) ?? STEPS[STEPS.length - 1];
  const fifth = step / 5;
  const between = fifth * pxPerSecond >= MIN_TICK_PX ? 5 : step / 2 >= 0.1 && (step / 2) * pxPerSecond >= MIN_TICK_PX ? 2 : 1;
  const ticks: RulerTick[] = [];
  const count = Math.floor(seconds / (step / between) + 1e-9);
  for (let i = 0; i <= count; i++) {
    const t = Math.round(((i * step) / between) * 1000) / 1000;
    if (t < seconds) ticks.push({ t, label: i % between === 0 ? tickLabel(t, step) : null });
  }
  return ticks;
}

/** Where a clip sits, in frames: `from` in the composition, [in, out) of what it places, which is `length` frames long. */
export interface ClipPlace {
  from: number;
  in: number;
  out: number;
  length: number;
}

/** Which part of a band a drag holds. */
export type ClipHandle = 'move' | 'start' | 'end';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** The clip after dragging `handle` by `delta` frames, in a composition of `total` frames. It keeps at least one frame. */
export function dragClip(clip: ClipPlace, handle: ClipHandle, delta: number, total: number): ClipPlace {
  if (handle === 'move') return { ...clip, from: clamp(clip.from + delta, 0, Math.max(0, total - 1)) };
  if (handle === 'start') {
    const d = clamp(delta, Math.max(-clip.in, -clip.from), clip.out - clip.in - 1);
    return { ...clip, from: clip.from + d, in: clip.in + d };
  }
  return { ...clip, out: clamp(clip.out + delta, clip.in + 1, clip.length) };
}

/** The frames of a clip's own edges that a drag of `handle` carries. */
export function clipEdges(clip: ClipPlace, handle: ClipHandle): number[] {
  const end = clip.from + clip.out - clip.in;
  return handle === 'start' ? [clip.from] : handle === 'end' ? [end] : [clip.from, end];
}

/** Where a sound cue sits: frames on the timeline, and seconds into the file and of each fade. */
export interface CuePlace {
  from: number;
  to: number;
  in: number;
  fadeIn: number;
  fadeOut: number;
  /** The file's length in seconds, where it has one and it's known. A generator has none. */
  length: number | null;
  /** Plays a file, so a trim at the start moves `in`. */
  file: boolean;
}

/** The cue after dragging `handle` by `delta` frames, in a timeline of `total`. It keeps at least one frame. */
export function dragCue(cue: CuePlace, handle: ClipHandle, delta: number, total: number, fps: number): CuePlace {
  const span = cue.to - cue.from;
  if (handle === 'move') {
    const d = clamp(delta, -cue.from, Math.max(-cue.from, total - cue.to));
    return { ...cue, from: cue.from + d, to: cue.to + d };
  }
  if (handle === 'start') {
    const earliest = cue.file ? Math.max(-cue.from, -Math.floor(cue.in * fps + 1e-9)) : -cue.from;
    const d = clamp(delta, earliest, span - 1);
    return { ...cue, from: cue.from + d, in: cue.file ? Math.max(0, cue.in + d / fps) : cue.in };
  }
  // A cue already past the end of its file stays where it is until it's trimmed.
  const last = cue.length === null ? total : Math.max(cue.to, Math.min(total, cue.from + Math.ceil((cue.length - cue.in) * fps - 1e-9)));
  return { ...cue, to: clamp(cue.to + delta, cue.from + 1, last) };
}

/** The cue with a fade's handle at `frame`. The two fades share the cue and never cross. */
export function dragFade(cue: CuePlace, side: 'in' | 'out', frame: number, fps: number): CuePlace {
  const length = (cue.to - cue.from) / fps;
  if (side === 'in') return { ...cue, fadeIn: clamp((frame - cue.from) / fps, 0, Math.max(0, length - cue.fadeOut)) };
  return { ...cue, fadeOut: clamp((cue.to - frame) / fps, 0, Math.max(0, length - cue.fadeIn)) };
}

/** A clip as a transition sees it: its place and its order, `order` rising up the stack. */
export interface StackedClip extends ClipPlace {
  id: string;
  order: number;
}

/**
 * The clip a transition onto `clip` should run on under, and where its trim then ends, in frames: one that
 * ends where `clip` starts, beneath it, with more of itself to show. A cut has nothing under it otherwise.
 */
export function clipUnder(clips: readonly StackedClip[], clip: StackedClip, frames: number): { id: string; out: number } | null {
  const before = clips.filter((c) => c.id !== clip.id && c.order < clip.order && c.from + c.out - c.in === clip.from);
  const under = before.sort((a, b) => b.order - a.order).find((c) => c.out < c.length);
  return under ? { id: under.id, out: Math.min(under.length, under.out + frames) } : null;
}

/** The clip a transition onto `clip` ran on underneath, by `frames`, and the end it had before. */
export function clipRunOn(clips: readonly StackedClip[], clip: StackedClip, frames: number): { id: string; out: number } | null {
  const under = clips.find((c) => c.id !== clip.id && c.order < clip.order && c.from + c.out - c.in === clip.from + frames);
  return under ? { id: under.id, out: under.out - frames } : null;
}

/** How close, in CSS pixels, a dragged edge must come to a target to land on it. */
export const SNAP_PX = 6;

/** The frame boundary nearest `frame` among `targets` within SNAP_PX, else `frame`. */
export function snapFrame(frame: number, targets: readonly number[], pxPerFrame: number, tolerance = SNAP_PX): number {
  let best = frame;
  let gap = pxPerFrame > 0 ? tolerance / pxPerFrame : 0;
  for (const target of targets) {
    const d = Math.abs(target - frame);
    if (d <= gap) {
      gap = d;
      best = target;
    }
  }
  return best;
}

/** The range between two boundaries a drag touched, in either order, at least one frame long and inside the scene. */
export function dragSpan(a: number, b: number, total: number): { from: number; to: number } {
  const from = clamp(Math.min(a, b), 0, Math.max(0, total - 1));
  return { from, to: clamp(Math.max(a, b), from + 1, Math.max(from + 1, total)) };
}

/** Whether a line of text fits a width. Labels that don't fit hide: a clipped "b.." says nothing. */
export function labelFits(text: string, px: number): boolean {
  return px >= text.length * 6.5 + 12;
}

/**
 * Which markers show their label, in marker order. Sync points (labels ending
 * in !) are placed first and plain markers take the room left, so a bare tick
 * is never the one a check depends on.
 */
export function markerLabels(markers: { frame: number; label: string }[], total: number, px: (from: number, to: number) => number): boolean[] {
  const shown = markers.map(() => false);
  const isSync = (i: number) => markers[i].label.endsWith('!');
  const nextShown = (i: number, only: (j: number) => boolean) => {
    for (let j = i + 1; j < markers.length; j++) if (only(j)) return markers[j].frame;
    return total;
  };
  markers.forEach((m, i) => {
    if (isSync(i)) shown[i] = labelFits(m.label, px(m.frame, nextShown(i, isSync)));
  });
  let last = -1;
  markers.forEach((m, i) => {
    if (!isSync(i)) {
      const roomBefore = last < 0 || labelFits(markers[last].label, px(markers[last].frame, m.frame));
      shown[i] = roomBefore && labelFits(m.label, px(m.frame, nextShown(i, (j) => shown[j])));
    }
    if (shown[i]) last = i;
  });
  return shown;
}

/** Keeps `delta`, unless it would land one of `edges` on a target within SNAP_PX: then the nearest such landing. */
export function snapDelta(edges: readonly number[], delta: number, targets: readonly number[], pxPerFrame: number): number {
  let best = delta;
  let gap = Infinity;
  for (const edge of edges) {
    const at = edge + delta;
    const landed = snapFrame(at, targets, pxPerFrame);
    if (landed !== at && Math.abs(landed - at) < gap) {
      gap = Math.abs(landed - at);
      best = landed - edge;
    }
  }
  return best;
}

/** Part of a row's bar: where a layer shows. `start` and `end` are the indices of the fade's two keys on the opacity track, where the bar's end has one. */
export interface VisibleSpan {
  from: number;
  to: number;
  start?: readonly [number, number];
  end?: readonly [number, number];
}

const opacityOf = (key: Key | undefined) => (key && typeof key.v === 'number' ? key.v : 0);

/** The two keys of the fade that lands on `frame`, the first of which is at or above zero as `rising` says, or undefined. */
function fadeAt(keys: readonly Key[], frame: number, fps: number, rising: boolean): readonly [number, number] | undefined {
  let last = -1;
  keys.forEach((key, i) => {
    if (key.t * fps <= frame + 1e-9) last = i;
  });
  const isFade = (i: number) => i >= 0 && i + 1 < keys.length && opacityOf(keys[i]) > 0 !== rising && opacityOf(keys[i + 1]) > 0 === rising;
  if (isFade(last)) return [last, last + 1];
  return isFade(last - 1) ? [last - 1, last] : undefined;
}

/** The frames a layer is on screen, from its opacity track and the engine's evaluation of it. None without a track: the row then shows no fades. */
export function visibleSpans(layer: Pick<Layer, 'tracks' | 'stepFps'>, fps: number, total: number): VisibleSpan[] {
  const track = layer.tracks?.find((t) => t.param === 'opacity');
  if (!track || track.keys.length === 0) return [];
  const spans: VisibleSpan[] = [];
  let open = -1;
  for (let frame = 0; frame <= total; frame++) {
    const on = frame < total && Number(evaluateTrack(track, quantizeTime(frame, fps, layer.stepFps))) > 0;
    if (on && open < 0) open = frame;
    if (!on && open >= 0) {
      spans.push({ from: open, to: frame });
      open = -1;
    }
  }
  return spans.map((span) => {
    const start = span.from > 0 ? fadeAt(track.keys, span.from, fps, true) : undefined;
    const end = span.to < total ? fadeAt(track.keys, span.to, fps, false) : undefined;
    return { ...span, ...(start ? { start } : {}), ...(end ? { end } : {}) };
  });
}
