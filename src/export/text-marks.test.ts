import { describe, expect, it } from 'vitest';
import { compositionToScene, type Composition } from '../engine/composition';
import type { Layer, Scene, World } from '../engine/types';
import { createDefaultRegistry } from '../rigs';
import { apply, boundsOf, invert, markContains, multiply, textAppearances, textMarks, withoutLayer, type Affine, type TextMark } from './text-marks';

const registry = createDefaultRegistry();

const title = (params: Record<string, unknown> = {}, extra: Partial<Layer> = {}): Layer => ({
  id: 'title',
  rig: 'text',
  params: { text: 'Hello there', size: 100, x: 200, y: 300, align: 'left', valign: 'top', ...params },
  ...extra,
});

const scene = (layers: Layer[], over: Partial<Scene> = {}): Scene => ({ id: 's', fps: 12, duration: 2, size: [1920, 1080], seed: 1, layers, ...over });
const only = (s: Scene, frame = 0, world: World = {}): TextMark => {
  const marks = textMarks(s, frame, registry, world);
  expect(marks).toHaveLength(1);
  return marks[0];
};

describe('affine helpers', () => {
  it('composes, applies and inverts', () => {
    const m: Affine = multiply([2, 0, 0, 2, 10, 20], [0, 1, -1, 0, 5, 0]);
    const [x, y] = apply(m, 3, 4);
    const inverse = invert(m)!;
    const [u, v] = apply(inverse, x, y);
    expect(u).toBeCloseTo(3);
    expect(v).toBeCloseTo(4);
    expect(invert([0, 0, 0, 0, 1, 1])).toBeNull();
  });

  it('bounds a turned box', () => {
    const turn: Affine = [0, 1, -1, 0, 0, 0];
    expect(boundsOf([{ x: 0, y: 0, width: 10, height: 2 }], turn)).toEqual({ x: -2, y: 0, width: 2, height: 10 });
  });
});

describe('textMarks', () => {
  it('measures a text layer from its layout: ink inside the line box, the size, the paint', () => {
    const mark = only(scene([title()]));
    expect(mark).toMatchObject({ path: 'title', rig: 'text', text: 'Hello there', complete: true, opacity: 1, fills: ['#1c1b19'], stroke: null, size: 100, top: true });
    // Ink starts at the anchor, give or take a side bearing, and sits under the block's top.
    expect(mark.box.x).toBeGreaterThan(195);
    expect(mark.box.x).toBeLessThan(215);
    expect(mark.box.y).toBeGreaterThan(300);
    expect(mark.box.height).toBeGreaterThan(60);
    expect(mark.box.height).toBeLessThan(120);
    expect(mark.box.width).toBeGreaterThan(400);
  });

  it('follows scale and rotation about the anchor', () => {
    const plain = only(scene([title()]));
    const big = only(scene([title({ scale: 2 })]));
    expect(big.size).toBeCloseTo(200);
    expect(big.box.width).toBeCloseTo(plain.box.width * 2, 0);
    const turned = only(scene([title({ rotation: 90 })]));
    // Turned clockwise a quarter about (200, 300): the text runs down from the anchor, to its left.
    expect(turned.box.height).toBeCloseTo(plain.box.width, 0);
    expect(turned.box.x + turned.box.width).toBeLessThanOrEqual(200 + 1e-6);
  });

  it('says whether a reveal has finished, and draws nothing before it starts', () => {
    const half = only(scene([title({ reveal: 0.5 })]));
    expect(half.complete).toBe(false);
    expect(half.box.width).toBeLessThan(only(scene([title()])).box.width);
    expect(textMarks(scene([title({ reveal: 0 })]), 0, registry)).toEqual([]);
    expect(textMarks(scene([title({ opacity: 0 })]), 0, registry)).toEqual([]);
    expect(textMarks(scene([title({ fill: 'none' })]), 0, registry)).toEqual([]);
  });

  it('takes an outline with no fill as the text colour', () => {
    const mark = only(scene([title({ fill: 'none', stroke: '#ff0000', strokeWidth: 4 })]));
    expect(mark.fills).toEqual(['#ff0000']);
    expect(mark.stroke).toBeNull();
    const both = only(scene([title({ stroke: '#ffffff', strokeWidth: 4, scale: 2 })]));
    expect(both).toMatchObject({ stroke: '#ffffff', strokeWidth: 8 });
  });

  it('moves with the camera by depth, and scales up a pixel stage', () => {
    const plain = only(scene([title()]));
    const moved = only(scene([title()], { camera: { x: 100, y: 0, zoom: 1 } }));
    expect(moved.box.x).toBeCloseTo(plain.box.x - 100);
    const pinned = only(scene([title({}, { depth: 0 })], { camera: { x: 100, y: 0, zoom: 1 } }));
    expect(pinned.box.x).toBeCloseTo(plain.box.x);
    const pixel = only(scene([title({ x: 50, y: 75, size: 25 })], { pixel: { scale: 4 } }));
    expect(pixel.size).toBeCloseTo(100);
    expect(pixel.box.x).toBeCloseTo(plain.box.x, 0);
    expect(pixel.box.width).toBeCloseTo(plain.box.width, 0);
  });

  it('finds text inside clips, at their placement and opacity, through nested compositions', () => {
    const shot = scene([title()], { id: 'shot' });
    const inner: Composition = {
      id: 'inner',
      fps: 12,
      duration: 2,
      size: [1920, 1080],
      tracks: [{ id: 'V1', clips: [{ id: 'clip', scene: 'shot', params: { scale: 0.5, x: 100, opacity: 0.5 } }] }],
    };
    const outer: Composition = { id: 'outer', fps: 12, duration: 2, size: [1920, 1080], tracks: [{ id: 'V1', clips: [{ id: 'nest', scene: 'inner', start: 0.5 }] }] };
    const world: World = { scenes: new Map([['shot', shot], ['inner', compositionToScene(inner)]]) };
    const plain = only(shot);
    expect(textMarks(compositionToScene(outer), 0, registry, world)).toEqual([]); // the nest starts at 0.5 s
    const mark = only(compositionToScene(outer), 6, world);
    expect(mark).toMatchObject({ path: 'nest/clip/title', owner: { scene: 'shot', layer: 'title' }, top: false, opacity: 0.5, size: 50 });
    // Half size about the middle (960, 540), then 100 px right.
    expect(mark.box.x).toBeCloseTo(960 + (plain.box.x - 960) * 0.5 + 100);
    expect(mark.box.width).toBeCloseTo(plain.box.width * 0.5);
  });

  it("cuts text to a moved clip's own stage, as the renderer does", () => {
    const shot = scene([title({ x: 1800, y: 500 }), title({ x: 2000, y: 500 }, { id: 'gone' })], { id: 'shot' });
    const edit = compositionToScene({ id: 'e', fps: 12, duration: 2, size: [1920, 1080], tracks: [{ id: 'V1', clips: [{ id: 'c', scene: 'shot', params: { scale: 0.5 } }] }] });
    // The text wholly off the shot's stage is hidden; the other runs past its edge at x 1440.
    const mark = only(edit, 0, { scenes: new Map([['shot', shot]]) });
    expect(mark.path).toBe('c/title');
    expect(mark.area).toEqual({ x: 480, y: 270, width: 960, height: 540 });
    expect(mark.box.x + mark.box.width).toBeGreaterThan(1440);
    const inverse = invert(mark.transform)!;
    const y = mark.box.y + mark.box.height / 2;
    expect(mark.lines.length).toBe(1);
    expect(markContains(mark, inverse, 1442, y)).toBe(false);
  });

  it('centres a clip of another size, as the renderer does', () => {
    const small = scene([title({ x: 0, y: 0 })], { id: 'small', size: [960, 540] });
    const edit = compositionToScene({ id: 'e', fps: 12, duration: 2, size: [1920, 1080], tracks: [{ id: 'V1', clips: [{ id: 'c', scene: 'small' }] }] });
    const mark = only(edit, 0, { scenes: new Map([['small', small]]) });
    expect(mark.box.x).toBeCloseTo(only(small).box.x + 480);
    expect(mark.box.y).toBeCloseTo(only(small).box.y + 270);
  });

  it('measures the page of captions being said, in its colours', () => {
    const words = ['One', 'two', 'three.', 'Four', 'five.'].map((text, i) => ({ id: `w${i}`, text, start: i * 0.4, end: i * 0.4 + 0.35 }));
    const subs = scene([{ id: 'subs', rig: 'captions', params: { cue: 'voice' } }], { size: [1080, 1920], audio: [{ id: 'voice', file: 'media/v.mp3', start: 0, end: 2, words }] });
    const mark = only(subs, 3);
    expect(mark).toMatchObject({ rig: 'captions', text: 'One two three.', complete: true, fills: ['#ffffff', '#ffd23f'], stroke: '#111111', strokeWidth: 10 });
    expect(only(subs, 18).text).toBe('Four five.');
    const popping = scene([{ id: 'subs', rig: 'captions', params: { cue: 'voice', style: 'pop-in' } }], { size: [1080, 1920], audio: subs.audio });
    expect(only(popping, 3).complete).toBe(false);
  });
});

describe('markContains', () => {
  it('tests a pixel against the line boxes, through the transform', () => {
    const mark = only(scene([title({ rotation: 30 })]));
    const inverse = invert(mark.transform)!;
    const line = mark.lines[0];
    const [cx, cy] = apply(mark.transform, line.x + line.width / 2, line.y + line.height / 2);
    expect(markContains(mark, inverse, cx, cy)).toBe(true);
    expect(markContains(mark, inverse, 5, 5)).toBe(false);
  });
});

describe('textAppearances', () => {
  it('splits a layer into appearances by its text and by gaps', () => {
    const changing = title({}, {
      tracks: [{ param: 'text', keys: [{ t: 0, v: 'First line' }, { t: 0.5, v: 'Second line' }] }],
      overrides: [{ from: 12, to: 14, params: { opacity: 0 } }],
    });
    const found = textAppearances(scene([changing]), registry);
    expect(found.map((a) => [a.text, a.frames[0].frame, a.frames.length])).toEqual([
      ['First line', 0, 6],
      ['Second line', 6, 6],
      ['Second line', 14, 10],
    ]);
  });
});

describe('withoutLayer', () => {
  it('takes a layer out of the scene, or out of the scene its clip places', () => {
    const shot = scene([title(), title({}, { id: 'other' })], { id: 'shot' });
    const world: World = { scenes: new Map([['shot', shot]]) };
    const top = withoutLayer(shot, world, { owner: { scene: 'shot', layer: 'title' }, top: true });
    expect(top.scene.layers.map((l) => l.id)).toEqual(['other']);
    const edit = compositionToScene({ id: 'e', fps: 12, duration: 2, size: [1920, 1080], tracks: [{ id: 'V1', clips: [{ id: 'c', scene: 'shot' }] }] });
    const nested = withoutLayer(edit, world, { owner: { scene: 'shot', layer: 'title' }, top: false });
    expect(nested.scene).toBe(edit);
    expect(nested.world.scenes!.get('shot')!.layers.map((l) => l.id)).toEqual(['other']);
    expect(world.scenes!.get('shot')!.layers).toHaveLength(2);
  });
});
