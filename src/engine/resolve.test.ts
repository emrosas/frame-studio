import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry';
import { resolveLayer, sceneLayers } from './resolve';
import { BACKGROUND_ID, type Layer, type Rig, type Scene } from './types';

const noop = () => {};

const ball: Rig = {
  id: 'ball',
  params: {
    x: { type: 'number', default: 1 },
    y: { type: 'number', default: 2 },
    r: { type: 'number', default: 3 },
    s: { type: 'number', default: 4 },
    mood: { type: 'enum', default: 'calm', options: ['calm', 'angry'] },
  },
  draw: noop,
};
/** A variant keeps every base param (createRegistry checks) and may change defaults. */
const ballSquashed: Rig = {
  id: 'ball.squashed',
  params: {
    ...ball.params,
    x: { type: 'number', default: 100 },
    squash: { type: 'number', default: 0.5 },
  },
  draw: noop,
};
const paper: Rig = { id: 'paper', params: { tone: { type: 'color', default: '#fff' } }, draw: noop };
const registry = createRegistry([ball, ballSquashed, paper]);

function scene(layers: Layer[], extra: Partial<Scene> = {}): Scene {
  return { id: 's', fps: 12, duration: 10, size: [100, 50], seed: 1, layers, ...extra };
}

describe('sceneLayers', () => {
  it('puts the background first, then layers in array order', () => {
    const a: Layer = { id: 'a', rig: 'ball' };
    const b: Layer = { id: 'b', rig: 'ball' };
    const s = scene([a, b], { background: { rig: 'paper', params: { tone: '#abc' } } });
    const layers = sceneLayers(s);
    expect(layers.map((l) => l.id)).toEqual([BACKGROUND_ID, 'a', 'b']);
    expect(layers[0]).toEqual({ id: BACKGROUND_ID, rig: 'paper', params: { tone: '#abc' } });
    expect(layers[1]).toBe(a);
    expect(layers[2]).toBe(b);
  });

  it('omits the background when the scene has none', () => {
    const a: Layer = { id: 'a', rig: 'ball' };
    expect(sceneLayers(scene([a])).map((l) => l.id)).toEqual(['a']);
    expect(sceneLayers(scene([]))).toEqual([]);
  });

  it('the background id always wins over any stray id field', () => {
    const s = scene([], { background: { rig: 'paper', id: 'oops' } as unknown as Scene['background'] });
    expect(sceneLayers(s)[0].id).toBe(BACKGROUND_ID);
  });
});

describe('resolveLayer', () => {
  it('uses rig defaults when the layer sets nothing', () => {
    const layer: Layer = { id: 'l', rig: 'ball' };
    const r = resolveLayer(layer, scene([layer]), 0, registry);
    expect(r.id).toBe('l');
    expect(r.rig).toBe(ball);
    expect(r.params).toEqual({ x: 1, y: 2, r: 3, s: 4, mood: 'calm' });
    expect(r.t).toBe(0);
  });

  it('applies precedence defaults < layer.params < tracks < override.params', () => {
    const layer: Layer = {
      id: 'l',
      rig: 'ball',
      params: { y: 20, r: 30, s: 40 },
      tracks: [
        { param: 'r', keys: [{ t: 0, v: 300 }] },
        { param: 's', keys: [{ t: 0, v: 400 }] },
      ],
      overrides: [{ from: 5, to: 10, params: { s: 4000, mood: 'angry' } }],
    };
    const s = scene([layer]);
    expect(resolveLayer(layer, s, 0, registry).params).toEqual({ x: 1, y: 20, r: 300, s: 400, mood: 'calm' });
    expect(resolveLayer(layer, s, 5, registry).params).toEqual({ x: 1, y: 20, r: 300, s: 4000, mood: 'angry' });
    expect(resolveLayer(layer, s, 10, registry).params).toEqual({ x: 1, y: 20, r: 300, s: 400, mood: 'calm' });
  });

  it('swaps the rig inside an override range and takes the swapped rig defaults', () => {
    const layer: Layer = {
      id: 'l',
      rig: 'ball',
      params: { y: 20 },
      overrides: [{ from: 36, to: 48, rig: 'ball.squashed', params: { squash: 0.9 } }],
    };
    const s = scene([layer]);
    expect(resolveLayer(layer, s, 35, registry).rig).toBe(ball);
    const inside = resolveLayer(layer, s, 36, registry);
    expect(inside.rig).toBe(ballSquashed);
    expect(inside.params).toEqual({ x: 100, y: 20, r: 3, s: 4, mood: 'calm', squash: 0.9 });
    expect(resolveLayer(layer, s, 47, registry).rig).toBe(ballSquashed);
    expect(resolveLayer(layer, s, 48, registry).rig).toBe(ball);
  });

  it('evaluates tracks at the quantized time so held frames hold position', () => {
    const layer: Layer = {
      id: 'l',
      rig: 'ball',
      stepFps: 6,
      tracks: [{ param: 'x', keys: [{ t: 0, v: 0 }, { t: 10, v: 1200, ease: 'inOutCubic' }] }],
    };
    const s = scene([layer]);
    for (let k = 0; k < 60; k++) {
      const a = resolveLayer(layer, s, 2 * k, registry);
      const b = resolveLayer(layer, s, 2 * k + 1, registry);
      expect(b.t).toBe(a.t);
      expect(b.params).toEqual(a.params);
      expect(a.t).toBe(k / 6);
    }
    // and consecutive pairs differ
    expect(resolveLayer(layer, s, 2, registry).params.x).not.toBe(resolveLayer(layer, s, 1, registry).params.x);
  });

  it('a layer without stepFps moves every frame', () => {
    const layer: Layer = { id: 'l', rig: 'ball', tracks: [{ param: 'x', keys: [{ t: 0, v: 0 }, { t: 10, v: 120 }] }] };
    const s = scene([layer]);
    expect(resolveLayer(layer, s, 1, registry).params.x).toBe(1);
    expect(resolveLayer(layer, s, 2, registry).params.x).toBe(2);
    expect(resolveLayer(layer, s, 3, registry).t).toBe(3 / 12);
  });

  it('overrides use the output frame, not the quantized time', () => {
    // stepFps 6: frames 4 and 5 share a quantized time, but the override starts at 5
    const layer: Layer = { id: 'l', rig: 'ball', stepFps: 6, overrides: [{ from: 5, to: 6, params: { x: 9 } }] };
    const s = scene([layer]);
    expect(resolveLayer(layer, s, 4, registry).params.x).toBe(1);
    expect(resolveLayer(layer, s, 5, registry).params.x).toBe(9);
    expect(resolveLayer(layer, s, 5, registry).t).toBe(resolveLayer(layer, s, 4, registry).t);
  });

  it('does not mutate the layer or rig defaults', () => {
    const layer: Layer = { id: 'l', rig: 'ball', params: { x: 5 } };
    const r = resolveLayer(layer, scene([layer]), 0, registry);
    r.params.x = 999;
    expect(layer.params).toEqual({ x: 5 });
    expect(resolveLayer(layer, scene([layer]), 0, registry).params.x).toBe(5);
  });

  it('throws naming the layer and the rig when the rig is missing', () => {
    const layer: Layer = { id: 'hero', rig: 'ghost' };
    expect(() => resolveLayer(layer, scene([layer]), 0, registry)).toThrow(/"hero".*"ghost"/);
  });

  it('throws naming the override rig when it is missing', () => {
    const layer: Layer = { id: 'hero', rig: 'ball', overrides: [{ from: 0, to: 2, rig: 'ball.ghost' }] };
    expect(() => resolveLayer(layer, scene([layer]), 1, registry)).toThrow(/"hero".*"ball\.ghost"/);
    expect(() => resolveLayer(layer, scene([layer]), 2, registry)).not.toThrow();
  });
});
