import { describe, expect, it } from 'vitest';
import { clientToScene, isDrag, sceneToBox } from './pointer';

describe('clientToScene', () => {
  it('maps CSS pixels to scene pixels through the box scale', () => {
    // A 1920x1080 scene shown at 960x540 CSS px, 100 px from the left and 50 px from the top.
    const rect = { left: 100, top: 50, width: 960, height: 540 };
    expect(clientToScene(100, 50, rect, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(clientToScene(580, 320, rect, 1920, 1080)).toEqual({ x: 960, y: 540 });
    expect(clientToScene(100.25, 50.75, rect, 1920, 1080)).toEqual({ x: 0.5, y: 1.5 });
  });

  it('does not depend on the backing store (devicePixelRatio)', () => {
    // fitContain rounds each backing axis on its own, so at a fractional dpr the CSS box
    // (backing / dpr) can be a hair off the scene aspect. Contain keeps the centre on the centre.
    const rect = { left: 0, top: 0, width: 772.5, height: 434.5 };
    const p = clientToScene(386.25, 217.25, rect, 1920, 1080);
    expect(p?.x).toBeCloseTo(960, 9);
    expect(p?.y).toBeCloseTo(540, 9);
  });

  it('letterboxes when the box aspect differs from the scene (centred, contain)', () => {
    // A 1080x1920 portrait scene in a 1000x1000 box: scale 1000/1920, 218.75 px bars left and right.
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    const k = 1000 / 1920;
    const bar = (1000 - 1080 * k) / 2;
    const corner = clientToScene(bar, 0, rect, 1080, 1920);
    expect(corner?.x).toBeCloseTo(0, 9);
    expect(corner?.y).toBeCloseTo(0, 9);
    const mid = clientToScene(500, 500, rect, 1080, 1920);
    expect(mid?.x).toBeCloseTo(540, 9);
    expect(mid?.y).toBeCloseTo(960, 9);
    // Inside the bars is outside the scene.
    expect(clientToScene(bar - 1, 500, rect, 1080, 1920)).toBeNull();
    expect(clientToScene(1000 - bar + 1, 500, rect, 1080, 1920)).toBeNull();
    // A landscape scene in a tall box gets bars top and bottom.
    const tall = { left: 10, top: 20, width: 400, height: 400 };
    const top = (400 - 1080 * (400 / 1920)) / 2;
    const origin = clientToScene(10, 20 + top, tall, 1920, 1080);
    expect(origin?.x).toBeCloseTo(0, 9);
    expect(origin?.y).toBeCloseTo(0, 9);
    expect(clientToScene(10, 20 + top - 1, tall, 1920, 1080)).toBeNull();
  });

  it('treats the far edges as outside: scene pixels are [0, width) x [0, height)', () => {
    const rect = { left: 0, top: 0, width: 192, height: 108 };
    expect(clientToScene(192, 50, rect, 1920, 1080)).toBeNull();
    expect(clientToScene(50, 108, rect, 1920, 1080)).toBeNull();
    expect(clientToScene(-0.01, 50, rect, 1920, 1080)).toBeNull();
    expect(clientToScene(191.99, 107.99, rect, 1920, 1080)).not.toBeNull();
  });

  it('returns null for an unmeasured box or an empty scene', () => {
    expect(clientToScene(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 1920, 1080)).toBeNull();
    expect(clientToScene(0, 0, { left: 0, top: 0, width: 100, height: 100 }, 0, 1080)).toBeNull();
  });
});

describe('sceneToBox', () => {
  it('inverts clientToScene relative to the box', () => {
    const rect = { left: 30, top: 40, width: 1000, height: 1000 };
    for (const [x, y] of [
      [0, 0],
      [540, 960],
      [1079, 1919],
      [12.5, 700.25],
    ]) {
      const box = sceneToBox(x, y, rect.width, rect.height, 1080, 1920);
      const back = clientToScene(rect.left + box.x, rect.top + box.y, rect, 1080, 1920);
      expect(back?.x).toBeCloseTo(x, 9);
      expect(back?.y).toBeCloseTo(y, 9);
    }
  });
});

describe('isDrag', () => {
  it('is a drag only when the pointer moved more than the tolerance', () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 14, y: 11 })).toBe(true);
    expect(isDrag({ x: 10, y: 10 }, { x: 30, y: 10 }, 25)).toBe(false);
  });
});
