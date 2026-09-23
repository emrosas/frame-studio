// Pure helpers for selection masks: thresholding a rendered layer into a
// hard-edged mask, the offsets that dilate it into an outline, and the cache
// key that says when a layer's drawing can have changed.

import { activeOverride, quantizeTime } from '../engine';
import type { Layer, Scene } from '../engine/types';

/**
 * Pixels fainter than this (alpha 0.25 of 255, rounded up) are dropped from a
 * mask, so washes, glows and cast shadows do not bloat the outlined shape.
 */
export const MASK_MIN_ALPHA = 64;

/** Pixel bounds [x0, x1) x [y0, y1). */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Rewrites RGBA pixels in place: alpha >= minAlpha becomes opaque white,
 * anything fainter becomes fully clear. Returns the bounds of what is left,
 * or null when nothing is.
 */
export function thresholdMask(data: Uint8ClampedArray, width: number, height: number, minAlpha = MASK_MIN_ALPHA): PixelBox | null {
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  if (LITTLE_ENDIAN && data.byteOffset % 4 === 0) {
    // One 32-bit word per pixel; alpha is the high byte on little-endian machines.
    const words = new Uint32Array(data.buffer, data.byteOffset, width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let first = -1;
      let last = -1;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        if (words[i] >>> 24 >= minAlpha) {
          words[i] = 0xffffffff;
          if (first < 0) first = x;
          last = x;
        } else {
          words[i] = 0;
        }
      }
      if (first >= 0) {
        if (first < x0) x0 = first;
        if (last + 1 > x1) x1 = last + 1;
        if (y < y0) y0 = y;
        y1 = y + 1;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const keep = data[i + 3] >= minAlpha;
        const v = keep ? 255 : 0;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = v;
        if (keep) {
          if (x < x0) x0 = x;
          if (x + 1 > x1) x1 = x + 1;
          if (y < y0) y0 = y;
          y1 = y + 1;
        }
      }
    }
  }
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * Whole-pixel offsets on a one-pixel-wide circle of radius r (rounded):
 * every (dx, dy) with r - 1 < hypot(dx, dy) <= r. Drawing a mask at each
 * offset and cutting the mask itself out leaves an outline r pixels wide.
 * Whole pixels keep the outline crisp; fractional offsets would resample it.
 */
export function ringOffsets(radius: number): Array<[number, number]> {
  const r = Math.round(radius);
  const out: Array<[number, number]> = [];
  if (!(r >= 1)) return out;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > r - 1 && d <= r) out.push([dx, dy]);
    }
  }
  return out;
}

/**
 * A key that changes whenever the layer's drawing on this frame can change.
 * drawLayer depends on the scene (version), the layer, the part filter, the
 * layer's quantized time and the override active on the frame, so held
 * frames of a stepFps layer share a key and reuse one mask.
 */
export function maskKey(scene: Scene, layer: Layer, frame: number, partId: string | null, version: number): string {
  const t = quantizeTime(frame, scene.fps, layer.stepFps);
  const o = activeOverride(layer.overrides, frame);
  const override = o ? (layer.overrides ?? []).indexOf(o) : -1;
  return JSON.stringify([version, layer.id, partId, t, override]);
}

/** The size a mask is drawn at, and its scale in mask pixels per scene pixel. */
export interface MaskSize {
  width: number;
  height: number;
  scale: number;
}

/**
 * Masks are drawn at the overlay's resolution (the canvas backing store,
 * device pixels), capped at scene size. Finer masks add nothing visible, and
 * a painted rig costs less to draw at 1492x839 than at 1920x1080. A canvas
 * not measured yet (displayWidth 0) gets scene size.
 */
export function maskSize(sceneW: number, sceneH: number, displayWidth: number): MaskSize {
  const scale = displayWidth > 0 ? Math.min(1, displayWidth / sceneW) : 1;
  return {
    width: Math.max(1, Math.round(sceneW * scale)),
    height: Math.max(1, Math.round(sceneH * scale)),
    scale,
  };
}
