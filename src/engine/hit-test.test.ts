/**
 * hitTest against a real raster. @napi-rs/canvas (Skia) is a dev dependency
 * used only by tests; runtime code never imports it.
 */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { hitTest, type HitResult, type HitTestOptions } from './hit-test';
import { createRegistry } from './registry';
import { drawLayer } from './render';
import { sceneLayers } from './resolve';
import { createRng } from './rng';
import { frameCount } from './time';
import type { Ctx2D, Layer, Params, Rig, Scene } from './types';

const W = 100;
const H = 100;

function newProbe(): Ctx2D {
  return createCanvas(1, 1).getContext('2d') as unknown as Ctx2D;
}

function newStage(): Ctx2D {
  return createCanvas(W, H).getContext('2d') as unknown as Ctx2D;
}

const n = (v: unknown) => Number(v);
const num = (value: number) => ({ type: 'number', default: value }) as const;

// ---------------------------------------------------------------- test rigs

const rectParams = { x: num(0), y: num(0), w: num(10), h: num(10), alpha: num(1), angle: num(0) };

function drawRect(ctx: Ctx2D, p: Params, dx = 0): void {
  ctx.globalAlpha = n(p.alpha);
  ctx.fillStyle = '#336699';
  const w = n(p.w);
  const h = n(p.h);
  ctx.translate(n(p.x) + dx + w / 2, n(p.y) + h / 2);
  ctx.rotate(n(p.angle));
  ctx.fillRect(-w / 2, -h / 2, w, h);
}

/** An axis-aligned rect (or rotated by angle, about its centre) at globalAlpha alpha. */
const rect: Rig = { id: 'rect', params: rectParams, draw: (ctx, p) => drawRect(ctx, p) };
/** A variant that draws 50 px to the right. */
const rectShifted: Rig = { id: 'rect.shifted', params: rectParams, draw: (ctx, p) => drawRect(ctx, p, 50) };

const disc: Rig = {
  id: 'disc',
  params: { cx: num(50), cy: num(50), r: num(10) },
  draw(ctx, p) {
    ctx.fillStyle = '#aa3300';
    ctx.beginPath();
    ctx.arc(n(p.cx), n(p.cy), n(p.r), 0, Math.PI * 2);
    ctx.fill();
  },
};

/** Fills the whole stage, from stage, like a background. */
const wash: Rig = {
  id: 'wash',
  params: {},
  draw(ctx, _p, _t, _rng, stage) {
    ctx.fillStyle = '#f4efe6';
    ctx.fillRect(0, 0, stage.width, stage.height);
  },
};

/** Fills the whole stage but clips to [40, 60) x [40, 60). */
const clipped: Rig = {
  id: 'clipped',
  params: {},
  draw(ctx) {
    ctx.beginPath();
    ctx.rect(40, 40, 20, 20);
    ctx.clip();
    ctx.fillStyle = '#00aa00';
    ctx.fillRect(0, 0, W, H);
  },
};

/** A 10 px square at (10, 10) whose hard shadow lands 30 px to the right. */
const shadowed: Rig = {
  id: 'shadowed',
  params: {},
  draw(ctx) {
    ctx.shadowColor = '#000000';
    ctx.shadowOffsetX = 30;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(10, 10, 10, 10);
  },
};

/** [40, 60) square, blurred by 4 px. */
const blurred: Rig = {
  id: 'blurred',
  params: {},
  draw(ctx) {
    ctx.filter = 'blur(4px)';
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(40, 40, 20, 20);
  },
};

type Kit = Parameters<Rig['draw']>[5];

/** A part that sets up its own state and puts it back, so parts stay independent (rig rule 3). */
function inPart(ctx: Ctx2D, kit: Kit, id: string, draw: () => void): void {
  kit.part(id, () => {
    ctx.save();
    draw();
    ctx.restore();
  });
}

/**
 * A character with parts: a body disc, an eye, a multiply patch, a blush at
 * blushAlpha, and one stray mark outside any part (which real rigs must not
 * have, but hitTest has to handle).
 */
const creatureParams = { blushAlpha: num(0.3) };
function drawCreature(ctx: Ctx2D, p: Params, kit: Kit): void {
  inPart(ctx, kit, 'body', () => {
    ctx.fillStyle = '#8b5a2b';
    ctx.beginPath();
    ctx.arc(50, 50, 30, 0, Math.PI * 2);
    ctx.fill();
  });
  inPart(ctx, kit, 'eye', () => {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(60, 40, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  inPart(ctx, kit, 'patch', () => {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#3355ff';
    ctx.fillRect(30, 55, 15, 15);
  });
  inPart(ctx, kit, 'blush', () => {
    ctx.globalAlpha = n(p.blushAlpha);
    ctx.fillStyle = '#ff6688';
    ctx.fillRect(60, 55, 10, 10);
  });
  ctx.fillStyle = '#000000';
  ctx.fillRect(10, 90, 5, 5); // stray mark outside any part
}
const creature: Rig = {
  id: 'creature',
  params: creatureParams,
  parts: ['body', 'eye', 'patch', 'blush'],
  draw: (ctx, p, _t, _rng, _stage, kit) => drawCreature(ctx, p, kit),
};
/** A variant with an extra part drawn over the body. */
const creatureBandaged: Rig = {
  id: 'creature.bandaged',
  params: creatureParams,
  parts: ['body', 'eye', 'patch', 'blush', 'bandage'],
  draw(ctx, p, _t, _rng, _stage, kit) {
    drawCreature(ctx, p, kit);
    inPart(ctx, kit, 'bandage', () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(25, 35, 20, 6);
    });
  },
};

/** The same part drawn twice, around another: bread, filling, bread. */
const sandwich: Rig = {
  id: 'sandwich',
  params: {},
  parts: ['bread', 'filling'],
  draw(ctx, _p, _t, _rng, _stage, kit) {
    kit.part('bread', () => {
      ctx.fillStyle = '#e8c07a';
      ctx.fillRect(0, 0, 40, 40);
    });
    kit.part('filling', () => {
      ctx.fillStyle = '#44aa44';
      ctx.fillRect(10, 10, 30, 30);
    });
    kit.part('bread', () => {
      ctx.fillStyle = '#e8c07a';
      ctx.fillRect(20, 20, 20, 20);
    });
  },
};

/**
 * Part a in two see-through segments around part b, all over [0, 20)^2.
 * Top first the segments give a 0.25, b 0.4 * 0.75 = 0.3, a 0.5 * 0.45 = 0.225,
 * so b has the biggest single segment but a has the bigger total, 0.475.
 */
const glazed: Rig = {
  id: 'glazed',
  params: {},
  parts: ['a', 'b'],
  draw(ctx, _p, _t, _rng, _stage, kit) {
    const coat = (id: string, alpha: number) =>
      inPart(ctx, kit, id, () => {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 20, 20);
      });
    coat('a', 0.5);
    coat('b', 0.4);
    coat('a', 0.25);
  },
};

/** Uses the seeded rng, so the probe must seed it like render does. */
const speckle: Rig = {
  id: 'speckle',
  params: {},
  draw(ctx, _p, _t, rng) {
    ctx.fillStyle = '#222222';
    for (let i = 0; i < 12; i++) ctx.fillRect(rng.int(0, 95), rng.int(0, 95), 5, 5);
  },
};

const registry = createRegistry([rect, rectShifted, disc, wash, clipped, shadowed, blurred, creature, creatureBandaged, sandwich, glazed, speckle]);

function makeScene(layers: Layer[], extra: Partial<Scene> = {}): Scene {
  return { id: 'hits', fps: 12, duration: 1, size: [W, H], seed: 3, layers, ...extra };
}

const withBackground = { background: { rig: 'wash' } };

function hit(scene: Scene, x: number, y: number, options?: HitTestOptions, frame = 0, probe = newProbe()): HitResult {
  return hitTest(probe, scene, frame, x, y, registry, options);
}

const ids = (r: HitResult) => r.candidates.map((c) => c.layerId);

// ------------------------------------------------------------------- layers

describe('hitTest: layers', () => {
  const overlap = makeScene(
    [
      { id: 'a', rig: 'rect', params: { x: 10, y: 10, w: 40, h: 40 } },
      { id: 'b', rig: 'rect', params: { x: 30, y: 30, w: 40, h: 40 } },
    ],
    withBackground,
  );

  it('the top layer wins where layers overlap', () => {
    const r = hit(overlap, 35, 35);
    expect(r.layerId).toBe('b');
    expect(r.candidates).toEqual([{ layerId: 'b', alpha: 1, share: 1 }]);
  });

  it('a lower layer wins where it is alone, and the background where nothing else is', () => {
    expect(hit(overlap, 15, 15).layerId).toBe('a');
    expect(hit(overlap, 80, 5).layerId).toBe('background');
    expect(hit(overlap, 95, 95).layerId).toBe('background');
  });

  it('probes the pixel (floor(x), floor(y))', () => {
    expect(hit(overlap, 29.99, 29.99).layerId).toBe('a');
    expect(hit(overlap, 30, 30).layerId).toBe('b');
    expect(hit(overlap, 30.99, 30.5).layerId).toBe('b');
    expect(hit(overlap, 9.99, 20).layerId).toBe('background');
    expect(hit(overlap, 10, 20).layerId).toBe('a');
  });

  it.each([
    [0.3, 'under'],
    [0.7, 'over'],
  ])('a layer at globalAlpha %s over an opaque one: %s wins', (alpha, winner) => {
    const s = makeScene([
      { id: 'under', rig: 'rect', params: { x: 0, y: 0, w: 50, h: 50 } },
      { id: 'over', rig: 'rect', params: { x: 0, y: 0, w: 50, h: 50, alpha } },
    ]);
    const r = hit(s, 20, 20, { all: true });
    expect(r.layerId).toBe(winner);
    expect(hit(s, 20, 20).layerId).toBe(winner);
    expect(ids(r)).toEqual(['over', 'under']);
    expect(r.candidates[0].alpha).toBeCloseTo(alpha, 2);
    expect(r.candidates[0].share).toBeCloseTo(alpha, 2);
    expect(r.candidates[1].share).toBeCloseTo(1 - alpha, 2);
  });

  describe('early exit and options.all', () => {
    const stack = makeScene(
      [
        { id: 'bottom', rig: 'rect', params: { x: 0, y: 0, w: 50, h: 50 } },
        { id: 'elsewhere', rig: 'rect', params: { x: 60, y: 60, w: 10, h: 10 } },
        { id: 'mid', rig: 'rect', params: { x: 0, y: 0, w: 50, h: 50, alpha: 0.6 } },
        { id: 'top', rig: 'rect', params: { x: 0, y: 0, w: 50, h: 50, alpha: 0.3 } },
      ],
      withBackground,
    );

    it('stops once nothing below can beat the best share', () => {
      // top 0.3, mid 0.7 * 0.6 = 0.42, and only 0.28 is left for anything below
      const r = hit(stack, 10, 10);
      expect(r.layerId).toBe('mid');
      expect(ids(r)).toEqual(['top', 'mid']);
      expect(r.candidates[1].share).toBeCloseTo(0.42, 2);
    });

    it('with all, scans every layer, lists every one with paint there, and picks the same winner', () => {
      const r = hit(stack, 10, 10, { all: true });
      expect(r.layerId).toBe('mid');
      expect(ids(r)).toEqual(['top', 'mid', 'bottom', 'background']);
      expect(r.candidates[2]).toMatchObject({ layerId: 'bottom', alpha: 1 });
      expect(r.candidates[2].share).toBeCloseTo(0.28, 2);
      expect(r.candidates[3]).toEqual({ layerId: 'background', alpha: 1, share: 0 });
    });

    it('an opaque top layer ends the scan at once, unless all is set', () => {
      expect(ids(hit(overlap, 35, 35))).toEqual(['b']);
      expect(ids(hit(overlap, 35, 35, { all: true }))).toEqual(['b', 'a', 'background']);
      expect(hit(overlap, 35, 35, { all: true }).layerId).toBe('b');
    });

    it('agrees with all on every pixel of a busy scene', () => {
      const probe = newProbe();
      for (let y = 0; y < H; y += 7) {
        for (let x = 0; x < W; x += 7) {
          const quick = hitTest(probe, stack, 0, x, y, registry);
          const full = hitTest(probe, stack, 0, x, y, registry, { all: true });
          expect(quick.layerId, `${x},${y}`).toBe(full.layerId);
          expect(full.candidates.slice(0, quick.candidates.length)).toEqual(quick.candidates);
        }
      }
    });
  });

  it('returns null outside the stage', () => {
    const miss = { layerId: null, candidates: [] };
    for (const [x, y] of [[-0.01, 5], [-1, -1], [W, 5], [5, H], [W + 10, H + 10], [Number.NaN, 5], [5, Number.NaN], [Infinity, 5], [5, -Infinity]]) {
      expect(hit(overlap, x, y), `${x},${y}`).toEqual(miss);
      expect(hit(overlap, x, y, { all: true, parts: true }), `${x},${y}`).toEqual(miss);
    }
    expect(hit(overlap, W - 0.01, H - 0.01).layerId).toBe('background');
  });

  it('returns null where nothing is painted and there is no background', () => {
    const s = makeScene([{ id: 'a', rig: 'rect', params: { x: 10, y: 10, w: 10, h: 10 } }]);
    expect(hit(s, 50, 50)).toEqual({ layerId: null, candidates: [] });
    expect(hit(s, 50, 50, { all: true, parts: true })).toEqual({ layerId: null, candidates: [] });
    expect(hit(makeScene([]), 50, 50)).toEqual({ layerId: null, candidates: [] });
  });

  it('respects a clip inside the rig', () => {
    const s = makeScene([{ id: 'c', rig: 'clipped' }], withBackground);
    expect(hit(s, 45, 45).layerId).toBe('c');
    expect(hit(s, 59.5, 40).layerId).toBe('c');
    expect(hit(s, 60, 45).layerId).toBe('background');
    expect(hit(s, 20, 20).layerId).toBe('background');
  });

  it('counts a shadow as the layer, and a blur spreads it', () => {
    const s = makeScene([{ id: 'shadow', rig: 'shadowed' }, { id: 'blur', rig: 'blurred' }]);
    expect(hit(s, 15, 15).layerId).toBe('shadow');
    expect(hit(s, 45, 15).layerId).toBe('shadow'); // the shadow, 30 px right of the square
    expect(hit(s, 30, 15).layerId).toBeNull();
    const edge = hit(s, 61, 50);
    expect(edge.layerId).toBe('blur');
    expect(edge.candidates[0].alpha).toBeGreaterThan(0);
    expect(edge.candidates[0].alpha).toBeLessThan(1);
    expect(hit(s, 75, 50).layerId).toBeNull();
  });

  it('seeds each layer like render does', () => {
    const s = makeScene([{ id: 'dust', rig: 'speckle' }]);
    const full = newStage();
    drawLayer(full, s, s.layers[0], 0, registry);
    const data = full.getImageData(0, 0, W, H).data;
    for (let y = 1; y < H; y += 3) {
      for (let x = 1; x < W; x += 3) {
        const a = data[(y * W + x) * 4 + 3];
        expect(hit(s, x, y).layerId, `${x},${y}`).toBe(a > 0 ? 'dust' : null);
      }
    }
  });

  it('honours stepFps: a held layer is probed where it is drawn, not where time says', () => {
    const track = [{ param: 'x', keys: [{ t: 0, v: 0 }, { t: 1, v: 12 }] }]; // x = 12 t
    const held = makeScene([{ id: 'm', rig: 'rect', stepFps: 6, tracks: track }]);
    const free = makeScene([{ id: 'm', rig: 'rect', tracks: track }]);
    // frame 1: the free rect is at x = 1 and covers pixel 10; the held one is still at x = 0
    expect(hit(free, 10.5, 5, {}, 1).layerId).toBe('m');
    expect(hit(held, 10.5, 5, {}, 1).layerId).toBeNull();
    expect(hit(held, 10.5, 5, {}, 2).layerId).toBe('m');
  });

  it('honours overrides, param overrides and rig swaps alike', () => {
    const s = makeScene([
      {
        id: 'r',
        rig: 'rect',
        params: { x: 0, y: 0, w: 20, h: 20 },
        overrides: [
          { from: 3, to: 5, params: { y: 50 } },
          { from: 6, to: 8, rig: 'rect.shifted' },
        ],
      },
    ]);
    const at = (frame: number, x: number, y: number) => hit(s, x, y, {}, frame).layerId;
    expect(at(2, 5, 5)).toBe('r');
    expect(at(3, 5, 5)).toBeNull();
    expect(at(3, 5, 55)).toBe('r');
    expect(at(4, 5, 55)).toBe('r');
    expect(at(5, 5, 55)).toBeNull();
    expect(at(6, 5, 5)).toBeNull();
    expect(at(6, 55, 5)).toBe('r');
    expect(at(7, 55, 5)).toBe('r');
    expect(at(8, 5, 5)).toBe('r');
  });

  it('ignores whatever transform, clip and state the caller left on the probe', () => {
    const scenes = [overlap, makeScene([{ id: 'c', rig: 'clipped' }, { id: 'bl', rig: 'blurred' }], withBackground)];
    const dirty = newProbe();
    dirty.save();
    dirty.setTransform(3, 0, 0, 3, 7, -9);
    dirty.beginPath();
    dirty.rect(50, 50, 1, 1);
    dirty.clip(); // excludes pixel (0, 0) entirely
    dirty.globalAlpha = 0;
    dirty.globalCompositeOperation = 'copy';
    dirty.filter = 'blur(5px)';
    dirty.fillStyle = '#ff0000';
    dirty.fillRect(-100, -100, 1000, 1000);
    dirty.save();
    dirty.translate(10, 10);
    const clean = newProbe();
    for (const s of scenes) {
      for (let y = 2; y < H; y += 9) {
        for (let x = 2; x < W; x += 9) {
          const expected = hitTest(clean, s, 0, x, y, registry, { all: true });
          expect(hitTest(dirty, s, 0, x, y, registry, { all: true }), `${x},${y}`).toEqual(expected);
        }
      }
    }
  });

  it('answers the same whatever was probed before (no state carried between calls)', () => {
    const probe = newProbe();
    const points = [[35, 35], [15, 15], [80, 5], [35, 35], [50, 50], [15, 15]];
    const results = points.map(([x, y]) => hitTest(probe, overlap, 0, x, y, registry, { all: true }));
    points.forEach(([x, y], i) => expect(results[i]).toEqual(hit(overlap, x, y, { all: true })));
  });

  it.each([-1, 0.5, Number.NaN, Infinity, 12, 13])('throws RangeError for frame %s, like render', (frame) => {
    expect(() => hit(overlap, 35, 35, {}, frame)).toThrow(RangeError);
    // even when the point is off the stage
    expect(() => hit(overlap, -5, -5, {}, frame)).toThrow(RangeError);
  });

  it('accepts the first and last frame', () => {
    expect(hit(overlap, 35, 35, {}, 0).layerId).toBe('b');
    expect(hit(overlap, 35, 35, {}, frameCount(overlap) - 1).layerId).toBe('b');
  });

  it('propagates an unknown rig, like render', () => {
    const s = makeScene([{ id: 'ghostly', rig: 'ghost' }]);
    expect(() => hit(s, 5, 5)).toThrow(/"ghostly".*"ghost"/);
  });
});

// -------------------------------------------------------------------- parts

describe('hitTest: parts', () => {
  const scene = makeScene(
    [
      { id: 'hero', rig: 'creature', overrides: [{ from: 6, to: 12, rig: 'creature.bandaged' }] },
      { id: 'box', rig: 'rect', params: { x: 85, y: 0, w: 15, h: 15 } },
    ],
    withBackground,
  );
  const part = (x: number, y: number, frame = 0, options: HitTestOptions = { parts: true }) => hit(scene, x, y, options, frame);

  it('returns the part under the pixel', () => {
    expect(part(40, 40)).toMatchObject({ layerId: 'hero', partId: 'body' });
    expect(part(60, 40)).toMatchObject({ layerId: 'hero', partId: 'eye' });
  });

  it('finds a part drawn with multiply', () => {
    expect(part(35, 60)).toMatchObject({ layerId: 'hero', partId: 'patch' });
    expect(part(44, 69)).toMatchObject({ layerId: 'hero', partId: 'patch' });
  });

  it('weighs a see-through part against the part below it', () => {
    // blush at 0.3 over the body: the body contributes 0.7
    expect(part(65, 60)).toMatchObject({ layerId: 'hero', partId: 'body' });
    const bold = makeScene([{ id: 'hero', rig: 'creature', params: { blushAlpha: 0.7 } }]);
    expect(hit(bold, 65, 60, { parts: true })).toMatchObject({ layerId: 'hero', partId: 'blush' });
  });

  it('gives the last drawn segment of a part drawn twice', () => {
    const s = makeScene([{ id: 's', rig: 'sandwich' }]);
    expect(hit(s, 5, 5, { parts: true }).partId).toBe('bread');
    expect(hit(s, 15, 15, { parts: true }).partId).toBe('filling');
    expect(hit(s, 25, 25, { parts: true }).partId).toBe('bread');
  });

  it('adds up the segments of a part drawn more than once', () => {
    const s = makeScene([{ id: 'g', rig: 'glazed' }]);
    expect(hit(s, 10, 10, { parts: true }).partId).toBe('a');
  });

  it('uses the rig the layer has on that frame, variant parts included', () => {
    expect(part(30, 37, 5)).toMatchObject({ layerId: 'hero', partId: 'body' });
    expect(part(30, 37, 6)).toMatchObject({ layerId: 'hero', partId: 'bandage' });
    expect(part(60, 40, 6)).toMatchObject({ layerId: 'hero', partId: 'eye' });
  });

  it('omits partId without options.parts', () => {
    const r = part(40, 40, 0, {});
    expect(r.layerId).toBe('hero');
    expect('partId' in r).toBe(false);
  });

  it('omits partId when the winning rig declares no parts', () => {
    for (const [x, y] of [[90, 5], [5, 5]]) {
      const r = part(x, y);
      expect(r.layerId).toMatch(/^(box|background)$/);
      expect('partId' in r, `${x},${y}`).toBe(false);
    }
  });

  it('omits partId when the winning mark is outside any part', () => {
    const r = part(12, 92);
    expect(r.layerId).toBe('hero');
    expect('partId' in r).toBe(false);
  });

  it('looks for parts on the winning layer only', () => {
    const covered = makeScene([
      { id: 'hero', rig: 'creature' },
      { id: 'lid', rig: 'rect', params: { x: 30, y: 30, w: 20, h: 20 } },
    ]);
    const r = hit(covered, 40, 40, { parts: true, all: true });
    expect(r.layerId).toBe('lid');
    expect('partId' in r).toBe(false);
    expect(ids(r)).toEqual(['lid', 'hero']);
  });

  it('does not change the layer answer or candidates', () => {
    for (const [x, y] of [[40, 40], [60, 40], [35, 60], [65, 60], [12, 92], [90, 5], [2, 2]]) {
      const { partId: _p, ...withParts } = part(x, y, 0, { parts: true, all: true });
      expect(withParts, `${x},${y}`).toEqual(part(x, y, 0, { all: true }));
    }
  });
});

// ------------------------------------------------------------------- parity

describe('hitTest: parity with the full-size render', () => {
  /** Moving, rotating and antialiased layers over a background. */
  const scene = makeScene(
    [
      {
        id: 'ball',
        rig: 'disc',
        params: { r: 18 },
        tracks: [
          { param: 'cx', keys: [{ t: 0, v: 20 }, { t: 0.9, v: 80, ease: 'inOutCubic' }] },
          { param: 'cy', keys: [{ t: 0, v: 70 }, { t: 0.5, v: 35, ease: 'outQuad' }, { t: 0.9, v: 60, ease: 'inQuad' }] },
        ],
      },
      { id: 'hero', rig: 'creature', overrides: [{ from: 6, to: 9, rig: 'creature.bandaged' }] },
      {
        id: 'bar',
        rig: 'rect',
        stepFps: 6,
        params: { x: 25, y: 40, w: 50, h: 12 },
        tracks: [{ param: 'angle', keys: [{ t: 0, v: 0 }, { t: 1, v: 3 }] }],
      },
      { id: 'dust', rig: 'speckle' },
    ],
    withBackground,
  );

  /** Alpha of every layer drawn alone at full size. */
  function layerAlpha(frame: number): Uint8ClampedArray[] {
    return sceneLayers(scene).map((layer) => {
      const ctx = newStage();
      drawLayer(ctx, scene, layer, frame, registry);
      const rgba = ctx.getImageData(0, 0, W, H).data;
      const alpha = new Uint8ClampedArray(W * H);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      return alpha;
    });
  }

  it('at pixels where every layer is fully in or out, and so are the 8 neighbours, the probe names the top owner', () => {
    const layers = sceneLayers(scene);
    const probe = newProbe();
    const seen = new Set<string | null>();
    let checked = 0;
    for (const frame of [0, 3, 5, 6, 8, 11]) {
      const alpha = layerAlpha(frame);
      /** Top layer painting (x, y) opaquely; undefined when any layer is partial there. */
      const owner = (x: number, y: number): string | null | undefined => {
        let top: string | null = null;
        for (let i = 0; i < layers.length; i++) {
          const a = alpha[i][y * W + x];
          if (a !== 0 && a !== 255) return undefined;
          if (a === 255) top = layers[i].id;
        }
        return top;
      };
      for (let y = 1; y < H - 1; y += 2) {
        for (let x = 1; x < W - 1; x += 2) {
          const o = owner(x, y);
          if (o === undefined) continue;
          let clean = true;
          for (let dy = -1; dy <= 1 && clean; dy++) for (let dx = -1; dx <= 1 && clean; dx++) clean = owner(x + dx, y + dy) === o;
          if (!clean) continue;
          expect(hitTest(probe, scene, frame, x + 0.5, y + 0.5, registry).layerId, `frame ${frame} at ${x},${y}`).toBe(o);
          seen.add(o);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(8000);
    expect([...seen].sort()).toEqual(['background', 'ball', 'bar', 'dust', 'hero']);
  }, 20_000); // about 1.5 s alone, but several times that when the whole suite runs at once
});

// -------------------------------------------------------------------- speed

describe('hitTest: cost', () => {
  it('probes a 20-layer scene quickly', () => {
    const rng = createRng(9, 'layout');
    const layers: Layer[] = [];
    for (let i = 0; i < 19; i++) {
      layers.push(
        i % 2 === 0
          ? { id: `d${i}`, rig: 'disc', params: { cx: rng.range(10, 90), cy: rng.range(10, 90), r: rng.range(5, 20) } }
          : { id: `r${i}`, rig: 'rect', params: { x: rng.range(0, 80), y: rng.range(0, 80), w: rng.range(5, 30), h: rng.range(5, 30), alpha: rng.range(0.2, 1), angle: rng.range(0, 3) } },
      );
    }
    layers.push({ id: 'hero', rig: 'creature' });
    const s = makeScene(layers, withBackground);
    expect(sceneLayers(s)).toHaveLength(21);
    const probe = newProbe();
    const points = Array.from({ length: 400 }, () => [rng.range(0, W), rng.range(0, H)]);
    const time = (options: HitTestOptions) => {
      for (const [x, y] of points.slice(0, 20)) hitTest(probe, s, 0, x, y, registry, options); // warm up
      const start = performance.now();
      for (const [x, y] of points) hitTest(probe, s, 0, x, y, registry, options);
      return (performance.now() - start) / points.length;
    };
    const quick = time({});
    const all = time({ all: true });
    const parts = time({ all: true, parts: true });
    console.info(
      `hitTest, 21 layers (20 + background), @napi-rs/canvas: ${quick.toFixed(3)} ms per call with early exit, ` +
        `${all.toFixed(3)} ms with all, ${parts.toFixed(3)} ms with all and parts`,
    );
    expect(all).toBeLessThan(20);
  });
});
