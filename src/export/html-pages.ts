// HTML layers (ADR 0021), for the viewer and the render worker: loads a page
// from the studio folder's html/ in a sandboxed iframe inside a
// <canvas layoutsubtree>, and draws it to an image with Chromium's
// HTML-in-Canvas API (drawElementImage). The engine never sees the document:
// PictureStore hands render() the image, as it does a decoded picture.
//
// What the spike measured in Electron 44.4.5 (Chromium 152) and 45.3.3
// (Chromium 156), and this file relies on:
// - The API exists only with --enable-blink-features=CanvasDrawElement.
// - A same-origin iframe paints. Cross-origin images in it don't, so pages
//   are served from our own origin with what they use beside them.
// - The page is rasterized at the device's scale, and the pixels differ
//   between a 1x and a 2x display. Zooming the iframe by 1 / devicePixelRatio
//   gives the same bytes on both.
// - A draw before the first paint, or of a canvas that is off-screen or at
//   opacity 0, succeeds and draws nothing. So the canvas sits in the viewport,
//   clipped away and behind the page, and every draw waits for a paint.
// - Taking the canvas out of the document in the same turn as a draw crashes
//   the renderer (Chromium 153). So a page that is let go leaves after its
//   next paint, never at once.
// Browser only. Never imported by the runtime.

import type { HtmlRequest, Picture } from '../engine';
import { htmlPageKey } from '../engine';

/** The canvas method this file needs, which TypeScript's DOM types don't know yet. */
interface DrawsElements {
  drawElementImage(element: Element, dx: number, dy: number, dwidth?: number, dheight?: number): void;
}
interface PaintsChildren {
  requestPaint(): void;
}

/** An element of a page, as a selection names it. */
export interface HtmlElement {
  /** A selector that finds this element alone in its page. */
  selector: string;
  /** For people: its tag, and the start of its text. */
  label: string;
  /** Its border box in the page's CSS pixels, after any offset. */
  box: { x: number; y: number; width: number; height: number };
  /** Its top-left corner radius, in the same pixels. */
  radius: number;
}

/** How a layer sits on the stage, as scenePlacement gives it. */
interface Placement {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** A scene pixel in the page's own pixels, undoing the layer's placement. Null for a layer scaled to nothing. */
export function pagePoint(place: Placement, size: readonly [number, number], x: number, y: number): { x: number; y: number } | null {
  if (place.scale === 0) return null;
  const [w, h] = size;
  const turn = (-place.rotation * Math.PI) / 180;
  const dx = x - (w / 2 + place.x);
  const dy = y - (h / 2 + place.y);
  return { x: (dx * Math.cos(turn) - dy * Math.sin(turn)) / place.scale + w / 2, y: (dx * Math.sin(turn) + dy * Math.cos(turn)) / place.scale + h / 2 };
}

/** An element's box in scene pixels: the bounds of its corners once the layer is placed, with its corner radius. */
export function sceneBox(place: Placement, size: readonly [number, number], element: Pick<HtmlElement, 'box' | 'radius'>): { x: number; y: number; width: number; height: number; radius: number } {
  const [w, h] = size;
  const turn = (place.rotation * Math.PI) / 180;
  const { x, y, width, height } = element.box;
  const corners = [
    [x, y],
    [x + width, y],
    [x, y + height],
    [x + width, y + height],
  ].map(([cx, cy]) => {
    const dx = (cx - w / 2) * place.scale;
    const dy = (cy - h / 2) * place.scale;
    return [dx * Math.cos(turn) - dy * Math.sin(turn) + w / 2 + place.x, dx * Math.sin(turn) + dy * Math.cos(turn) + h / 2 + place.y];
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), radius: element.radius * place.scale };
}

const WHY_NOT =
  "This browser can't draw HTML layers. They need Chromium's HTML-in-Canvas API, which the Frame Studio app turns on (ADR 0021). Open the project in the app.";
/** A page has this long to load its stylesheets, fonts and images. */
const LOAD_MS = 20_000;
/** A paint that doesn't come in this long isn't coming: the canvas is somewhere Chromium doesn't paint. */
const PAINT_MS = 3_000;

/** Whether this browser can draw an element into a canvas. */
export function drawsHtml(): boolean {
  return typeof CanvasRenderingContext2D !== 'undefined' && 'drawElementImage' in CanvasRenderingContext2D.prototype && 'requestPaint' in HTMLCanvasElement.prototype;
}

/** Stops whatever would make a page look different from one moment to the next. Scripts never run: the iframe is sandboxed. */
const STILL_CSS = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

const escapeId = (text: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(text) : text.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

/**
 * A selector for `el` that matches it alone: its id when it has one of its own, else the shortest tail of
 * tag-and-class steps from the body that is unique, with :nth-child where siblings look alike.
 */
export function selectorFor(el: Element): string {
  const doc = el.ownerDocument;
  const only = (selector: string) => {
    try {
      const found = doc.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  };
  if (el.id && only(`#${escapeId(el.id)}`)) return `#${escapeId(el.id)}`;
  const steps: string[] = [];
  for (let node: Element | null = el; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (node !== el && node.id && doc.querySelectorAll(`#${escapeId(node.id)}`).length === 1) {
      steps.unshift(`#${escapeId(node.id)}`);
      break;
    }
    const classes = [...node.classList].slice(0, 3).map((c) => `.${escapeId(c)}`);
    let step = `${node.tagName.toLowerCase()}${classes.join('')}`;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const alike = [...parent.children].filter((child) => child.matches(step));
      if (alike.length > 1) step += `:nth-child(${[...parent.children].indexOf(node) + 1})`;
    }
    steps.unshift(step);
    if (only(steps.join(' > '))) return steps.join(' > ');
  }
  return steps.join(' > ');
}

function labelFor(el: Element): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const tag = el.tagName.toLowerCase();
  return text ? `${tag} "${text.length > 28 ? `${text.slice(0, 27)}…` : text}"` : tag;
}

/**
 * Takes a page's canvas out of the document once Chromium has painted it again. Removing it in the turn it
 * was drawn from crashes the renderer, so it goes after its next paint, or after a second if none comes.
 */
function retire(canvas: HTMLCanvasElement): void {
  let gone = false;
  const remove = () => {
    if (gone) return;
    gone = true;
    canvas.remove();
  };
  canvas.addEventListener('paint', () => setTimeout(remove, 50), { once: true });
  setTimeout(remove, 1000);
  try {
    (canvas as unknown as PaintsChildren).requestPaint();
  } catch {
    // No such method here, so nothing was ever drawn from it; the timer removes it.
  }
}

interface Page {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D & Partial<DrawsElements>;
  frame: HTMLIFrameElement;
  doc: Document;
  width: number;
  height: number;
  /** The selectors that carry an offset now, so the next draw can put back the ones it drops. */
  moved: Map<string, HTMLElement>;
}

export class HtmlPages {
  private readonly url: (file: string) => string;
  private readonly pages = new Map<string, Promise<Page>>();
  private readonly ready = new Map<string, Page>();

  constructor(url: (file: string) => string) {
    this.url = url;
  }

  /** The page drawn at its size with its offsets applied, as a picture for render(). */
  async draw(request: HtmlRequest): Promise<Picture> {
    if (!drawsHtml()) throw new Error(WHY_NOT);
    const page = await this.page(request);
    this.move(page, request);
    const out = new OffscreenCanvas(request.width, request.height);
    const ctx = out.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!ctx) throw new Error('This browser did not provide an offscreen 2D context.');
    // Twice at most: a first paint can land before the fonts it waits on have been swapped in.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.painted(page);
      page.ctx.clearRect(0, 0, request.width, request.height);
      (page.ctx as unknown as DrawsElements).drawElementImage(page.frame, 0, 0, request.width, request.height);
      ctx.clearRect(0, 0, request.width, request.height);
      ctx.drawImage(page.canvas, 0, 0);
      if (!this.blank(ctx, request.width, request.height)) return { image: out, width: request.width, height: request.height };
    }
    throw new Error(`${request.file} drew nothing. A page needs something painted, such as a background on its body, and a stage Chromium can paint in one piece.`);
  }

  /** The element at a point of the page, in its CSS pixels, or null over nothing but the page itself. Needs the page drawn once. */
  elementAt(request: HtmlRequest, x: number, y: number): HtmlElement | null {
    const page = this.ready.get(htmlPageKey(request));
    if (!page) return null;
    const el = page.doc.elementFromPoint(x, y);
    if (!el || el === page.doc.documentElement || el === page.doc.body) return null;
    return this.describe(el);
  }

  /** The element a selector names in a page, or null when it names none or the page hasn't been drawn. */
  element(request: HtmlRequest, selector: string): HtmlElement | null {
    const page = this.ready.get(htmlPageKey(request));
    if (!page) return null;
    try {
      const el = page.doc.querySelector(selector);
      return el ? this.describe(el) : null;
    } catch {
      return null;
    }
  }

  private describe(el: Element): HtmlElement {
    const r = el.getBoundingClientRect();
    const radius = Number.parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).borderTopLeftRadius ?? '0') || 0;
    return { selector: selectorFor(el), label: labelFor(el), box: { x: r.left, y: r.top, width: r.width, height: r.height }, radius: Math.min(radius, r.width / 2, r.height / 2) };
  }

  /** Lets go of every page. The next draw loads them again, so an edited file shows. */
  dispose(): void {
    const pending = [...this.pages.values()];
    this.pages.clear();
    this.ready.clear();
    for (const held of pending) void held.then((page) => retire(page.canvas)).catch(() => {});
  }

  private page(request: HtmlRequest): Promise<Page> {
    const key = htmlPageKey(request);
    let held = this.pages.get(key);
    if (!held) {
      held = this.load(request).then((page) => {
        // A dispose while it loaded means the file may have changed.
        if (this.pages.get(key) !== held) {
          retire(page.canvas);
          throw new Error(`${request.file} changed while it loaded.`);
        }
        this.ready.set(key, page);
        return page;
      });
      this.pages.set(key, held);
      held.catch(() => {
        if (this.pages.get(key) === held) this.pages.delete(key);
      });
    }
    return held;
  }

  private async load(request: HtmlRequest): Promise<Page> {
    const { width, height } = request;
    // One device pixel per CSS pixel of the page, whatever the display, so a 2x screen draws what a 1x one does.
    const zoom = 1 / (window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    // Chromium up to 156 opts in with layoutsubtree. The explainer has since renamed it, so both are set.
    canvas.setAttribute('layoutsubtree', '');
    canvas.setAttribute('content', 'drawable');
    canvas.setAttribute('aria-hidden', 'true');
    // In the viewport, or Chromium paints nothing: clipped away and behind the page instead of off-screen.
    canvas.style.cssText = `position:fixed;left:0;top:0;width:${width * zoom}px;height:${height * zoom}px;z-index:-2147483647;clip-path:inset(50%);pointer-events:none;`;
    const frame = document.createElement('iframe');
    // No scripts, forms or popups. Same origin stays, so the host can read the document.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('drawable', '');
    frame.setAttribute('tabindex', '-1');
    frame.style.cssText = `width:${width}px;height:${height}px;border:0;display:block;zoom:${zoom};`;
    canvas.append(frame);
    document.body.append(canvas);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${request.file} took over ${LOAD_MS / 1000} s to load.`)), LOAD_MS);
        frame.addEventListener('load', () => (clearTimeout(timer), resolve()), { once: true });
        frame.addEventListener('error', () => (clearTimeout(timer), reject(new Error(`${request.file} could not be loaded.`))), { once: true });
        frame.src = this.url(request.file);
      });
      const doc = frame.contentDocument;
      // A missing page is the server's error page, which says so in its title.
      if (!doc || doc.title === 'frame-studio:missing') throw new Error(`${request.file} isn't in the studio folder.`);
      const style = doc.createElement('style');
      style.textContent = STILL_CSS;
      (doc.head ?? doc.documentElement).append(style);
      await Promise.race([
        (async () => {
          await doc.fonts.ready;
          await Promise.all(
            [...doc.images].map((img) =>
              img.complete
                ? null
                : new Promise<void>((resolve) => {
                    img.addEventListener('load', () => resolve(), { once: true });
                    // A missing image leaves its box empty, as it does in a browser.
                    img.addEventListener('error', () => resolve(), { once: true });
                  }),
            ),
          );
          await doc.fonts.ready;
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`${request.file}'s fonts and images took over ${LOAD_MS / 1000} s to load.`)), LOAD_MS)),
      ]);
      const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
      return { canvas, ctx, frame, doc, width, height, moved: new Map() };
    } catch (err) {
      retire(canvas);
      throw err;
    }
  }

  /** Puts each moved element where its offset says, and back where the page has it when its offset is gone. */
  private move(page: Page, request: HtmlRequest): void {
    for (const [selector, el] of page.moved) {
      if (!(selector in request.offsets)) {
        el.style.removeProperty('translate');
        page.moved.delete(selector);
      }
    }
    for (const [selector, [x, y]] of Object.entries(request.offsets)) {
      let el = page.moved.get(selector);
      if (!el) {
        try {
          el = (page.doc.querySelector(selector) as HTMLElement | null) ?? undefined;
        } catch {
          el = undefined;
        }
        // A selector that finds nothing moves nothing: the page changed under it, and check says so.
        if (!el) continue;
        page.moved.set(selector, el);
      }
      el.style.setProperty('translate', `${x}px ${y}px`);
    }
  }

  /** Resolves after Chromium has painted the canvas's children, which is when their snapshot is current. */
  private painted(page: Page): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The page never painted. HTML layers draw in a window Chromium paints, which a minimized or occluded one may not be.')), PAINT_MS);
      page.canvas.addEventListener('paint', () => (clearTimeout(timer), resolve()), { once: true });
      (page.canvas as unknown as PaintsChildren).requestPaint();
    });
  }

  private blank(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): boolean {
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
    return true;
  }
}
