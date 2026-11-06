// What the timeline dock works out: the clock's text, the ruler's ticks, where
// a dragged clip lands, and what a drag on a row snaps to. Pure, so it is unit
// tested without a browser.

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
