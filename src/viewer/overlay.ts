// Selection and hover highlights. A second canvas sits exactly over the scene
// canvas (same CSS box, its own devicePixelRatio backing store) and never
// takes pointer events; the id tags are HTML. Nothing here draws on the scene
// canvas.
//
// A highlight starts from a mask: the layer drawn alone with drawLayer (only
// the selected part, for a part selection) into an offscreen canvas at the
// overlay's resolution, capped at scene size (see maskSize). Faint paint is dropped (alpha below 0.25) so washes and cast shadows
// do not bloat the shape. The mask is scaled to the overlay, tinted faintly,
// and outlined by drawing it at whole-pixel offsets around a circle and
// cutting the mask itself out.

import { drawLayer, onlyParts, PASS_THROUGH, sceneLayers } from '../engine';
import type { Layer, RigRegistry, Scene, World } from '../engine/types';
import type { Fit } from './canvas';
import { maskKey, maskSize, ringOffsets, thresholdMask, type PixelBox } from './mask';
import { layerLabel } from './selection';

export interface OverlayInput {
  scene: Scene | null;
  registry: RigRegistry | null;
  /** The scene's project world and surfaces, for scene layers and masks. */
  world?: World;
  frame: number;
  /** Bumped on every scene swap (hot edit or switch), so stale masks are never reused. */
  version: number;
  fit: Fit;
  selected: { layerId: string; partId: string | null } | null;
  hover: string | null;
}

interface Mask {
  key: string;
  canvas: OffscreenCanvas;
  /** Mask pixels per scene pixel. */
  scale: number;
  /** Bounds of what is left after thresholding, in mask pixels. */
  box: PixelBox | null;
  /** Time to draw the layer and threshold it, in ms. */
  ms: number;
}

interface HighlightStyle {
  color: string;
  /** Outline width in CSS pixels. */
  width: number;
  outlineAlpha: number;
  tintAlpha: number;
}

const SELECTED: HighlightStyle = { color: '#4da3ff', width: 2, outlineAlpha: 1, tintAlpha: 0.16 };
const HOVER: HighlightStyle = { color: '#4da3ff', width: 1, outlineAlpha: 0.75, tintAlpha: 0.06 };

/** Masks kept: the selection, the hover and a couple of recent ones (scrubbing back and forth). */
const CACHE_SIZE = 4;

export class SelectionOverlay {
  private world: World = {};
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly selectedTag: HTMLElement;
  private readonly hoverTag: HTMLElement;
  private masks: Mask[] = [];
  private spare: OffscreenCanvas[] = [];
  private scaled: OffscreenCanvasRenderingContext2D | null = null;
  private scratch: OffscreenCanvasRenderingContext2D | null = null;
  private lastKey = '';
  /** Mask timings (ms) for the last update that drew any, newest last. */
  readonly timings: number[] = [];

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-overlay';
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.setAttribute('aria-hidden', 'true');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
    this.ctx = ctx;
    this.hoverTag = tag('stage-tag is-hover');
    this.selectedTag = tag('stage-tag is-selected');
    host.append(this.canvas, this.hoverTag, this.selectedTag);
  }

  /** Redraws when anything that shows changed; cheap when nothing did. */
  update(input: OverlayInput): void {
    const { scene, registry, frame, version, fit } = input;
    this.world = input.world ?? {};
    const ready = scene !== null && registry !== null && fit.backingWidth > 0;
    const layers = ready ? new Map(sceneLayers(scene).map((l) => [l.id, l])) : new Map<string, Layer>();
    const sel = input.selected && layers.get(input.selected.layerId);
    const hov = input.hover !== null && input.hover !== input.selected?.layerId ? layers.get(input.hover) : undefined;
    const selKey = ready && sel ? maskKey(scene, sel, frame, input.selected?.partId ?? null, version) : null;
    const hovKey = ready && hov ? maskKey(scene, hov, frame, null, version) : null;
    const key = JSON.stringify([selKey, hovKey, fit.backingWidth, fit.backingHeight, fit.cssWidth, fit.cssHeight]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.resize(fit);
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.hoverTag.hidden = true;
    this.selectedTag.hidden = true;
    if (!ready) return;
    this.timings.length = 0;

    if (hov && hovKey) {
      const mask = this.mask(scene, hov, frame, null, registry, hovKey, fit);
      if (mask) {
        this.highlight(mask, fit, HOVER);
        this.placeTag(this.hoverTag, hov.id, mask, fit);
      }
    }
    if (sel && selKey && input.selected) {
      const mask = this.mask(scene, sel, frame, input.selected.partId, registry, selKey, fit);
      if (mask) {
        this.highlight(mask, fit, SELECTED);
        this.placeTag(this.selectedTag, layerLabel(sel.id, input.selected.partId), mask, fit);
      }
    }
  }

  /** Forget cached masks (their drawing may be stale). */
  reset(): void {
    for (const m of this.masks) this.spare.push(m.canvas);
    this.masks = [];
    this.lastKey = '';
  }

  private resize(fit: Fit): void {
    if (this.canvas.width !== fit.backingWidth) this.canvas.width = fit.backingWidth;
    if (this.canvas.height !== fit.backingHeight) this.canvas.height = fit.backingHeight;
    this.canvas.style.width = `${fit.cssWidth}px`;
    this.canvas.style.height = `${fit.cssHeight}px`;
  }

  /** The layer's mask on this frame, from the cache or drawn now. Null when the layer fails to draw. */
  private mask(scene: Scene, layer: Layer, frame: number, partId: string | null, registry: RigRegistry, layerKey: string, fit: Fit): Mask | null {
    const size = maskSize(scene.size[0], scene.size[1], fit.backingWidth);
    const key = `${layerKey}@${size.width}x${size.height}`;
    const hit = this.masks.findIndex((m) => m.key === key);
    if (hit >= 0) {
      const [mask] = this.masks.splice(hit, 1);
      this.masks.push(mask);
      return mask;
    }
    const { width: w, height: h, scale } = size;
    const canvas = this.takeCanvas(w, h);
    // No willReadFrequently: the mask is read once per drawing, and a
    // GPU-backed canvas rasterizes a painted rig about twice as fast as a
    // CPU one (measured in Chromium 151).
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const start = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    try {
      drawLayer(ctx, scene, layer, frame, registry, partId ? onlyParts([partId]) : PASS_THROUGH, this.world);
    } catch {
      // The render error is already on the error panel; show no highlight.
      this.spare.push(canvas);
      return null;
    }
    const image = ctx.getImageData(0, 0, w, h);
    const box = thresholdMask(image.data, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (box) ctx.putImageData(image, 0, 0, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    const mask: Mask = { key, canvas, scale, box, ms: performance.now() - start };
    this.timings.push(mask.ms);
    this.masks.push(mask);
    while (this.masks.length > CACHE_SIZE) this.spare.push(this.masks.shift()!.canvas);
    return mask;
  }

  private takeCanvas(w: number, h: number): OffscreenCanvas {
    const i = this.spare.findIndex((c) => c.width === w && c.height === h);
    if (i >= 0) return this.spare.splice(i, 1)[0];
    this.spare = [];
    return new OffscreenCanvas(w, h);
  }

  private work(fit: Fit): { scaled: OffscreenCanvasRenderingContext2D; scratch: OffscreenCanvasRenderingContext2D } | null {
    const make = (prev: OffscreenCanvasRenderingContext2D | null) => {
      if (prev && prev.canvas.width === fit.backingWidth && prev.canvas.height === fit.backingHeight) return prev;
      return new OffscreenCanvas(fit.backingWidth, fit.backingHeight).getContext('2d');
    };
    this.scaled = make(this.scaled);
    this.scratch = make(this.scratch);
    return this.scaled && this.scratch ? { scaled: this.scaled, scratch: this.scratch } : null;
  }

  private highlight(mask: Mask, fit: Fit, style: HighlightStyle): void {
    const box = mask.box;
    if (!box) return;
    const kit = this.work(fit);
    if (!kit) return;
    const { scaled, scratch } = kit;
    const { ctx } = this;
    // Mask pixels to overlay (backing) pixels.
    const s = fit.scale / mask.scale;
    const dpr = fit.cssWidth > 0 ? fit.backingWidth / fit.cssWidth : 1;
    const r = Math.max(1, Math.round(style.width * dpr));
    const mw = mask.canvas.width;
    const mh = mask.canvas.height;

    // Work only inside the mask's box, padded by the outline.
    const pad = r + 2;
    const x0 = Math.max(0, Math.floor(box.x0 * s) - pad);
    const y0 = Math.max(0, Math.floor(box.y0 * s) - pad);
    const x1 = Math.min(fit.backingWidth, Math.ceil(box.x1 * s) + pad);
    const y1 = Math.min(fit.backingHeight, Math.ceil(box.y1 * s) + pad);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    // The mask at overlay resolution, in the highlight colour. Unsmoothed, so
    // the outline stays hard-edged when a high-DPI overlay scales it up.
    scaled.globalCompositeOperation = 'source-over';
    scaled.clearRect(x0, y0, w, h);
    scaled.imageSmoothingEnabled = false;
    scaled.drawImage(mask.canvas, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, box.x0 * s, box.y0 * s, (box.x1 - box.x0) * s, (box.y1 - box.y0) * s);
    scaled.globalCompositeOperation = 'source-in';
    scaled.fillStyle = style.color;
    scaled.fillRect(x0, y0, w, h);
    scaled.globalCompositeOperation = 'source-over';

    // Tint.
    ctx.globalAlpha = style.tintAlpha;
    ctx.drawImage(scaled.canvas, x0, y0, w, h, x0, y0, w, h);

    // Outline: the mask dilated by r, minus the mask.
    scratch.globalCompositeOperation = 'source-over';
    scratch.clearRect(x0, y0, w, h);
    for (const [dx, dy] of ringOffsets(r)) scratch.drawImage(scaled.canvas, x0, y0, w, h, x0 + dx, y0 + dy, w, h);
    scratch.globalCompositeOperation = 'destination-out';
    scratch.drawImage(scaled.canvas, x0, y0, w, h, x0, y0, w, h);
    scratch.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = style.outlineAlpha;
    ctx.drawImage(scratch.canvas, x0, y0, w, h, x0, y0, w, h);

    // A layer covering the whole stage has its outline off the canvas: frame the canvas instead.
    if (box.x0 === 0 && box.y0 === 0 && box.x1 === mw && box.y1 === mh) {
      ctx.strokeStyle = style.color;
      ctx.lineWidth = r;
      ctx.strokeRect(r / 2, r / 2, fit.backingWidth - r, fit.backingHeight - r);
    }
    ctx.globalAlpha = 1;
  }

  /** Puts a tag just above the mask's top-left corner, or inside the canvas when there is no room above. */
  private placeTag(el: HTMLElement, label: string, mask: Mask, fit: Fit): void {
    const box = mask.box;
    const k = fit.cssWidth / mask.canvas.width;
    el.textContent = box ? label : `${label} (not visible on this frame)`;
    el.hidden = false;
    const left = box ? Math.min(Math.max(0, box.x0 * k), Math.max(0, fit.cssWidth - 48)) : 0;
    const top = box ? box.y0 * k : 0;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // Above the box when a tag fits between it and the canvas top; inside otherwise.
    el.classList.toggle('is-inside', top < 22);
  }
}

function tag(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.hidden = true;
  return el;
}
