// Contact sheet: a grid of every Nth frame in one image, for reviewing motion
// at a glance. The layout is pure; drawing it lives with the render page.

/** Frames from, from + every, ... below to. Without every, a step that gives about 24 frames. */
export function contactSheetFrames(from: number, to: number, every?: number): number[] {
  if (!(Number.isInteger(from) && Number.isInteger(to) && from < to)) {
    throw new RangeError(`contact sheet range must be integer frames with from < to, got [${from}, ${to})`);
  }
  const step = every ?? Math.max(1, Math.ceil((to - from) / 24));
  if (!Number.isInteger(step) || step < 1) throw new RangeError(`every must be a whole number of frames, 1 or more, got ${step}`);
  const frames: number[] = [];
  for (let f = from; f < to; f += step) frames.push(f);
  return frames;
}

/** Largest side we draw. Chromium allows 32767 px a side but only 16384 x 16384 px in total, so stay under both. */
const MAX_SIDE = 16384;

export interface ContactSheetLayout {
  columns: number;
  rows: number;
  thumbWidth: number;
  thumbHeight: number;
  /** Height of the text strip under each thumbnail. */
  labelHeight: number;
  /** thumbHeight + labelHeight. */
  cellHeight: number;
  gap: number;
  width: number;
  height: number;
  /** Top-left corner of cell i, filled row by row. */
  cell(i: number): { x: number; y: number };
}

export function contactSheetLayout(options: {
  count: number;
  frameWidth: number;
  frameHeight: number;
  columns?: number;
  thumbWidth?: number;
}): ContactSheetLayout {
  const { count, frameWidth, frameHeight, thumbWidth = 480 } = options;
  const columns = options.columns ?? Math.min(8, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const thumbHeight = Math.round((thumbWidth * frameHeight) / frameWidth);
  const labelHeight = 24;
  const gap = 8;
  const cellHeight = thumbHeight + labelHeight;
  const width = gap + columns * (thumbWidth + gap);
  const height = gap + rows * (cellHeight + gap);
  if (width > MAX_SIDE) {
    throw new RangeError(`a contact sheet ${columns} columns wide is ${width} px, over the ${MAX_SIDE} px a canvas can hold; use fewer --columns`);
  }
  if (height > MAX_SIDE) {
    throw new RangeError(
      `${count} frames make a contact sheet ${height} px tall, over the ${MAX_SIDE} px a canvas can hold; raise --every to show fewer frames`,
    );
  }
  return {
    columns,
    rows,
    thumbWidth,
    thumbHeight,
    labelHeight,
    cellHeight,
    gap,
    width,
    height,
    cell: (i) => ({ x: gap + (i % columns) * (thumbWidth + gap), y: gap + Math.floor(i / columns) * (cellHeight + gap) }),
  };
}
