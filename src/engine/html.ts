// HTML layers (ADR 0021): a still can show an HTML page from the studio
// folder's html/. The engine never loads or lays out a document. Like picture
// clips (ADR 0014), the host reads what a frame needs from picturesAt, draws
// the page to an image, and render() takes that image from world.pictures.
// What the page looks like is the host's Chromium's to decide, so pixels hold
// per Electron build.

import { MAX_SCENE_DEPTH } from './scene-layer';
import type { Layer, Scene, World } from './types';

/** A hand's move of one element of the page, in the page's CSS pixels: selector to [x, y]. */
export type HtmlOffsets = Readonly<Record<string, readonly [number, number]>>;

/** What a host draws for an html layer: the page, the size it lays out at, and the elements moved by hand. */
export interface HtmlRequest {
  /** The page, as the layer names it: "html/launch/1.html". */
  file: string;
  width: number;
  height: number;
  offsets: HtmlOffsets;
}

/** A path the validator accepts for a page: inside html/, relative, an .html file, with no "..", "." or empty segments, nor backslashes. */
export function isHtmlPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('html/') || value.length > 300 || value.includes('\\')) return false;
  if (!/\.html?$/i.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The page a layer shows, at the stage's size, or null when it isn't an html layer. */
export function htmlRequest(layer: Pick<Layer, 'html' | 'offsets'>, scene: Pick<Scene, 'size'>): HtmlRequest | null {
  if (layer.html === undefined) return null;
  return { file: layer.html, width: scene.size[0], height: scene.size[1], offsets: layer.offsets ?? {} };
}

/** Splits a page's name from what was moved on it, in an htmlKey. */
const MOVED = '#moved:';

/** The page at its size, without what was moved: the name a host keeps the page's last drawing under. */
export function htmlPageKey(request: Pick<HtmlRequest, 'file' | 'width' | 'height'>): string {
  return `${request.file}@${request.width}x${request.height}`;
}

/**
 * The name the drawn page goes under in world.pictures. Everything that changes its pixels is in it, so a
 * moved element is another picture, and the one before it stays on screen until the new one is drawn.
 */
export function htmlKey(request: HtmlRequest): string {
  const moved = Object.keys(request.offsets)
    .sort()
    .map((selector) => [selector, request.offsets[selector][0], request.offsets[selector][1]]);
  return `${htmlPageKey(request)}${moved.length > 0 ? `${MOVED}${JSON.stringify(moved)}` : ''}`;
}

/** The page a key belongs to, as htmlPageKey names it. A file that isn't a page comes back as it is. */
export function htmlPageOf(key: string): string {
  const at = key.indexOf(MOVED);
  return at < 0 ? key : key.slice(0, at);
}

/** Every html page the scene shows, its placed scenes' included, sorted. */
export function htmlUsed(scene: Scene, world: World = {}, depth = 0): string[] {
  const files = new Set<string>();
  for (const layer of scene.layers) {
    if (layer.html !== undefined) files.add(layer.html);
    else if (layer.scene !== undefined && depth < MAX_SCENE_DEPTH) {
      const shot = world.scenes?.get(layer.scene);
      if (shot) for (const f of htmlUsed(shot, world, depth + 1)) files.add(f);
    }
  }
  return [...files].sort();
}
