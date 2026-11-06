// Offscreen surfaces the engine composites masks and faded shots on (ADR
// 0007). The engine never makes a canvas itself, so each host passes these in:
// the embed, the viewer and the render page. Surfaces are pooled, since a
// masked layer takes two every frame.

import type { Ctx2D, Surfaces } from '../engine/types';

/**
 * Surfaces from OffscreenCanvas. Pass the same context options the host's
 * own canvas uses: the render page and the embed rasterize on the CPU
 * (willReadFrequently), so their surfaces must too, or pixels could differ.
 */
export function createSurfaces(options: CanvasRenderingContext2DSettings = {}): Surfaces {
  const pool: OffscreenCanvasRenderingContext2D[] = [];
  const stagePool: OffscreenCanvasRenderingContext2D[] = [];
  const stages = new WeakSet<OffscreenCanvasRenderingContext2D>();
  return {
    create(like: Ctx2D, size?: readonly [number, number]): Ctx2D {
      const [width, height] = size ?? [like.canvas.width, like.canvas.height];
      const from = size ? stagePool : pool;
      let ctx = from.pop();
      if (!ctx) {
        const settings = size ? { willReadFrequently: true, colorSpace: 'srgb' as const } : options;
        const made = new OffscreenCanvas(width, height).getContext('2d', settings);
        if (!made) throw new Error('This browser did not provide an offscreen 2D context for compositing.');
        ctx = made;
      }
      const canvas = ctx.canvas;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      } else if (typeof ctx.reset === 'function') {
        ctx.reset();
      } else {
        canvas.width = width; // resetting the size clears pixels and state where reset() is missing
      }
      if (size) stages.add(ctx);
      if (size) ctx.setTransform(1, 0, 0, 1, 0, 0);
      else ctx.setTransform(like.getTransform());
      return ctx as unknown as Ctx2D;
    },
    release(surface: Ctx2D): void {
      const ctx = surface as unknown as OffscreenCanvasRenderingContext2D;
      (stages.has(ctx) ? stagePool : pool).push(ctx);
    },
  };
}
