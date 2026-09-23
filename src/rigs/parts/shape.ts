import type { Ctx2D, ParamSchema, Rig } from '../../engine/types';
import { traceSmoothLoop, wobbleOutline, type Point } from './outline';
import { readParams, type ParamReader } from './params';
import { applyTransform, paintPath, styleParams, transformParams } from './style';

/** One closed outline, centred on the origin in the shape's local pixels. */
export interface ShapeGeometry {
  /** Adds the exact outline to the current path. Used when wobble is 0. */
  trace(ctx: Ctx2D): void;
  /** The same outline as a loop of points. Used for the hand-drawn boil. */
  sample(): Point[];
}

export interface ShapeRigSpec {
  id: string;
  description: string;
  /** Default fill colour for this shape. */
  fill: string;
  /** Geometry params only. Transform and style params are added for you. */
  params: ParamSchema;
  geometry(p: ParamReader): ShapeGeometry;
}

/**
 * Builds a filled and outlined shape rig. Every shape gets the same
 * transform params (x, y, scale, rotation) and style params (fill, stroke,
 * strokeWidth, opacity, wobble), so shapes stay interchangeable.
 */
export function defineShapeRig(spec: ShapeRigSpec): Rig {
  const params: ParamSchema = { ...transformParams, ...spec.params, ...styleParams(spec.fill) };

  return {
    id: spec.id,
    description: spec.description,
    params,
    draw(ctx, values, t, rng) {
      const p = readParams(params, values);
      const shape = spec.geometry(p);
      const wobble = p.number('wobble');

      ctx.save();
      applyTransform(ctx, p);
      ctx.beginPath();
      if (wobble > 0) {
        // Keyed on the layer's quantized time: the outline boils once per
        // held frame and is identical whenever the same time is drawn again.
        traceSmoothLoop(ctx, wobbleOutline(shape.sample(), wobble, rng.fork(String(t))));
      } else {
        shape.trace(ctx);
      }
      paintPath(ctx, p);
      ctx.restore();
    },
  };
}
