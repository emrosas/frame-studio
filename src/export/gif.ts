// GIF export: gifenc's LZW writer with our own palette (ticket 14, "GIF").
// Two passes over the frames. The first samples colours from up to 24 frames
// spread over the range; the second maps every frame to the palette, marks
// pixels unchanged since the previous frame as transparent, and streams each
// frame's bytes to the sink as it goes.

import { GIFEncoder } from 'gifenc';
import { readPixels, type ExportOptions, type ExportRange, type FrameSource } from './frames';
import { createColorMapper, createPaletteSampler, indexPixels, markUnchanged } from './palette';
import type { ByteSink } from './sink';
import { gifDelaysCs } from './timing';

export interface GifResult {
  frames: number;
  /** Sum of the frame delays, in centiseconds. */
  durationCs: number;
  /** Palette entries in use, not counting the transparent slot. */
  colours: number;
}

/** Palette slot for "same as the previous frame". The palette itself holds at most 255 colours. */
const UNCHANGED = 255;
/** Frames sampled for the palette. */
const SAMPLE_FRAMES = 24;

export async function exportGif(source: FrameSource, range: ExportRange, sink: ByteSink, options: ExportOptions = {}): Promise<GifResult> {
  const { width, height, fps } = source;
  const total = range.to - range.from;
  if (!(total > 0)) throw new RangeError(`nothing to export in [${range.from}, ${range.to})`);
  const delays = gifDelaysCs(total, fps);

  const sampler = createPaletteSampler();
  const step = Math.max(1, Math.ceil(total / SAMPLE_FRAMES));
  const samples = Math.ceil(total / step);
  for (let i = 0; i < total; i += step) {
    sampler.add(readPixels(source.draw(range.from + i)));
    options.onProgress?.({ done: i / step + 1, total: samples, stage: 'sampling colours' });
  }
  const palette = sampler.build({ maxColors: UNCHANGED });
  const table = [...palette];
  while (table.length < UNCHANGED) table.push([0, 0, 0]);
  table.push([255, 0, 255]); // UNCHANGED: never shown, since it is transparent

  const map = createColorMapper(palette);
  const gif = GIFEncoder({ auto: false });
  let position = 0;
  // Hands the sink a view of gifenc's buffer, then rewinds it. The sink is done
  // with the bytes once its write settles (ByteSink's contract), so no copy is needed.
  const flush = async () => {
    const bytes = gif.stream.bytesView();
    if (bytes.length > 0) await sink.write(bytes, position);
    position += bytes.length;
    gif.stream.reset();
  };

  gif.writeHeader();
  let prev = new Uint8Array(width * height);
  let cur = new Uint8Array(width * height);
  const marked = new Uint8Array(width * height);
  for (let i = 0; i < total; i++) {
    indexPixels(readPixels(source.draw(range.from + i)), map, cur);
    const first = i === 0;
    gif.writeFrame(first ? cur : markUnchanged(cur, prev, UNCHANGED, marked), width, height, {
      first,
      palette: first ? table : undefined,
      repeat: 0,
      delay: delays[i] * 10,
      transparent: !first,
      transparentIndex: UNCHANGED,
      dispose: 1,
    });
    await flush();
    [prev, cur] = [cur, prev];
    options.onProgress?.({ done: i + 1, total, stage: 'encoding' });
  }
  gif.finish();
  await flush();
  await sink.close?.();
  return { frames: total, durationCs: delays.reduce((a, b) => a + b, 0), colours: palette.length };
}
