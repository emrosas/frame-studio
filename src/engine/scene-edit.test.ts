import { describe, expect, it } from 'vitest';
import { applyToSelection, formatSceneJson, mergePatch } from './scene-edit';
import type { Override, Scene } from './types';

describe('mergePatch (RFC 7386)', () => {
  // The examples from RFC 7386, appendix A.
  it.each([
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ])('%j patched with %j is %j', (target, patch, result) => {
    expect(mergePatch(target, patch)).toEqual(result);
  });

  it('leaves its inputs alone', () => {
    const target = { a: { b: 1 } };
    const patch = { a: { c: 2 } };
    mergePatch(target, patch);
    expect(target).toEqual({ a: { b: 1 } });
    expect(patch).toEqual({ a: { c: 2 } });
  });
});

describe('formatSceneJson', () => {
  it('keeps objects and arrays on one line when they fit in the width', () => {
    const text = formatSceneJson({ id: 'x', size: [1920, 1080], params: { tone: '#fff', grain: 0.6 } });
    expect(text).toBe('{ "id": "x", "size": [1920, 1080], "params": { "tone": "#fff", "grain": 0.6 } }\n');
  });

  it('breaks what does not fit, indenting by two spaces', () => {
    const value = { id: 'long', layers: [{ id: 'a', rig: 'circle', params: { x: 1, y: 2, radius: 70, fill: '#e05a4f', wobble: 2, opacity: 1 } }] };
    expect(formatSceneJson(value, 60)).toBe(
      [
        '{',
        '  "id": "long",',
        '  "layers": [',
        '    {',
        '      "id": "a",',
        '      "rig": "circle",',
        '      "params": {',
        '        "x": 1,',
        '        "y": 2,',
        '        "radius": 70,',
        '        "fill": "#e05a4f",',
        '        "wobble": 2,',
        '        "opacity": 1',
        '      }',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('round-trips, and formatting its own output changes nothing', () => {
    const value = { a: [], b: {}, c: [[1, 2], [3]], d: 'quote " and \\ and \n', e: null, f: true, g: -0.5 };
    const text = formatSceneJson(value, 20);
    expect(JSON.parse(text)).toEqual(value);
    expect(formatSceneJson(JSON.parse(text), 20)).toBe(text);
  });
});

describe('applyToSelection', () => {
  const base: Scene = {
    id: 's',
    fps: 12,
    duration: 8,
    size: [100, 100],
    seed: 1,
    background: { rig: 'paper' },
    layers: [
      { id: 'bruno', rig: 'bear', overrides: [{ from: 48, to: 72, rig: 'bear.bandaged' }] },
      { id: 'pip', rig: 'bear' },
    ],
  };
  const overridesOf = (scene: Scene, id: string): Override[] | undefined =>
    id === 'background' ? scene.background?.overrides : scene.layers.find((l) => l.id === id)?.overrides;

  it('adds an override over the range to a layer that has none', () => {
    const out = applyToSelection(base, { layerId: 'pip', from: 12, to: 24 }, { params: { expression: 'sad' } });
    expect(overridesOf(out, 'pip')).toEqual([{ from: 12, to: 24, params: { expression: 'sad' } }]);
    expect(overridesOf(base, 'pip')).toBeUndefined();
  });

  it('works on the background layer', () => {
    const out = applyToSelection(base, { layerId: 'background', from: 1, to: 14 }, { params: { tone: '#223344' } });
    expect(overridesOf(out, 'background')).toEqual([{ from: 1, to: 14, params: { tone: '#223344' } }]);
  });

  it('merges into an override with exactly the same range', () => {
    const out = applyToSelection(base, { layerId: 'bruno', from: 48, to: 72 }, { params: { expression: 'sad' } });
    expect(overridesOf(out, 'bruno')).toEqual([{ from: 48, to: 72, rig: 'bear.bandaged', params: { expression: 'sad' } }]);
  });

  it('splits an override it partly covers, so the old one still applies around the edit', () => {
    const out = applyToSelection(base, { layerId: 'bruno', from: 60, to: 66 }, { params: { expression: 'sad' } });
    expect(overridesOf(out, 'bruno')).toEqual([
      { from: 48, to: 60, rig: 'bear.bandaged' },
      { from: 60, to: 66, rig: 'bear.bandaged', params: { expression: 'sad' } },
      { from: 66, to: 72, rig: 'bear.bandaged' },
    ]);
  });

  it('covers a range that runs past an override on both sides', () => {
    const out = applyToSelection(base, { layerId: 'bruno', from: 40, to: 80 }, { rig: 'bear', params: { pose: 'cheer' } });
    expect(overridesOf(out, 'bruno')).toEqual([
      { from: 40, to: 48, rig: 'bear', params: { pose: 'cheer' } },
      { from: 48, to: 72, rig: 'bear', params: { pose: 'cheer' } },
      { from: 72, to: 80, rig: 'bear', params: { pose: 'cheer' } },
    ]);
  });

  it('never leaves overlapping overrides', () => {
    let scene = base;
    for (const [from, to] of [[0, 10], [5, 20], [15, 50], [45, 70], [2, 3]]) {
      scene = applyToSelection(scene, { layerId: 'bruno', from, to }, { params: { x: from } });
    }
    const list = overridesOf(scene, 'bruno')!;
    for (let i = 1; i < list.length; i++) expect(list[i].from).toBeGreaterThanOrEqual(list[i - 1].to);
    expect(list.find((o) => o.from <= 2 && o.to > 2)?.params?.x).toBe(2);
  });

  it('refuses a missing layer, an empty patch and a bad range', () => {
    expect(() => applyToSelection(base, { layerId: 'nobody', from: 0, to: 4 }, { params: { x: 1 } })).toThrow(/no layer "nobody".*bruno, pip, background/s);
    expect(() => applyToSelection(base, { from: 0, to: 4 }, { params: { x: 1 } })).toThrow(/layerId/);
    expect(() => applyToSelection(base, { layerId: 'pip', from: 0, to: 4 }, {})).toThrow(/rig or params/);
    expect(() => applyToSelection(base, { layerId: 'pip', from: 5, to: 5 }, { params: { x: 1 } })).toThrow(/from.*to/);
  });
});
