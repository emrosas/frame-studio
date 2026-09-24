import { describe, expect, it } from 'vitest';
import { EXPORT_COLOR_SPACE, checkEncoderColorSpace, rgbaToI420 } from './color';

/** A width x height RGBA image filled with one colour. */
function solid(width: number, height: number, [r, g, b]: [number, number, number]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) rgba.set([r, g, b, 255], p * 4);
  return rgba;
}

/** [Y, U, V] of the first pixel of an I420 buffer. */
function firstYuv(i420: Uint8Array, width: number, height: number): number[] {
  return [i420[0], i420[width * height], i420[width * height + (width / 2) * (height / 2)]];
}

describe('rgbaToI420 (BT.709 matrix, full range)', () => {
  it('lays out Y, then U, then V planes at quarter size', () => {
    expect(rgbaToI420(solid(4, 2, [0, 0, 0]), 4, 2)).toHaveLength(4 * 2 + 2 * 2 * 1);
  });

  it('maps white, black and grey to the full 0 to 255 range with neutral chroma', () => {
    expect(firstYuv(rgbaToI420(solid(2, 2, [255, 255, 255]), 2, 2), 2, 2)).toEqual([255, 128, 128]);
    expect(firstYuv(rgbaToI420(solid(2, 2, [0, 0, 0]), 2, 2), 2, 2)).toEqual([0, 128, 128]);
    expect(firstYuv(rgbaToI420(solid(2, 2, [128, 128, 128]), 2, 2), 2, 2)).toEqual([128, 128, 128]);
  });

  it('uses the BT.709 weights, not BT.601', () => {
    // #ffa200: Y = 0.2126*255 + 0.7152*162 = 170.08, U = 128 - 170.08/1.8556, V = 128 + 84.92/1.5748.
    expect(firstYuv(rgbaToI420(solid(2, 2, [255, 162, 0]), 2, 2), 2, 2)).toEqual([170, 36, 182]);
    // BT.601 would give Y = 0.299*255 + 0.587*162 = 171.3 and U = 30.
  });

  it('averages chroma over each 2x2 block and keeps luma per pixel', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const out = rgbaToI420(rgba, 2, 2);
    expect([...out.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([out[4], out[5]]).toEqual([128, 128]);
  });

  it('writes into a reused buffer and refuses odd sizes', () => {
    const out = new Uint8Array(6);
    expect(rgbaToI420(solid(2, 2, [0, 0, 0]), 2, 2, out)).toBe(out);
    expect(() => rgbaToI420(solid(3, 2, [0, 0, 0]), 3, 2)).toThrow(/even/);
  });
});

describe('checkEncoderColorSpace', () => {
  it('passes when the encoder reports BT.709 primaries, sRGB transfer and the BT.709 matrix', () => {
    expect(() => checkEncoderColorSpace({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true })).not.toThrow();
  });

  it('ignores the reported range, which VideoToolbox in Chromium 140 and 152 gets wrong', () => {
    expect(() => checkEncoderColorSpace({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false })).not.toThrow();
  });

  it('passes when the encoder reports nothing, since then there is nothing to contradict', () => {
    expect(() => checkEncoderColorSpace(undefined)).not.toThrow();
  });

  it('fails loudly when the encoder wrote other tags, so colr and the VUI never disagree', () => {
    expect(() => checkEncoderColorSpace({ primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false })).toThrow(
      /smpte170m.*bt709/s,
    );
  });

  it('describes the export colour space in WebCodecs terms', () => {
    expect(EXPORT_COLOR_SPACE).toEqual({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true });
  });
});
