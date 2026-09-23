// URL state: ?scene=<id>&frame=<n>&layer=<id>&part=<id>&from=<n>&to=<n>.
// A reload (manual, or Vite's full-reload fallback) lands on the same scene,
// frame and selection.

import { clampFrame } from './clock';
import { parseFrameText } from './selection';

/** The selection's URL params, in the order they are written after scene and frame. */
const SELECTION_KEYS = ['layer', 'part', 'from', 'to'] as const;
type SelectionKey = (typeof SELECTION_KEYS)[number];

/** Raw URL values. Each is null when absent. */
export interface UrlState {
  scene: string | null;
  frame: string | null;
  layer: string | null;
  part: string | null;
  from: string | null;
  to: string | null;
}

/**
 * What the viewer writes. frame, from and to may be raw strings: a value the
 * viewer could not resolve yet (its scene is invalid) stays as written.
 * Selection fields left out or null are removed from the URL.
 */
export interface UrlPosition {
  scene: string | null;
  frame: number | string | null;
  layer?: string | null;
  part?: string | null;
  from?: number | string | null;
  to?: number | string | null;
}

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  return {
    scene: params.get('scene'),
    frame: params.get('frame'),
    layer: params.get('layer'),
    part: params.get('part'),
    from: params.get('from'),
    to: params.get('to'),
  };
}

/** sessionStorage key: the scene, frame and selection on screen when the page was last hidden. */
export const RELOAD_KEY = 'frame-studio:reload-position';

/** The value pagehide stores under RELOAD_KEY. Every field is written, null when unset. */
export function reloadRecord(pos: UrlPosition): string {
  return JSON.stringify({
    scene: pos.scene,
    frame: pos.frame,
    layer: pos.layer ?? null,
    part: pos.part ?? null,
    from: pos.from ?? null,
    to: pos.to ?? null,
  });
}

/**
 * The URL state to boot with. Chromium fixes a reload's URL before pagehide
 * runs, so a throttled URL write still waiting at that moment is lost and the
 * reload would land a few frames back. On a reload, the frame and selection
 * stored at pagehide win when they are for the scene in the URL. A selection
 * field the record lacks (an older record) keeps the URL's value.
 */
export function bootUrlState(url: UrlState, stored: string | null, navigationType: string | undefined): UrlState {
  if (navigationType !== 'reload' || stored === null || url.scene === null) return url;
  let record: unknown;
  try {
    record = JSON.parse(stored);
  } catch {
    return url;
  }
  const fields = (typeof record === 'object' && record !== null ? record : {}) as Record<string, unknown>;
  const { scene, frame } = fields;
  if (scene !== url.scene || !(typeof frame === 'number' || typeof frame === 'string')) return url;
  const out: UrlState = { ...url, frame: String(frame) };
  for (const key of SELECTION_KEYS) {
    if (!(key in fields)) continue;
    const value = fields[key];
    if (value === null) out[key] = null;
    else if (typeof value === 'string' || typeof value === 'number') out[key] = String(value);
  }
  return out;
}

/**
 * Resolves a ?frame= value: a frame number, or an MM:SS:FF timecode.
 * Returns null when absent or unreadable. The result is clamped into the scene.
 */
export function parseFrameParam(raw: string | null, fps: number, frameCount: number): number | null {
  if (raw === null) return null;
  const parsed = parseFrameText(raw, fps);
  return parsed.ok ? clampFrame(parsed.frame, frameCount) : null;
}

/**
 * Same-document URL with scene, frame and selection set (null or absent
 * removes the param). Other params and the hash are kept. frame may be a raw
 * string: an unresolved ?frame= stays as written until its scene is valid.
 */
export function urlWith(href: string, pos: UrlPosition): string {
  const url = new URL(href);
  const put = (key: 'scene' | 'frame' | SelectionKey, value: string | number | null | undefined) => {
    if (value === null || value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  };
  put('scene', pos.scene);
  put('frame', pos.frame);
  for (const key of SELECTION_KEYS) put(key, pos[key]);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Writes URL state with history.replaceState, throttled. Browsers rate-limit
 * replaceState (Safari allows about 100 calls per 30 s), and playback changes
 * the frame many times a second.
 */
export class UrlSync {
  private pending: UrlPosition | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = -Infinity;

  constructor(private readonly minIntervalMs = 400) {}

  request(pos: UrlPosition): void {
    this.pending = pos;
    if (this.timer !== null) return;
    const wait = this.lastWrite + this.minIntervalMs - performance.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Writes any pending state now (call before a reload). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const next = urlWith(location.href, this.pending);
    this.pending = null;
    if (next === `${location.pathname}${location.search}${location.hash}`) return;
    history.replaceState(history.state, '', next);
    this.lastWrite = performance.now();
  }
}
