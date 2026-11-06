import { PASS_THROUGH } from './kit';
import { pictureTime } from './picture';
import { quantize, stageSize } from './pixel';
import { defaultParams } from './registry';
import { resolveLayer, sceneLayers, type ResolvedLayer } from './resolve';
import { createRng } from './rng';
import { isIdentityPlacement, MAX_SCENE_DEPTH, sceneLayerSpan, scenePlacement, shotFrame } from './scene-layer';
import { frameCount } from './time';
import { evaluateTracks } from './tracks';
import { BACKGROUND_ID, type Ctx2D, type DrawKit, type Layer, type MaskSpec, type RigRegistry, type Scene, type Surfaces, type World } from './types';

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
  const scale = scene.pixel?.scale ?? 1;
  if (scale === 1) {
    drawStageLayer(ctx, scene, layer, frame, registry, kit, world);
    return;
  }
  // Hit tests and selection masks reach a pixel stage's layers at full size, on the same drawing code.
  ctx.save();
  try {
    ctx.scale(scale, scale);
    drawStageLayer(ctx, scene, layer, frame, registry, kit, world);
  } finally {
    ctx.restore();
  }
}

/** drawLayer in the scene's stage pixels: on a pixel stage, the small canvas's. */
function drawStageLayer(ctx: Ctx2D, scene: Scene, layer: Layer, frame: number, registry: RigRegistry, kit: DrawKit, world: World): void {
  if (layer.scene !== undefined) {
    drawSceneLayer(ctx, scene, layer, frame, registry, world);
    return;
  }
  if (layer.file !== undefined) {
    drawPictureLayer(ctx, scene, layer, frame, registry, world);
    return;
  }
  const resolved = resolveLayer(layer, scene, frame, registry, world);
  const mask = layer.mask;
  const view = cameraView(scene, layer, frame);
  if (!mask) {
    drawResolved(ctx, scene, resolved, kit, view);
    return;
  }
  const surfaces = need(world, layer);
  composite(ctx, surfaces, 1, (surface) => {
    drawResolved(surface, scene, resolved, kit, view);
    applyMask(surface, scene, layer.id, mask, resolved.t, registry, surfaces, view);
  });
}

/** What the camera does to one layer on one frame, or null when it does nothing. */
export interface CameraView { x: number; y: number; zoom: number }

/**
 * The camera at this frame, scaled by the layer's depth. A pixel stage moves
 * by whole pixels, so a layer never shimmers between two; layers at different
 * depths step at different rates, which is what parallax looks like there.
 * The camera runs on output time, so a stepFps layer still glides.
 */
export function cameraView(scene: Scene, layer: Layer, frame: number): CameraView | null {
  const camera = scene.camera;
  const depth = layer.depth ?? (layer.id === BACKGROUND_ID ? 0 : 1);
  if (!camera || depth === 0) return null;
  const at = evaluateTracks(camera.tracks, frame / scene.fps);
  const x = Number(at.x ?? camera.x ?? 0) * depth;
  const y = Number(at.y ?? camera.y ?? 0) * depth;
  const zoom = 1 + (Number(at.zoom ?? camera.zoom ?? 1) - 1) * depth;
  return scene.pixel ? { x: Math.round(x), y: Math.round(y), zoom } : { x, y, zoom };
}

/** Draws a resolved layer's rig with fresh state, its own RNG and the stage. */
function drawResolved(ctx: Ctx2D, scene: Scene, { id, rig, params, t }: ResolvedLayer, kit: DrawKit, view: CameraView | null = null): void {
  const [width, height] = stageSize(scene);
  ctx.save();
  try {
    resetContextState(ctx);
    if (view) {
      ctx.translate(width / 2, height / 2);
      ctx.scale(view.zoom, view.zoom);
      ctx.translate(-width / 2 - view.x, -height / 2 - view.y);
    }
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
function applyMask(surface: Ctx2D, scene: Scene, layerId: string, mask: MaskSpec, t: number, registry: RigRegistry, surfaces: Surfaces, view: CameraView | null = null): void {
  const rig = registry.get(mask.rig);
  if (!rig) throw new Error(`layer "${layerId}": its mask's rig "${mask.rig}" is not registered`);
  const params = { ...defaultParams(rig), ...mask.params, ...evaluateTracks(mask.tracks, t) };
  const cut = surfaces.create(surface);
  try {
    drawResolved(cut, scene, { id: `${layerId}:mask`, rig, params, t }, PASS_THROUGH, view);
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
      // A clip of another size than its composition sits centred (ADR 0013), clipped to its own stage.
      if (!isIdentityPlacement(place) || shotWidth !== width || shotHeight !== height) {
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

/** A picture clip (ADR 0014): placed like a scene layer, fit to the stage about its centre. */
function drawPictureLayer(ctx: Ctx2D, scene: Scene, layer: Layer, frame: number, registry: RigRegistry, world: World): void {
  const t = pictureTime(layer, scene, frame);
  if (t === null) return;
  const place = scenePlacement(layer, scene, frame);
  if (place.opacity <= 0) return;
  const picture = world.pictures?.at(layer.file ?? '', t);
  if (!picture) return;
  const [width, height] = scene.size;
  const fit = (layer.fit === 'contain' ? Math.min : Math.max)(width / picture.width, height / picture.height);
  const paint = (target: Ctx2D) => {
    target.save();
    try {
      target.translate(width / 2 + place.x, height / 2 + place.y);
      target.rotate((place.rotation * Math.PI) / 180);
      target.scale(place.scale * fit, place.scale * fit);
      target.drawImage(picture.image, -picture.width / 2, -picture.height / 2, picture.width, picture.height);
    } finally {
      target.restore();
    }
  };
  const mask = layer.mask;
  if (!mask) {
    ctx.save();
    try {
      ctx.globalAlpha = place.opacity;
      paint(ctx);
    } finally {
      ctx.restore();
    }
    return;
  }
  const surfaces = need(world, layer);
  composite(ctx, surfaces, place.opacity, (surface) => {
    paint(surface);
    applyMask(surface, scene, layer.id, mask, frame / scene.fps, registry, surfaces);
  });
}

/** Draws every layer of a scene back to front, without clearing: a frame, or a shot inside another scene. */
function drawScene(ctx: Ctx2D, scene: Scene, frame: number, registry: RigRegistry, world: World): void {
  const pixel = scene.pixel;
  if (!pixel || (pixel.scale === 1 && !pixel.palette)) {
    for (const layer of sceneLayers(scene)) drawStageLayer(ctx, scene, layer, frame, registry, PASS_THROUGH, world);
    return;
  }
  if (!world.surfaces) throw new Error(`scene "${scene.id}" has a pixel stage, and this renderer gave no surfaces`);
  const [width, height] = stageSize(scene);
  const stage = world.surfaces.create(ctx, [width, height]);
  try {
    for (const layer of sceneLayers(scene)) drawStageLayer(stage, scene, layer, frame, registry, PASS_THROUGH, world);
    if (pixel.palette) {
      const image = stage.getImageData(0, 0, width, height);
      quantize(image.data, width, height, pixel);
      stage.putImageData(image, 0, 0);
    }
    // Under whatever transform ctx has: the viewer's fit, or a clip's placement. A frame or a clip, the same square pixels.
    ctx.save();
    try {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(stage.canvas, 0, 0, scene.size[0], scene.size[1]);
    } finally {
      ctx.restore();
    }
  } finally {
    world.surfaces.release(stage);
  }
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
