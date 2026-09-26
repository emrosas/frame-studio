// Canvas sizing for the preview. The canvas is displayed at a CSS size that fits
// the stage (contain), with a backing store sized for devicePixelRatio so the
// preview is sharp. Exports never go through this path; they render at native
// scene resolution.

export interface Fit {
  /** Displayed size in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Backing store size in device pixels. */
  backingWidth: number;
  backingHeight: number;
  /** Scene pixels to backing pixels: backingWidth / sceneWidth. */
  scale: number;
}

/**
 * Fits a scene of sceneW x sceneH into an availW x availH CSS box, keeping aspect.
 * Backing store is round(css * dpr). The CSS size is derived back from the
 * rounded backing size so one backing pixel maps to one device pixel.
 */
export function fitContain(availW: number, availH: number, sceneW: number, sceneH: number, dpr: number): Fit {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  if (!(availW > 0 && availH > 0 && sceneW > 0 && sceneH > 0)) {
    return { cssWidth: 0, cssHeight: 0, backingWidth: 0, backingHeight: 0, scale: 0 };
  }
  const k = Math.min(availW / sceneW, availH / sceneH);
  const backingWidth = Math.max(1, Math.round(sceneW * k * ratio));
  const backingHeight = Math.max(1, Math.round(sceneH * k * ratio));
  return {
    cssWidth: backingWidth / ratio,
    cssHeight: backingHeight / ratio,
    backingWidth,
    backingHeight,
    scale: backingWidth / sceneW,
  };
}

export function sameFit(a: Fit, b: Fit): boolean {
  return (
    a.backingWidth === b.backingWidth &&
    a.backingHeight === b.backingHeight &&
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight &&
    a.scale === b.scale
  );
}

/**
 * Owns the preview canvas inside a stage element. Watches the stage size and
 * devicePixelRatio, resizes the backing store, and calls onResize synchronously
 * (inside the ResizeObserver callback, before paint) so the caller can redraw
 * without a blank frame. The canvas goes into `host` (default: the stage), so
 * the viewer can stack an overlay in the same box.
 */
export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private sceneSize: [number, number] | null = null;
  private fit: Fit = fitContain(0, 0, 0, 0, 1);
  private avail = { width: 0, height: 0 };
  private readonly observer: ResizeObserver;
  private dprQuery: MediaQueryList | null = null;
  private watchedDpr = 0;
  private readonly onDprChange = () => this.refit();

  private readonly stage: HTMLElement;
  private readonly onResize: () => void;

  constructor(stage: HTMLElement, onResize: () => void, host: HTMLElement = stage) {
    this.stage = stage;
    this.onResize = onResize;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.hidden = true;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
    this.ctx = ctx;
    host.appendChild(this.canvas);

    this.observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      this.avail = { width: box.width, height: box.height };
      this.refit();
    });
    this.observer.observe(stage);
    this.watchDpr();
    this.measure();
  }

  /** Current backing-store fit (zero-sized until measured). For mapping pointer positions to scene pixels. */
  get currentFit(): Fit {
    return this.fit;
  }

  /** Sets the scene size to fit. Returns true when the backing store changed. */
  setSceneSize(size: readonly [number, number] | null): boolean {
    const next: [number, number] | null = size ? [size[0], size[1]] : null;
    const same = next && this.sceneSize && next[0] === this.sceneSize[0] && next[1] === this.sceneSize[1];
    if (same || (!next && !this.sceneSize)) return false;
    this.sceneSize = next;
    return this.applyFit();
  }

  /**
   * Draws one preview frame: clears the whole backing store, applies the
   * scene-to-backing scale, and calls draw with a context in scene pixels.
   * If draw throws, the context is reset (drops any unbalanced save()) and the
   * error is rethrown.
   */
  draw(draw: (ctx: CanvasRenderingContext2D) => void): boolean {
    const { ctx, fit } = this;
    if (fit.backingWidth === 0 || !this.sceneSize) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(fit.scale, 0, 0, fit.scale, 0, 0);
    try {
      draw(ctx);
    } catch (err) {
      this.resetContext();
      throw err;
    }
    return true;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private refit(): void {
    this.watchDpr();
    if (this.applyFit()) this.onResize();
  }

  private applyFit(): boolean {
    const [w, h] = this.sceneSize ?? [0, 0];
    const next = fitContain(this.avail.width, this.avail.height, w, h, window.devicePixelRatio || 1);
    if (sameFit(next, this.fit)) return false;
    this.fit = next;
    if (this.canvas.width !== next.backingWidth) this.canvas.width = next.backingWidth;
    if (this.canvas.height !== next.backingHeight) this.canvas.height = next.backingHeight;
    this.canvas.style.width = `${next.cssWidth}px`;
    this.canvas.style.height = `${next.cssHeight}px`;
    this.canvas.hidden = next.backingWidth === 0;
    return true;
  }

  /**
   * Synchronous first measurement, so a frame can render before the first
   * ResizeObserver callback (e.g. window.studio.renderFrame right after load).
   */
  private measure(): void {
    const style = getComputedStyle(this.stage);
    const width = this.stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = this.stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    this.avail = { width: Math.max(0, width || 0), height: Math.max(0, height || 0) };
  }

  /** Re-arms a media query for the current DPR (fires when moving between screens or zooming). */
  private watchDpr(): void {
    const dpr = window.devicePixelRatio || 1;
    if (this.dprQuery && dpr === this.watchedDpr) return;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.watchedDpr = dpr;
    this.dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  /** Assigning width resets all context state, including the save() stack. */
  private resetContext(): void {
    const width = this.canvas.width;
    this.canvas.width = width;
  }
}
