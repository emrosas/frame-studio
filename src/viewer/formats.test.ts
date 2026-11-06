import { describe, expect, it } from 'vitest';
import { checkNewScene, checkNewVideo } from '../studio/protocol';
import { FORMATS, LOOKS, PIXEL_DITHER } from './formats';

describe('formats', () => {
  it('gives a pixel short the 180x320 stage', () => {
    const pixel = FORMATS.find((f) => f.pixelScale !== undefined)!;
    expect(pixel.size.map((n) => n / pixel.pixelScale!)).toEqual([180, 320]);
  });

  it('makes files the server takes', () => {
    for (const f of FORMATS) {
      const pixel = f.pixelScale ? { scale: f.pixelScale, palette: [...LOOKS[0].palette], dither: PIXEL_DITHER } : undefined;
      const input = { id: 'x', fps: f.fps, size: [...f.size], duration: f.duration, ...(pixel ? { pixel } : {}) };
      expect(checkNewScene(input)).toBeNull();
      expect(checkNewVideo(input)).toBeNull();
    }
  });
});

describe('looks', () => {
  it('are sixteen distinct colours each', () => {
    expect(LOOKS.length).toBe(4);
    for (const look of LOOKS) {
      expect(look.palette.length).toBe(16);
      expect(new Set(look.palette).size).toBe(16);
      for (const colour of look.palette) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('protocol checks', () => {
  it('refuses a pixel scale that does not divide the size', () => {
    expect(checkNewScene({ id: 'x', size: [1080, 1921], duration: 5, pixel: { scale: 6 } })).toMatch(/divide/);
  });

  it('refuses a pixel video without its scene', () => {
    expect(checkNewVideo({ id: 'x', duration: 5, scene: false, pixel: { scale: 6 } })).toMatch(/first scene/);
  });
});
