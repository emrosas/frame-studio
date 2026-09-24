// exportGif against a real raster. @napi-rs/canvas (Skia) stands in for the
// browser canvas; runtime code never imports it.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { FrameCanvas, FrameSource } from './frames';
import { exportGif } from './gif';
import { memorySink } from './sink';
import { readGifStructure } from './testing/gif-structure';

/** A 40x30 source: an orange ground with a white square that moves 4 px a frame, holding still on frames 3 and 4. */
function movingSquare(fps = 12): FrameSource & { drawn: number[] } {
  const canvas = createCanvas(40, 30);
  const ctx = canvas.getContext('2d');
  const drawn: number[] = [];
  return {
    width: 40,
    height: 30,
    fps,
    drawn,
    draw(frame) {
      drawn.push(frame);
      ctx.fillStyle = '#ffa200';
      ctx.fillRect(0, 0, 40, 30);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.min(frame, 3) * 4, 10, 8, 8);
      return canvas as unknown as FrameCanvas;
    },
  };
}

describe('exportGif', () => {
  it('writes one frame per scene frame, looping forever, with delays that add up to the duration', async () => {
    const sink = memorySink();
    const result = await exportGif(movingSquare(), { from: 0, to: 12 }, sink);
    const gif = readGifStructure(sink.bytes());
    expect(gif).toMatchObject({ width: 40, height: 30, globalTableSize: 256, loops: 0 });
    expect(gif.frames).toHaveLength(12);
    expect(gif.frames.reduce((n, f) => n + f.delayCs, 0)).toBe(100);
    expect(result).toEqual({ frames: 12, durationCs: 100, colours: 2 });
  });

  it('keeps each frame under the next and marks unchanged pixels transparent after the first', async () => {
    const sink = memorySink();
    await exportGif(movingSquare(), { from: 0, to: 6 }, sink);
    const { frames } = readGifStructure(sink.bytes());
    expect(frames[0]).toMatchObject({ transparentIndex: null, disposal: 1, localTable: false });
    for (const f of frames.slice(1)) expect(f).toMatchObject({ transparentIndex: 255, disposal: 1, localTable: false });
    for (const f of frames) expect(f).toMatchObject({ left: 0, top: 0, width: 40, height: 30 });
  });

  it('exports a range, numbering delays from its start', async () => {
    const source = movingSquare(24);
    const sink = memorySink();
    const result = await exportGif(source, { from: 5, to: 29 }, sink);
    expect(result.frames).toBe(24);
    expect(result.durationCs).toBe(100);
    expect(readGifStructure(sink.bytes()).frames).toHaveLength(24);
    expect(Math.min(...source.drawn)).toBe(5);
    expect(Math.max(...source.drawn)).toBe(28);
  });

  it('streams bytes to the sink as it goes and closes it once', async () => {
    const writes: number[] = [];
    let closed = 0;
    const inner = memorySink();
    await exportGif(movingSquare(), { from: 0, to: 4 }, {
      write(data, position) {
        writes.push(position);
        inner.write(data, position);
      },
      close: () => void closed++,
    });
    expect(writes.length).toBeGreaterThan(4);
    expect(writes).toEqual([...writes].sort((a, b) => a - b));
    expect(closed).toBe(1);
    expect(readGifStructure(inner.bytes()).frames).toHaveLength(4);
  });

  it('refuses an empty range and scenes above 50 fps', async () => {
    await expect(exportGif(movingSquare(), { from: 3, to: 3 }, memorySink())).rejects.toThrow(/nothing to export/);
    await expect(exportGif(movingSquare(60), { from: 0, to: 4 }, memorySink())).rejects.toThrow(/50 fps/);
  });
});
