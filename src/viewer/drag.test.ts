import { describe, expect, it } from 'vitest';
import { createRegistry } from '../engine';
import type { Layer, Rig, Scene } from '../engine/types';
import { dragDelta, dragScale, landValue, lockAxis, movable, snapCentre, stageCentre, withinBounds, withLayers, writePosition, type DragMoment } from './drag';

const scene = (rest: Partial<Scene> = {}): Scene => ({ id: 's', fps: 12, duration: 4, size: [1920, 1080], seed: 1, layers: [], ...rest });
const dot = (rest: Partial<Layer> = {}): Layer => ({ id: 'dot', rig: 'dot', params: { x: 100, y: 200 }, ...rest });
const moment = (rest: Partial<DragMoment> = {}): DragMoment => ({ frame: 24, fps: 12, range: null, ...rest });
const rig = (params: Rig['params']): Rig => ({ id: 'dot', params, draw() {} });
const num = (value: number) => ({ type: 'number' as const, default: value });

describe('dragDelta', () => {
  it('goes through the fit: half size on screen doubles the move', () => {
    const scale = dragScale(scene(), dot(), 0, 960);
    expect(dragDelta(10, -4, scale)).toEqual({ x: 20, y: -8 });
  });

  it('goes through a pixel stage: coordinates are the small stage', () => {
    const scale = dragScale(scene({ size: [1280, 720], pixel: { scale: 4 } }), dot(), 0, 1280);
    expect(dragDelta(8, 4, scale)).toEqual({ x: 2, y: 1 });
    expect(scale.whole).toBe(true);
  });

  it('goes through the camera, by depth', () => {
    const zoomed = scene({ camera: { zoom: 2 } });
    expect(dragDelta(10, 0, dragScale(zoomed, dot(), 0, 1920)).x).toBe(5);
    expect(dragDelta(9, 0, dragScale(zoomed, dot({ depth: 0.5 }), 0, 1920)).x).toBe(6);
    expect(dragDelta(10, 0, dragScale(zoomed, dot({ depth: 0 }), 0, 1920)).x).toBe(10);
  });

  it('follows a camera that moves', () => {
    const keyed = scene({ camera: { tracks: [{ param: 'zoom', keys: [{ t: 0, v: 1 }, { t: 2, v: 4 }] }] } });
    expect(dragDelta(8, 0, dragScale(keyed, dot(), 24, 1920)).x).toBe(2);
  });

  it('takes all of them at once', () => {
    const all = scene({ size: [1280, 720], pixel: { scale: 2 }, camera: { zoom: 3 } });
    expect(dragDelta(12, 0, dragScale(all, dot({ depth: 0.5 }), 0, 640)).x).toBe(6);
  });
});

describe('landing', () => {
  it('rounds to whole pixels on a pixel stage, to two decimals elsewhere', () => {
    expect(landValue(10.6, { fit: 1, pixel: 4, zoom: 1, whole: true })).toBe(11);
    expect(landValue(10.666, { fit: 1, pixel: 1, zoom: 1, whole: false })).toBe(10.67);
  });

  it("keeps a value inside its param's range", () => {
    expect(withinBounds(50, { type: 'number', default: 0, min: 0, max: 10 })).toBe(10);
    expect(withinBounds(-5, { type: 'number', default: 0, min: 0 })).toBe(0);
    expect(withinBounds(5, { type: 'string', default: '' })).toBe(5);
  });
});

describe('lockAxis', () => {
  it('keeps the axis it went further along', () => {
    expect(lockAxis(10, 3)).toEqual({ x: 10, y: 0 });
    expect(lockAxis(-3, 10)).toEqual({ x: 0, y: 10 });
  });
});

describe('centre lines', () => {
  it("are the stage's middle for a rig, and no offset for a clip", () => {
    expect(stageCentre(scene(), dot(), 0)).toEqual({ x: 960, y: 540 });
    expect(stageCentre(scene({ size: [1280, 720], pixel: { scale: 4 } }), dot(), 0)).toEqual({ x: 160, y: 90 });
    expect(stageCentre(scene({ camera: { x: 100 } }), dot(), 0)).toEqual({ x: 1060, y: 540 });
    expect(stageCentre(scene({ camera: { x: 100 } }), dot({ depth: 0 }), 0)).toEqual({ x: 960, y: 540 });
    expect(stageCentre(scene(), { id: 'c', scene: 'shot' }, 0)).toEqual({ x: 0, y: 0 });
  });

  it('pull a value within 6 screen pixels', () => {
    const half = dragScale(scene(), dot(), 0, 960);
    expect(snapCentre(971, 960, half)).toEqual({ value: 960, snapped: true });
    expect(snapCentre(973, 960, half)).toEqual({ value: 973, snapped: false });
  });
});

describe('movable', () => {
  const at = (layer: Layer, rigs: Rig[]) => movable(layer, scene(), 0, createRegistry(rigs), {});

  it("reads a rig's x and y on the frame", () => {
    const keyed = dot({ tracks: [{ param: 'x', keys: [{ t: 0, v: 7 }] }] });
    expect(at(keyed, [rig({ x: num(0), y: num(0) })])).toMatchObject({ x: 7, y: 200 });
  });

  it("falls back on the rig's defaults", () => {
    expect(at(dot({ params: {} }), [rig({ x: num(5), y: num(6) })])).toMatchObject({ x: 5, y: 6 });
  });

  it('is null without numeric x and y', () => {
    expect(at(dot({ params: {} }), [rig({ tone: { type: 'color', default: '#fff' } })])).toBeNull();
    expect(at(dot({ params: {} }), [rig({ x: { type: 'string', default: 'a' }, y: num(0) })])).toBeNull();
  });

  it('takes the placement of a clip', () => {
    expect(at({ id: 'c', scene: 'shot', params: { x: 4 } }, [])).toMatchObject({ x: 4, y: 0 });
    expect(at({ id: 'c', file: 'media/a.png' }, [])).toMatchObject({ x: 0, y: 0 });
  });
});

describe('writePosition', () => {
  const from = { x: 100, y: 200 };
  const to = { x: 150, y: 250 };
  const write = (layer: Layer, m = moment(), target = to) => {
    const result = writePosition(layer, target, from, m);
    if (!result.ok) throw new Error(result.error);
    return result.layer;
  };

  it('writes params when x and y are untracked', () => {
    expect(write(dot()).params).toEqual({ x: 150, y: 250 });
  });

  it('adds nothing for an axis that stayed', () => {
    const next = write(dot({ tracks: [{ param: 'y', keys: [{ t: 0, v: 200 }] }] }), moment(), { x: 150, y: 200 });
    expect(next.params).toEqual({ x: 150, y: 200 });
    expect(next.tracks?.[0].keys).toHaveLength(1);
  });

  it('inserts a key at the playhead for a tracked axis, with the ease of the key before', () => {
    const tracks = [{ param: 'x', keys: [{ t: 0, v: 0, ease: 'outBack' as const }, { t: 1, v: 10, ease: 'inOutCubic' as const }, { t: 3, v: 30 }] }];
    const next = write(dot({ tracks }));
    expect(next.tracks?.[0].keys).toEqual([tracks[0].keys[0], tracks[0].keys[1], { t: 2, v: 150, ease: 'inOutCubic' }, tracks[0].keys[2]]);
    expect(next.params).toEqual({ x: 100, y: 250 });
  });

  it('inserts no ease when the key before has none, or there is no key before', () => {
    const tracks = [{ param: 'x', keys: [{ t: 3, v: 30 }] }];
    expect(write(dot({ tracks })).tracks?.[0].keys[0]).toEqual({ t: 2, v: 150 });
  });

  it('updates a key already on the frame', () => {
    const tracks = [{ param: 'x', keys: [{ t: 2, v: 5, ease: 'outBack' as const }] }];
    expect(write(dot({ tracks })).tracks?.[0].keys).toEqual([{ t: 2, v: 150, ease: 'outBack' }]);
  });

  it("uses the layer's held time, so the key shows on this frame", () => {
    const tracks = [{ param: 'x', keys: [{ t: 0, v: 0 }] }];
    const next = write(dot({ tracks, stepFps: 6 }), moment({ frame: 25 }));
    expect(next.tracks?.[0].keys[1].t).toBe(2);
  });

  it('writes an override when a range is set around the playhead', () => {
    const next = write(dot(), moment({ range: { from: 12, to: 36 } }));
    expect(next.overrides).toEqual([{ from: 12, to: 36, params: { x: 150, y: 250 } }]);
    expect(next.params).toEqual(from);
  });

  it('keeps overrides in order', () => {
    const overrides = [{ from: 40, to: 44 }];
    expect(write(dot({ overrides }), moment({ range: { from: 12, to: 36 } })).overrides?.map((o) => o.from)).toEqual([12, 40]);
  });

  it('updates an override on exactly that range, keeping the rest of it', () => {
    const overrides = [{ from: 12, to: 36, rig: 'dot.torn', params: { tilt: 1, x: 3 } }];
    expect(write(dot({ overrides }), moment({ range: { from: 12, to: 36 } })).overrides).toEqual([{ from: 12, to: 36, rig: 'dot.torn', params: { tilt: 1, x: 150, y: 250 } }]);
  });

  it('refuses an override overlapping the range', () => {
    const result = writePosition(dot({ overrides: [{ from: 30, to: 40 }] }), to, from, moment({ range: { from: 12, to: 36 } }));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/override crossing 0:01–0:03/);
  });

  it('ignores a range the playhead is outside', () => {
    expect(write(dot(), moment({ range: { from: 30, to: 36 } })).overrides).toBeUndefined();
  });

  it('writes into an override already setting the axis on this frame, since it outranks the param', () => {
    const overrides = [{ from: 12, to: 36, params: { x: 3 } }];
    const next = write(dot({ overrides }));
    expect(next.overrides?.[0].params).toEqual({ x: 150 });
    expect(next.params).toEqual({ x: 100, y: 250 });
  });
});

describe('withLayers', () => {
  it('swaps layers and the background, and leaves the rest', () => {
    const base = scene({ background: { rig: 'paper' }, layers: [dot(), dot({ id: 'other' })] });
    const shown = withLayers(base, new Map([['dot', dot({ params: { x: 1 } })], ['background', { id: 'background', rig: 'fill' }]]));
    expect(shown.layers[0].params).toEqual({ x: 1 });
    expect(shown.layers[1]).toBe(base.layers[1]);
    expect(shown.background).toEqual({ rig: 'fill' });
    expect(base.background).toEqual({ rig: 'paper' });
  });
});
