import { PASS_THROUGH } from './kit';
import { resolveLayer, sceneLayers } from './resolve';
import { createRng } from './rng';
import { frameCount } from './time';
import type { Ctx2D, DrawKit, Layer, RigRegistry, Scene } from './types';

/**
 * Put every drawing-state property back to the canvas default, except the
 * transform (the caller owns the base transform, e.g. the viewer's DPR scale).
 * Also starts a fresh path: the current path is not part of save/restore, so
 * an open path from an earlier layer or frame would otherwise leak.
 */
export function resetContextState(ctx: Ctx2D): void {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 10;
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.filter = 'none';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  ctx.imageSmoothingEnabled = true;
  // Newer properties; skipped where the browser lacks them.
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'low';
  if ('direction' in ctx) ctx.direction = 'inherit';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  if ('wordSpacing' in ctx) ctx.wordSpacing = '0px';
  if ('fontKerning' in ctx) ctx.fontKerning = 'auto';
  if ('fontStretch' in ctx) ctx.fontStretch = 'normal';
  if ('fontVariantCaps' in ctx) ctx.fontVariantCaps = 'normal';
  if ('textRendering' in ctx) ctx.textRendering = 'auto';
  ctx.beginPath();
}

/** Throws RangeError unless frame is an integer in [0, frameCount(scene)). */
export function assertFrame(scene: Scene, frame: number): void {
  const count = frameCount(scene);
  if (!Number.isInteger(frame) || frame < 0 || frame >= count) {
    throw new RangeError(
      `frame ${frame} is out of range for scene "${scene.id}": expected an integer in [0, ${count}) (0..${count - 1})`,
    );
  }
}

/**
 * Draw one layer on one frame, over whatever the context holds. This is the
 * only way a layer gets drawn: render, hit testing and selection masks all
 * call it, so they can never drift apart. The layer starts from default
 * context state and a fresh RNG keyed by (scene.seed, layer.id), and the
 * context is restored afterwards. `layer` comes from sceneLayers(scene).
 * Throws RangeError unless frame is an integer in [0, frameCount(scene)).
 */
export function drawLayer(
  ctx: Ctx2D,
  scene: Scene,
  layer: Layer,
  frame: number,
  registry: RigRegistry,
  kit: DrawKit = PASS_THROUGH,
): void {
  assertFrame(scene, frame);
  const { id, rig, params, t } = resolveLayer(layer, scene, frame, registry);
  const [width, height] = scene.size;
  ctx.save();
  try {
    resetContextState(ctx);
    rig.draw(ctx, params, t, createRng(scene.seed, id), { width, height }, kit);
  } finally {
    ctx.restore();
  }
}

/**
 * Draw one frame. The image is a pure function of (scene, frame, registry).
 * Clears the scene rectangle, then draws every layer back to front with drawLayer.
 * Throws RangeError unless frame is an integer in [0, frameCount(scene)).
 */
export function render(ctx: Ctx2D, scene: Scene, frame: number, registry: RigRegistry): void {
  assertFrame(scene, frame);
  const [width, height] = scene.size;
  ctx.save();
  try {
    ctx.clearRect(0, 0, width, height);
    for (const layer of sceneLayers(scene)) drawLayer(ctx, scene, layer, frame, registry);
  } finally {
    ctx.restore();
  }
}
