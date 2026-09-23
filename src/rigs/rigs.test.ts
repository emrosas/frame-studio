import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultParams } from '../engine/registry';
import { PASS_THROUGH } from '../engine/kit';
import { createRng } from '../engine/rng';
import { createRecordingContext as createStateRecorder, type LogEntry } from '../engine/testing/recording-context';
import type { Params, Rig, Stage } from '../engine/types';
import { allRigs, circle, createDefaultRegistry, paper, rect, star } from './index';
import { createRecordingContext } from './testing/recording-context';

const STAGE: Stage = { width: 1920, height: 1080 };
/** The rigs built with defineShapeRig. Listed by name so a new non-shape rig in allRigs does not join them. */
const shapes: readonly Rig[] = [circle, rect, star];

function drawLog(rig: Rig, params: Params = {}, t = 0, seed = 42, stage = STAGE): string[] {
  const { ctx, log } = createRecordingContext();
  rig.draw(ctx, { ...defaultParams(rig), ...params }, t, createRng(seed, 'layer'), stage, PASS_THROUGH);
  return log;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rig schemas', () => {
  it.each(allRigs.map((rig) => [rig.id, rig] as const))('%s has a description and valid defaults', (_id, rig) => {
    expect(rig.description?.length).toBeGreaterThan(0);
    for (const [name, spec] of Object.entries(rig.params)) {
      expect(spec.description, `${rig.id}.${name} description`).toBeTruthy();
      if (spec.type === 'number') {
        expect(spec.min, `${rig.id}.${name} min`).toBeTypeOf('number');
        expect(spec.max, `${rig.id}.${name} max`).toBeTypeOf('number');
        expect(spec.default).toBeGreaterThanOrEqual(spec.min!);
        expect(spec.default).toBeLessThanOrEqual(spec.max!);
      }
      if (spec.type === 'enum') expect(spec.options).toContain(spec.default);
    }
  });

  it('every shape shares the transform and style params', () => {
    const shared = ['x', 'y', 'scale', 'rotation', 'fill', 'stroke', 'strokeWidth', 'opacity', 'wobble'];
    for (const rig of shapes) expect(Object.keys(rig.params)).toEqual(expect.arrayContaining(shared));
  });

  it('the default registry holds every rig by id', () => {
    const registry = createDefaultRegistry();
    expect([...registry.keys()].sort()).toEqual(allRigs.map((rig) => rig.id).sort());
    for (const rig of allRigs) expect(registry.get(rig.id)).toBe(rig);
  });
});

describe('determinism', () => {
  it.each(allRigs.map((rig) => [rig.id, rig] as const))('%s draws identically for identical inputs', (_id, rig) => {
    const params: Params = rig === paper ? { boil: true } : { wobble: 6 };
    expect(drawLog(rig, params, 1.5)).toEqual(drawLog(rig, params, 1.5));
  });

  it('never touches Math.random, Date.now or performance.now', () => {
    const forbidden = (name: string) => () => {
      throw new Error(`${name} called during draw`);
    };
    vi.spyOn(Math, 'random').mockImplementation(forbidden('Math.random'));
    vi.spyOn(Date, 'now').mockImplementation(forbidden('Date.now'));
    vi.spyOn(performance, 'now').mockImplementation(forbidden('performance.now'));
    for (const rig of allRigs) {
      expect(() => drawLog(rig, rig === paper ? { boil: true } : { wobble: 4 }, 0.25)).not.toThrow();
    }
  });
});

/** Every param at its schema minimum, or maximum. Booleans go false for min and true for max. */
function extremeParams(rig: Rig, end: 'min' | 'max'): Params {
  const out: Params = {};
  for (const [name, spec] of Object.entries(rig.params)) {
    if (spec.type === 'number') out[name] = (end === 'min' ? spec.min : spec.max) ?? spec.default;
    else if (spec.type === 'boolean') out[name] = end === 'max';
    else if (spec.type === 'enum') out[name] = spec.options[end === 'min' ? 0 : spec.options.length - 1];
  }
  return out;
}

/** Numbers handed to the canvas that it would silently ignore (NaN, Infinity). */
function nonFinite(log: readonly LogEntry[]): string[] {
  const bad: string[] = [];
  for (const entry of log) {
    const values = entry.op === 'call' ? entry.args : [entry.value];
    if (values.some((v) => typeof v === 'number' && !Number.isFinite(v))) bad.push(JSON.stringify(entry));
  }
  return bad;
}

/**
 * Draws through the engine's state-tracking recording context, whose paint
 * entries carry the full drawing state. Reading ctx.canvas throws, because the
 * viewer's backing store is not the scene size.
 */
function smokeDraw(rig: Rig, params: Params, t: number) {
  const rec = createStateRecorder();
  const ctx = new Proxy(rec.ctx, {
    get(target, prop, receiver) {
      if (prop === 'canvas') throw new Error('rigs must not read ctx.canvas; use the stage argument');
      return Reflect.get(target, prop, receiver);
    },
  });
  rig.draw(ctx, { ...defaultParams(rig), ...params }, t, createRng(42, 'smoke'), STAGE, PASS_THROUGH);
  return { log: rec.log, saveDepth: rec.saveDepth() };
}

describe('smoke', () => {
  const cases = allRigs.flatMap((rig) =>
    (['default', 'min', 'max'] as const).map((which) => {
      const params = which === 'default' ? {} : extremeParams(rig, which);
      return [rig.id, which, rig, params] as const;
    }),
  );

  it.each(cases)('%s draws with %s params, balanced and finite, and the same twice', (_id, _which, rig, params) => {
    for (const t of [0, 1.25]) {
      const first = smokeDraw(rig, params, t);
      expect(first.log.length, 'draws something').toBeGreaterThan(0);
      expect(first.saveDepth, 'save() without restore()').toBe(0);
      expect(nonFinite(first.log)).toEqual([]);
      const second = smokeDraw(rig, params, t);
      expect(JSON.stringify(second.log)).toBe(JSON.stringify(first.log));
    }
  });
});

describe('shape wobble', () => {
  it.each(shapes.map((rig) => [rig.id, rig] as const))('%s is clean and still at wobble 0', (_id, rig) => {
    const log = drawLog(rig, { wobble: 0 }, 0);
    expect(drawLog(rig, { wobble: 0 }, 2)).toEqual(log);
    expect(log.some((call) => call.startsWith('bezierCurveTo'))).toBe(false);
  });

  it.each(shapes.map((rig) => [rig.id, rig] as const))('%s boils only when the layer time changes', (_id, rig) => {
    const atZero = drawLog(rig, { wobble: 5 }, 0);
    expect(atZero.some((call) => call.startsWith('bezierCurveTo'))).toBe(true);
    expect(drawLog(rig, { wobble: 5 }, 0)).toEqual(atZero);
    expect(drawLog(rig, { wobble: 5 }, 1 / 12)).not.toEqual(atZero);
  });
});

describe('paper', () => {
  it('fills the stage from the stage argument', () => {
    const log = drawLog(paper, {}, 0, 42, { width: 1280, height: 720 });
    expect(log).toContain('fillRect(0,0,1280,720)');
  });

  it('keeps its grain still from frame to frame', () => {
    expect(drawLog(paper, {}, 3)).toEqual(drawLog(paper, {}, 0));
  });

  it('re-rolls the grain per layer time when boil is on', () => {
    expect(drawLog(paper, { boil: true }, 0)).not.toEqual(drawLog(paper, { boil: true }, 0.5));
  });

  it('draws a different texture for a different seed', () => {
    expect(drawLog(paper, {}, 0, 1)).not.toEqual(drawLog(paper, {}, 0, 2));
  });
});

describe('param safety', () => {
  it('clamps eased overshoot to the schema range before it reaches the canvas', () => {
    const log = drawLog(circle, { radius: -20, opacity: 1.4 });
    expect(log).toContain(`arc(0,0,0,0,${Math.PI * 2})`);
    expect(log).toContain('globalAlpha=1');
  });

  it('falls back to the default when a value has the wrong type', () => {
    expect(drawLog(circle, { radius: 'big', fill: 3 })).toEqual(drawLog(circle));
  });

  it('turns rotation from degrees into radians', () => {
    expect(drawLog(circle, { rotation: 90 })).toContain(`rotate(${Math.PI / 2})`);
  });

  it('rounds star points to a whole number of tips', () => {
    const lines = drawLog(star, { points: 5.6 }).filter((call) => call.startsWith('lineTo'));
    expect(lines).toHaveLength(6 * 2 - 1);
  });

  it.each([
    ['none', 'none'],
    ['None', ' NONE '],
    ['Transparent', 'TRANSPARENT'],
  ])('skips fill %j and outline %j, in any case and with spaces', (fill, stroke) => {
    // The canvas ignores "None", so painting it would keep the black default.
    const log = drawLog(circle, { fill, stroke });
    expect(log).not.toContain('fill()');
    expect(log).not.toContain('stroke()');
  });
});
