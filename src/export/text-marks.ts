// Where text is on a frame, from the scene alone (ADR 0010, ADR 0016). The
// text rig and captions lay out glyphs from typeface modules, so the ink of
// every glyph comes from arithmetic, not from pixels. This walks a frame the
// way render() does (clips with their placement and opacity, the camera, the
// pixel stage) and returns each visible text layer's boxes in output pixels.
// Only the built-in type rigs are reached: a studio rig that calls drawText
// itself isn't. Tooling for the check tool; never imported by the runtime.

import { cameraView } from '../engine/render';
import { stageSize } from '../engine/pixel';
import { resolveLayer, sceneLayers } from '../engine/resolve';
import { isIdentityPlacement, MAX_SCENE_DEPTH, sceneLayerSpan, scenePlacement, shotFrame } from '../engine/scene-layer';
import { sceneWords } from '../engine/speech';
import { frameCount } from '../engine/time';
import { BACKGROUND_ID, type RigRegistry, type Scene, type SpokenWord, type World } from '../engine/types';
import { layoutCaptions, type CaptionCase, type CaptionLayout, type CaptionPosition } from '../rigs/type/caption-layout';
import type { PlacedGlyph, TextLayout } from '../rigs/type/layout';
import { textBlock } from '../rigs/type/text';
import type { Glyph } from '../rigs/type/typeface';

/** A 2D affine transform, as DOMMatrix's a to f: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = readonly [number, number, number, number, number, number];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One text layer as it shows on one frame. */
export interface TextMark {
  /** The layer's id, after the ids of the clips that place it: "intro/title". */
  path: string;
  /** The scene the layer belongs to, and its id there: what to take out to see behind it. */
  owner: { scene: string; layer: string };
  /** True for a layer of the checked scene itself rather than of a clip. */
  top: boolean;
  rig: 'text' | 'captions';
  /** All the text the layer or page holds, as drawn (after case). */
  text: string;
  /** Every character of it is drawn: a reveal has finished, every popped word is in. */
  complete: boolean;
  /** The layer's opacity times every clip's above it, 0 to 1. */
  opacity: number;
  /** Colours the glyphs are filled with (captions: the colour, and the highlight). */
  fills: string[];
  /** An outline colour, or null. */
  stroke: string | null;
  /** The outline's width in output pixels. */
  strokeWidth: number;
  /** Font size: output pixels per em. */
  size: number;
  /** Ink boxes of the drawn glyphs, a box a line, in the layer's own coordinates. */
  lines: Box[];
  /** From the layer's own coordinates to output pixels. */
  transform: Affine;
  /** Everything drawn, in output pixels, axis-aligned. */
  box: Box;
  /** Where the text can show, in output pixels: the frame, cut down to every moved clip's own edges. */
  area: Box;
  /** The edges of the moved clips above it, which hide whatever the shot draws off its stage. */
  clips: Clip[];
}

/** A clip's stage, which the renderer cuts its shot to: output pixels to the shot's own, and its size. */
export interface Clip {
  inverse: Affine;
  width: number;
  height: number;
}

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m` then `n`: n applied first, as ctx.transform(n) after m. */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
const scaling = (s: number): Affine => [s, 0, 0, s, 0, 0];
const rotation = (radians: number): Affine => [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0];

export const apply = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** The inverse transform, or null for one that flattens everything. */
export function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** The axis-aligned box around `boxes` once transformed. */
export function boundsOf(boxes: readonly Box[], m: Affine): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    for (const [x, y] of [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height],
    ]) {
      const [u, v] = apply(m, x, y);
      left = Math.min(left, u);
      right = Math.max(right, u);
      top = Math.min(top, v);
      bottom = Math.max(bottom, v);
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The overlap of two boxes, which may be empty (zero or negative size). */
export function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.min(a.x + a.width, b.x + b.width) - x, height: Math.min(a.y + a.height, b.y + b.height) - y };
}

/** True when output pixel (x, y) falls in one of the mark's line boxes and inside every clip above it. */
export function markContains(mark: TextMark, inverse: Affine, x: number, y: number): boolean {
  for (const clip of mark.clips) {
    const [cx, cy] = apply(clip.inverse, x, y);
    if (cx < 0 || cy < 0 || cx > clip.width || cy > clip.height) return false;
  }
  const [u, v] = apply(inverse, x, y);
  return mark.lines.some((b) => u >= b.x && u <= b.x + b.width && v >= b.y && v <= b.y + b.height);
}

// ---- glyph ink ----

/** A glyph's ink in font units, y up, or null for one with no outline. Control points bound the curves, so it can only err large, by a little. */
const inks = new Map<string, readonly [number, number, number, number] | null>();

function inkOf(glyph: Glyph): readonly [number, number, number, number] | null {
  const outline = glyph[1];
  let ink = inks.get(outline);
  if (ink !== undefined) return ink;
  // Every command takes x, y pairs, so the numbers alternate.
  const values = (outline.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < values.length; i += 2) {
    minX = Math.min(minX, values[i]);
    maxX = Math.max(maxX, values[i]);
    minY = Math.min(minY, values[i + 1]);
    maxY = Math.max(maxY, values[i + 1]);
  }
  ink = minX <= maxX ? [minX, minY, maxX, maxY] : null;
  inks.set(outline, ink);
  return ink;
}

/** The ink box of glyphs set from (x, baseline), or null when none has ink. */
function glyphsBox(glyphs: readonly PlacedGlyph[], x: number, baseline: number, scale: number): Box | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const g of glyphs) {
    const ink = inkOf(g.glyph);
    if (!ink) continue;
    left = Math.min(left, x + g.x + ink[0] * scale);
    right = Math.max(right, x + g.x + ink[2] * scale);
    top = Math.min(top, baseline - ink[3] * scale);
    bottom = Math.max(bottom, baseline - ink[1] * scale);
  }
  return left <= right ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** Ink boxes of the first `count` characters of a layout, a box a line, as traceText draws them at (0, top). */
export function layoutInk(layout: TextLayout, top: number, count = Infinity): Box[] {
  const out: Box[] = [];
  let left = count;
  for (const line of layout.lines) {
    if (left <= 0) break;
    const glyphs = line.glyphs.slice(0, Math.max(0, left));
    left -= line.glyphs.length;
    const box = glyphsBox(glyphs, line.x, top + line.baseline, layout.scale);
    if (box) out.push(box);
  }
  return out;
}

// ---- the walk ----

const isSpace = (c: string) => /\s/.test(c);
export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const scaleOf = (m: Affine) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** Caption layouts by their words and options, so a walk over every frame lays a cue out once. */
type CaptionCache = WeakMap<readonly SpokenWord[], Map<string, CaptionLayout>>;

interface Walk {
  registry: RigRegistry;
  world: World;
  captions: CaptionCache;
  out: TextMark[];
}

/** What a layer's mark inherits from where it sits: its path and owner, and the clips cutting it. */
type Base = Pick<TextMark, 'path' | 'owner' | 'top' | 'area' | 'clips'>;

function textMark(params: Record<string, unknown>, base: Base, m: Affine, opacity: number): TextMark | null {
  const b = textBlock(params as never);
  const fill = b.fill ?? b.stroke;
  const chars = [...b.content].filter((c) => c !== '\n' && c !== '\r');
  if (fill === null || b.opacity <= 0 || b.count <= 0 || chars.length === 0) return null;
  const lines = layoutInk(b.layout, b.top, b.count);
  if (lines.length === 0) return null;
  const transform = multiply(m, multiply(translate(b.x, b.y), multiply(rotation(b.rotation), scaling(b.scale))));
  const scale = scaleOf(transform);
  return {
    ...base,
    rig: 'text',
    text: b.content,
    complete: b.count >= chars.length || chars.slice(b.count).every(isSpace),
    opacity: opacity * b.opacity,
    // An outline with no fill is the text's colour, with nothing around it.
    fills: [fill],
    stroke: b.fill !== null ? b.stroke : null,
    strokeWidth: b.fill !== null && b.stroke !== null ? b.strokeWidth * scale : 0,
    size: b.layout.scale * b.face.unitsPerEm * scale,
    lines,
    transform,
    box: boundsOf(lines, transform),
  };
}

function captionMark(params: Record<string, unknown>, scene: Scene, t: number, walk: Walk, base: Base, m: Affine, opacity: number): TextMark | null {
  const words = sceneWords(scene, String(params.cue));
  const alpha = Number(params.opacity);
  if (words.length === 0 || !(alpha > 0)) return null;
  const [width, height] = stageSize(scene);
  const options = {
    font: String(params.font),
    size: Number(params.size),
    lines: Math.round(Number(params.lines)),
    width: Number(params.width),
    position: String(params.position) as CaptionPosition,
    offsetX: Number(params.offsetX),
    offsetY: Number(params.offsetY),
    letterCase: String(params.case) as CaptionCase,
  };
  const key = JSON.stringify([options, width, height]);
  let byWords = walk.captions.get(words);
  if (!byWords) walk.captions.set(words, (byWords = new Map()));
  let layout = byWords.get(key);
  if (!layout) byWords.set(key, (layout = layoutCaptions(words, options, { width, height })));
  const page = layout.pages.find((c) => t >= c.start - 1e-9 && t < c.end);
  if (!page) return null;
  const style = String(params.style);
  const shown = style === 'pop-in' ? page.words.filter((w) => w.word.start <= t + 1e-9) : page.words;
  if (shown.length === 0) return null;
  // A word box a word: a page's lines are words side by side, and a box per word is as exact and simpler.
  const lines = shown.map((w) => (layout.pixel ? { x: w.x, y: w.top, width: w.width, height: w.height } : (glyphsBox(w.glyphs, w.x, w.baseline, layout.scale) ?? { x: w.x, y: w.top, width: 0, height: 0 })));
  const stroke = String(params.stroke);
  const strokeWidth = Number(params.strokeWidth);
  const outlined = !layout.pixel && strokeWidth > 0 && stroke !== 'none' && stroke !== 'transparent' && stroke !== '';
  const scale = scaleOf(m);
  return {
    ...base,
    rig: 'captions',
    text: page.words.map((w) => w.text).join(' '),
    complete: shown.length === page.words.length,
    opacity: opacity * alpha,
    fills: style === 'line' ? [String(params.color)] : [String(params.color), String(params.highlight)],
    stroke: outlined ? stroke : null,
    strokeWidth: outlined ? strokeWidth * scale : 0,
    size: (layout.pixel ? shown[0].height : layout.size) * scale,
    lines,
    transform: m,
    box: boundsOf(lines, m),
  };
}

function walkScene(scene: Scene, frame: number, m: Affine, opacity: number, prefix: string, depth: number, walk: Walk, area: Box, clips: Clip[]): void {
  const pixel = scene.pixel?.scale ?? 1;
  const [width, height] = stageSize(scene);
  for (const layer of sceneLayers(scene)) {
    const path = prefix + layer.id;
    if (layer.scene !== undefined) {
      const shot = walk.world.scenes?.get(layer.scene);
      if (!shot || depth >= MAX_SCENE_DEPTH) continue;
      const at = shotFrame(sceneLayerSpan(layer, scene, shot), frame);
      if (at === null) continue;
      const place = scenePlacement(layer, scene, frame);
      if (place.opacity <= 0) continue;
      const [w, h] = scene.size;
      const [sw, sh] = shot.size;
      // As drawSceneLayer places it: centred, moved, turned and scaled about its middle.
      if (isIdentityPlacement(place) && sw === w && sh === h) {
        walkScene(shot, at, m, opacity * place.opacity, `${path}/`, depth + 1, walk, area, clips);
        continue;
      }
      const placed = multiply(m, multiply(translate(w / 2 + place.x, h / 2 + place.y), multiply(rotation((place.rotation * Math.PI) / 180), multiply(scaling(place.scale), translate(-sw / 2, -sh / 2)))));
      const inverse = invert(placed);
      if (!inverse) continue; // scaled to nothing
      const stage = { x: 0, y: 0, width: sw, height: sh };
      walkScene(shot, at, placed, opacity * place.opacity, `${path}/`, depth + 1, walk, intersect(area, boundsOf([stage], placed)), [...clips, { inverse, width: sw, height: sh }]);
      continue;
    }
    if (layer.file !== undefined) continue;
    let resolved;
    try {
      resolved = resolveLayer(layer, scene, frame, walk.registry, walk.world);
    } catch {
      continue; // the validator's to report
    }
    const id = resolved.rig.id;
    if (id !== 'text' && id !== 'captions') continue;
    // As drawLayer and drawResolved place it: the pixel stage's blow-up, then the camera.
    let local = multiply(m, scaling(pixel));
    const view = cameraView(scene, layer, frame);
    if (view) local = multiply(local, multiply(translate(width / 2, height / 2), multiply(scaling(view.zoom), translate(-width / 2 - view.x, -height / 2 - view.y))));
    const base: Base = { path, owner: { scene: scene.id, layer: layer.id }, top: depth === 0, area, clips };
    const mark = id === 'text' ? textMark(resolved.params, base, local, opacity) : captionMark(resolved.params, scene, resolved.t, walk, base, local, opacity);
    const seen = mark && intersect(mark.box, area);
    if (mark && seen && seen.width > 0 && seen.height > 0) walk.out.push(mark);
  }
}

/** The text on one frame of `scene`, back to front. */
export function textMarks(scene: Scene, frame: number, registry: RigRegistry, world: World = {}, captions: CaptionCache = new WeakMap()): TextMark[] {
  const walk: Walk = { registry, world, captions, out: [] };
  walkScene(scene, frame, IDENTITY, 1, '', 0, walk, { x: 0, y: 0, width: scene.size[0], height: scene.size[1] }, []);
  return walk.out;
}

/** One appearance of a text layer: a run of frames showing the same text. */
export interface Appearance {
  path: string;
  text: string;
  rig: TextMark['rig'];
  top: boolean;
  /** Consecutive frames, in order. */
  frames: { frame: number; mark: TextMark }[];
}

/** Every appearance of text in the whole scene, in the order they start. Arithmetic only, so it walks every frame. */
export function textAppearances(scene: Scene, registry: RigRegistry, world: World = {}): Appearance[] {
  const captions: CaptionCache = new WeakMap();
  const open = new Map<string, Appearance>();
  const out: Appearance[] = [];
  const total = frameCount(scene);
  for (let frame = 0; frame < total; frame++) {
    const seen = new Set<string>();
    for (const mark of textMarks(scene, frame, registry, world, captions)) {
      const key = `${mark.path}\u0000${mark.text}`;
      if (seen.has(key)) continue; // a scene placed twice at once shows the same layer twice; one is enough
      seen.add(key);
      const current = open.get(key);
      if (current && current.frames[current.frames.length - 1].frame === frame - 1) {
        current.frames.push({ frame, mark });
        continue;
      }
      const next: Appearance = { path: mark.path, text: mark.text, rig: mark.rig, top: mark.top, frames: [{ frame, mark }] };
      open.set(key, next);
      out.push(next);
    }
  }
  return out;
}

/**
 * The scene and world with one text layer taken out, to see what's behind it. A layer inside a clip comes out of
 * the scene the clip places, so every clip of that scene loses it.
 */
export function withoutLayer(scene: Scene, world: World, mark: Pick<TextMark, 'owner' | 'top'>): { scene: Scene; world: World } {
  const strip = (s: Scene): Scene => {
    if (mark.owner.layer === BACKGROUND_ID) {
      const { background: _gone, ...rest } = s;
      return rest;
    }
    return { ...s, layers: s.layers.filter((l) => l.id !== mark.owner.layer) };
  };
  if (mark.top) return { scene: strip(scene), world };
  const placed = world.scenes?.get(mark.owner.scene);
  if (!placed || !world.scenes) return { scene, world };
  return { scene, world: { ...world, scenes: new Map(world.scenes).set(mark.owner.scene, strip(placed)) } };
}
