import { describe, expect, it } from 'vitest';
import { createColorMapper, createPaletteSampler, indexPixels, markUnchanged, type Rgb } from './palette';

/** RGBA pixels from a list of [r, g, b] colours, each repeated `times`. */
function pixels(colours: [Rgb, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [[r, g, b], times] of colours) for (let i = 0; i < times; i++) out.push(r, g, b, 255);
  return new Uint8ClampedArray(out);
}

describe('createPaletteSampler', () => {
  it('keeps every colour exactly when there are no more than the palette holds, most frequent first', () => {
    const sampler = createPaletteSampler({ pixelStep: 1 });
    sampler.add(pixels([[[255, 162, 0], 50], [[255, 255, 255], 30], [[20, 20, 20], 5]]));
    sampler.add(pixels([[[20, 20, 20], 40]]));
    expect(sampler.build()).toEqual([[255, 162, 0], [20, 20, 20], [255, 255, 255]]);
  });

  it('keeps the most frequent colours exact and fills the rest from the quantizer, within maxColors', () => {
    const colours: [Rgb, number][] = [[[255, 255, 255], 5000], [[255, 162, 0], 4000]];
    for (let i = 0; i < 2000; i++) colours.push([[(i * 7) % 256, (i * 13) % 256, (i * 29) % 256], 1]);
    const sampler = createPaletteSampler({ pixelStep: 1 });
    sampler.add(pixels(colours));
    const palette = sampler.build({ maxColors: 255, exactSlots: 16 });
    expect(palette.length).toBeLessThanOrEqual(255);
    expect(palette.length).toBeGreaterThan(200);
    expect(palette[0]).toEqual([255, 255, 255]);
    expect(palette[1]).toEqual([255, 162, 0]);
  });

  it('samples every pixelStep-th pixel', () => {
    const sampler = createPaletteSampler({ pixelStep: 2 });
    // Even pixels are orange and odd ones blue, so only orange is seen.
    const rgba = new Uint8ClampedArray(8 * 4);
    for (let p = 0; p < 8; p++) rgba.set(p % 2 === 0 ? [255, 162, 0, 255] : [0, 0, 255, 255], p * 4);
    sampler.add(rgba);
    expect(sampler.build()).toEqual([[255, 162, 0]]);
  });

  it('refuses an empty sample', () => {
    expect(() => createPaletteSampler().build()).toThrow(/no pixels/);
  });
});

describe('createColorMapper', () => {
  const palette: Rgb[] = [[0, 0, 0], [255, 255, 255], [255, 162, 0], [0, 0, 255]];
  const map = createColorMapper(palette);

  it('maps a palette colour to its own index', () => {
    palette.forEach(([r, g, b], i) => expect(map(r, g, b)).toBe(i));
  });

  it('maps any other colour to the nearest entry', () => {
    expect(map(250, 160, 10)).toBe(2);
    expect(map(10, 10, 10)).toBe(0);
    expect(map(240, 240, 250)).toBe(1);
    expect(map(30, 30, 200)).toBe(3);
  });

  it('holds at most 255 colours, leaving index 255 free for the transparent slot', () => {
    const full = Array.from({ length: 255 }, (_, i): Rgb => [i, i, i]);
    expect(createColorMapper(full)(254, 254, 254)).toBe(254);
    expect(() => createColorMapper([...full, [1, 2, 3]])).toThrow(/255/);
  });

  it('weighs green over blue, as the eye does', () => {
    // Equal plain distance to both entries, but the green difference counts more.
    const m = createColorMapper([[100, 110, 100], [100, 100, 110]]);
    expect(m(100, 100, 100)).toBe(1);
  });
});

describe('indexPixels and markUnchanged', () => {
  const map = createColorMapper([[0, 0, 0], [255, 255, 255]]);

  it('turns RGBA into palette indices and ignores alpha', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 250, 250, 250, 0, 5, 5, 5, 128]);
    expect([...indexPixels(rgba, map)]).toEqual([0, 1, 0]);
  });

  it('writes into a reused buffer', () => {
    const out = new Uint8Array(1);
    expect(indexPixels(new Uint8ClampedArray([255, 255, 255, 255]), map, out)).toBe(out);
    expect(out[0]).toBe(1);
  });

  it('writes the marked frame into a reused buffer', () => {
    const out = new Uint8Array(3);
    expect(markUnchanged(new Uint8Array([4, 5, 6]), new Uint8Array([4, 0, 6]), 255, out)).toBe(out);
    expect([...out]).toEqual([255, 5, 255]);
  });

  it('marks pixels that match the previous frame as transparent, and leaves both inputs alone', () => {
    const prev = new Uint8Array([0, 1, 1, 0]);
    const cur = new Uint8Array([0, 0, 1, 1]);
    expect([...markUnchanged(cur, prev, 255)]).toEqual([255, 0, 255, 1]);
    expect([...cur]).toEqual([0, 0, 1, 1]);
    expect([...prev]).toEqual([0, 1, 1, 0]);
  });
});
