import { PASS_THROUGH } from './kit';
import { defaultParams } from './registry';
import { resolveLayer, sceneLayers, type ResolvedLayer } from './resolve';
import { createRng } from './rng';
import { isIdentityPlacement, MAX_SCENE_DEPTH, sceneLayerSpan, scenePlacement, shotFrame } from './scene-layer';
import { frameCount } from './time';
import { evaluateTracks } from './tracks';
import type { Ctx2D, DrawKit, Layer, MaskSpec, RigRegistry, Scene, Surfaces, World } from './types';

/** How deep scene layers are nested while drawing; the validator refuses cycles, and this is the backstop. */
let depth = 0;

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
 * A project scene passes its `world`: the sibling scenes its scene layers
 * place, its cast, and surfaces for masks and scene layers with opacity.
 * Throws RangeError unless frame is an integer in [0, frameCount(scene)).
 */
export function drawLayer(
  ctx: Ctx2D,
  scene: Scene,
  layer: Layer,
  frame: number,
  registry: RigRegistry,
  kit: DrawKit = PASS_THROUGH,
  world: World = {},
): void {
  assertFrame(scene, frame);
  if (layer.scene !== undefined) {
    drawSceneLayer(ctx, scene, layer, frame, registry, world);
    return;
  }
  const resolved = resolveLayer(layer, scene, frame, registry, world);
  const mask = layer.mask;
  if (!mask) {
    drawResolved(ctx, scene, resolved, kit);
    return;
  }
  const surfaces = need(world, layer);
  composite(ctx, surfaces, 1, (surface) => {
    drawResolved(surface, scene, resolved, kit);
    applyMask(surface, scene, layer.id, mask, resolved.t, registry, surfaces);
  });
}

/** Draws a resolved layer's rig with fresh state, its own RNG and the stage. */
function drawResolved(ctx: Ctx2D, scene: Scene, { id, rig, params, t }: ResolvedLayer, kit: DrawKit): void {
  const [width, height] = scene.size;
  ctx.save();
  try {
    resetContextState(ctx);
    rig.draw(ctx, params, t, createRng(scene.seed, id), { width, height }, kit);
  } finally {
    ctx.restore();
  }
}

function need(world: World, layer: Layer): Surfaces {
  if (!world.surfaces) {
    throw new Error(`layer "${layer.id}" needs compositing (a mask, or a scene layer with opacity), and this renderer gave no surfaces`);
  }
  return world.surfaces;
}

/** Draws into a fresh surface, then puts the surface onto ctx, pixel for pixel, at `alpha`. */
function composite(ctx: Ctx2D, surfaces: Surfaces, alpha: number, draw: (surface: Ctx2D) => void): void {
  const surface = surfaces.create(ctx);
  try {
    draw(surface);
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(surface.canvas, 0, 0);
    } finally {
      ctx.restore();
    }
  } finally {
    surfaces.release(surface);
  }
}

/**
 * Keeps only what the mask draws: the mask rig draws on a surface of its own,
 * which then cuts the layer's surface with destination-in. Drawn apart, so a
 * mask rig's own compositing can't change the cut. Its time is the layer's.
 */
function applyMask(surface: Ctx2D, scene: Scene, layerId: string, mask: MaskSpec, t: number, registry: RigRegistry, surfaces: Surfaces): void {
  const rig = registry.get(mask.rig);
  if (!rig) throw new Error(`layer "${layerId}": its mask's rig "${mask.rig}" is not registered`);
  const params = { ...defaultParams(rig), ...mask.params, ...evaluateTracks(mask.tracks, t) };
  const cut = surfaces.create(surface);
  try {
    drawResolved(cut, scene, { id: `${layerId}:mask`, rig, params, t }, PASS_THROUGH);
    surface.save();
    try {
      surface.setTransform(1, 0, 0, 1, 0, 0);
      surface.globalAlpha = 1;
      surface.globalCompositeOperation = 'destination-in';
      surface.drawImage(cut.canvas, 0, 0);
    } finally {
      surface.restore();
    }
  } finally {
    surfaces.release(cut);
  }
}

/**
 * Draws the shot a scene layer places, as it is on the matching frame, with
 * its own seeds and stage. With the default placement, full opacity and no
 * mask it draws straight onto ctx, so the pixels are the shot's own; anything
 * else goes through a surface.
 */
function drawSceneLayer(ctx: Ctx2D, scene: Scene, layer: Layer, frame: number, registry: RigRegistry, world: World): void {
  const shot = world.scenes?.get(layer.scene ?? '');
  if (!shot) {
    const why = world.scenes ? 'is not in the project' : 'needs a project (a loose scene places no scenes)';
    throw new Error(`layer "${layer.id}" places scene "${layer.scene}", which ${why}`);
  }
  const at = shotFrame(sceneLayerSpan(layer, scene, shot), frame);
  if (at === null) return;
  const place = scenePlacement(layer, scene, frame);
  if (place.opacity <= 0) return;
  if (depth >= MAX_SCENE_DEPTH) throw new Error(`scene layers nest deeper than ${MAX_SCENE_DEPTH} at layer "${layer.id}"`);
  const [width, height] = scene.size;
  const [shotWidth, shotHeight] = shot.size;
  const drawShot = (target: Ctx2D) => {
    target.save();
    depth++;
    try {
      if (!isIdentityPlacement(place)) {
        target.translate(width / 2 + place.x, height / 2 + place.y);
        target.rotate((place.rotation * Math.PI) / 180);
        target.scale(place.scale, place.scale);
        target.translate(-shotWidth / 2, -shotHeight / 2);
        // Alone, the canvas edge hides whatever the shot draws off its stage; moved or scaled, its own edge must.
        target.beginPath();
        target.rect(0, 0, shotWidth, shotHeight);
        target.clip();
      }
      drawScene(target, shot, at, registry, world);
    } finally {
      depth--;
      target.restore();
    }
  };
  const mask = layer.mask;
  if (place.opacity === 1 && !mask) {
    drawShot(ctx);
    return;
  }
  const surfaces = need(world, layer);
  composite(ctx, surfaces, place.opacity, (surface) => {
    drawShot(surface);
    if (mask) applyMask(surface, scene, layer.id, mask, frame / scene.fps, registry, surfaces);
  });
}

/** Draws every layer of a scene back to front, without clearing: a frame, or a shot inside another scene. */
function drawScene(ctx: Ctx2D, scene: Scene, frame: number, registry: RigRegistry, world: World): void {
  for (const layer of sceneLayers(scene)) drawLayer(ctx, scene, layer, frame, registry, PASS_THROUGH, world);
}

/**
 * Draw one frame. The image is a pure function of (scene, frame, registry),
 * and for a project scene its world: the scenes it places and its cast.
 * Clears the scene rectangle, then draws every layer back to front with drawLayer.
 * Throws RangeError unless frame is an integer in [0, frameCount(scene)).
 */
export function render(ctx: Ctx2D, scene: Scene, frame: number, registry: RigRegistry, world: World = {}): void {
  assertFrame(scene, frame);
  const [width, height] = scene.size;
  ctx.save();
  try {
    ctx.clearRect(0, 0, width, height);
    drawScene(ctx, scene, frame, registry, world);
  } finally {
    ctx.restore();
  }
}
