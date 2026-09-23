import { describe, expect, it } from 'vitest';
import { fitContain } from './canvas';

describe('fitContain', () => {
  it('fits by width when the box is wider than the scene', () => {
    const fit = fitContain(1000, 1000, 1920, 1080, 1);
    expect(fit.backingWidth).toBe(1000);
    expect(fit.backingHeight).toBe(563); // round(562.5)
    expect(fit.scale).toBeCloseTo(1000 / 1920);
  });

  it('fits by height when the box is taller than the scene', () => {
    const fit = fitContain(2000, 540, 1920, 1080, 1);
    expect(fit.backingWidth).toBe(960);
    expect(fit.backingHeight).toBe(540);
    expect(fit.cssWidth).toBe(960);
  });

  it('sizes the backing store for devicePixelRatio and keeps css = backing / dpr', () => {
    const fit = fitContain(960, 540, 1920, 1080, 2);
    expect(fit.backingWidth).toBe(1920);
    expect(fit.backingHeight).toBe(1080);
    expect(fit.cssWidth).toBe(960);
    expect(fit.cssHeight).toBe(540);
    expect(fit.scale).toBe(1);
  });

  it('rounds the backing store and derives scale from backing width', () => {
    const fit = fitContain(333.3, 999, 1280, 720, 1.5);
    expect(fit.backingWidth).toBe(Math.round(333.3 * 1.5));
    expect(fit.scale).toBe(fit.backingWidth / 1280);
    expect(fit.cssWidth).toBe(fit.backingWidth / 1.5);
  });

  it('returns a zero fit for an unmeasured box or missing scene', () => {
    expect(fitContain(0, 500, 1920, 1080, 2).backingWidth).toBe(0);
    expect(fitContain(500, 500, 0, 0, 2).scale).toBe(0);
  });

  it('treats a bad dpr as 1', () => {
    expect(fitContain(960, 540, 1920, 1080, Number.NaN).backingWidth).toBe(960);
  });
});
