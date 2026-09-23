import { describe, expect, it } from 'vitest';
import type { Layer, Scene } from '../engine/types';
import { MASK_MIN_ALPHA, maskKey, maskSize, ringOffsets, thresholdMask } from './mask';

/** RGBA pixels from a grid of alpha values. */
function pixels(alpha: number[][]): Uint8ClampedArray {
  const h = alpha.length;
  const w = alpha[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  alpha.forEach((row, y) =>
    row.forEach((a, x) => {
      const i = (y * w + x) * 4;
      data.set([200, 100, 50, a], i);
    }),
  );
  return data;
}

function alphas(data: Uint8ClampedArray, w: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.floor(i / 4 / w);
    (rows[y] ??= []).push(data[i + 3]);
  }
  return rows;
}

describe('thresholdMask', () => {
  it('keeps alpha >= 0.25 as opaque white, drops fainter paint, and returns the bounding box', () => {
    expect(MASK_MIN_ALPHA).toBe(64);
    const data = pixels([
      [0, 0, 0, 0],
      [0, 63, 64, 0],
      [0, 255, 10, 0],
      [0, 0, 0, 0],
    ]);
    const box = thresholdMask(data, 4, 4);
    expect(box).toEqual({ x0: 1, y0: 1, x1: 3, y1: 3 });
    expect(alphas(data, 4)).toEqual([
      [0, 0, 0, 0],
      [0, 0, 255, 0],
      [0, 255, 0, 0],
      [0, 0, 0, 0],
    ]);
    // Kept pixels are white, so the overlay can tint them any colour.
    expect([...data.slice((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4)]).toEqual([255, 255, 255, 255]);
    // Dropped pixels are fully clear.
    expect([...data.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)]).toEqual([0, 0, 0, 0]);
  });

  it('returns null when nothing is left, and covers the whole stage for a full-frame layer', () => {
    expect(thresholdMask(pixels([[10, 20], [30, 63]]), 2, 2)).toBeNull();
    expect(thresholdMask(pixels([[255, 255], [255, 255]]), 2, 2)).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 });
  });

  it('takes a custom threshold', () => {
    const data = pixels([[100, 200]]);
    expect(thresholdMask(data, 2, 1, 150)).toEqual({ x0: 1, y0: 0, x1: 2, y1: 1 });
  });
});

describe('ringOffsets', () => {
  it('lists the whole-pixel offsets on a one-pixel-wide circle of radius r', () => {
    for (const r of [1, 2, 3, 4, 6]) {
      const offsets = ringOffsets(r);
      for (const [dx, dy] of offsets) {
        expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
        const d = Math.hypot(dx, dy);
        expect(d).toBeGreaterThan(r - 1);
        expect(d).toBeLessThanOrEqual(r);
      }
      // Every whole-pixel point on that circle is there, so the reach is r in every main direction.
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const d = Math.hypot(dx, dy);
          if (d > r - 1 && d <= r) expect(offsets).toContainEqual([dx, dy]);
        }
      }
      expect(offsets).toContainEqual([r, 0]);
      expect(offsets).toContainEqual([0, -r]);
    }
  });

  it('rounds a fractional radius and is empty below half a pixel', () => {
    expect(ringOffsets(2.4)).toEqual(ringOffsets(2));
    expect(ringOffsets(0)).toEqual([]);
    expect(ringOffsets(0.4)).toEqual([]);
  });
});

describe('maskKey', () => {
  const layer = (over: Partial<Layer>): Layer => ({ id: 'a', rig: 'circle', ...over });
  const scene = (layers: Layer[]): Scene => ({ id: 's', fps: 12, duration: 6, size: [100, 100], seed: 1, layers });

  it('is shared by held frames: the drawing depends on quantized time and the active override only', () => {
    const onTwos = layer({ stepFps: 6 });
    const s = scene([onTwos]);
    expect(maskKey(s, onTwos, 10, null, 1)).toBe(maskKey(s, onTwos, 11, null, 1));
    expect(maskKey(s, onTwos, 11, null, 1)).not.toBe(maskKey(s, onTwos, 12, null, 1));
    const onOnes = layer({});
    expect(maskKey(s, onOnes, 10, null, 1)).not.toBe(maskKey(s, onOnes, 11, null, 1));
  });

  it('changes at override boundaries, even on a held frame', () => {
    const held = layer({ stepFps: 1, overrides: [{ from: 6, to: 12, params: { fill: 'red' } }] });
    const s = scene([held]);
    // Frames 5 and 6 share t = 0 but 6 is inside the override.
    expect(maskKey(s, held, 5, null, 1)).not.toBe(maskKey(s, held, 6, null, 1));
    expect(maskKey(s, held, 6, null, 1)).toBe(maskKey(s, held, 11, null, 1));
    expect(maskKey(s, held, 11, null, 1)).not.toBe(maskKey(s, held, 12, null, 1));
  });

  it('changes with the layer, the part and the scene version', () => {
    const a = layer({});
    const b = layer({ id: 'b' });
    const s = scene([a, b]);
    expect(maskKey(s, a, 3, null, 1)).not.toBe(maskKey(s, b, 3, null, 1));
    expect(maskKey(s, a, 3, null, 1)).not.toBe(maskKey(s, a, 3, 'nose', 1));
    expect(maskKey(s, a, 3, 'nose', 1)).not.toBe(maskKey(s, a, 3, 'ears', 1));
    expect(maskKey(s, a, 3, null, 1)).not.toBe(maskKey(s, a, 3, null, 2));
  });
});

describe('maskSize', () => {
  it('draws masks at the display (backing store) size, never above scene size', () => {
    expect(maskSize(1920, 1080, 1492)).toEqual({ width: 1492, height: 839, scale: 1492 / 1920 });
    expect(maskSize(1920, 1080, 960)).toEqual({ width: 960, height: 540, scale: 0.5 });
    // A backing store larger than the scene (high DPI) still masks at scene size.
    expect(maskSize(640, 360, 1280)).toEqual({ width: 640, height: 360, scale: 1 });
  });

  it('keeps at least one pixel, and falls back to scene size for an unmeasured canvas', () => {
    expect(maskSize(1920, 1080, 1)).toEqual({ width: 1, height: 1, scale: 1 / 1920 });
    expect(maskSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080, scale: 1 });
  });
});
