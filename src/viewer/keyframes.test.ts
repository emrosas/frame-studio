import { describe, expect, it } from 'vitest';
import type { Layer, Track } from '../engine/types';
import { anchorKeys, deleteKeys, keyLanes, keyMarks, keysAt, keyTime, landRange, layerShiftRange, moveTarget, shiftLayer, shiftRange, type KeyTarget } from './keyframes';

const FPS = 12;
const TOTAL = 48;
const track = (param: string, ...times: number[]): Track => ({ param, keys: times.map((t, i) => ({ t, v: i })) });
const layer = (...tracks: Track[]): Layer => ({ id: 'a', rig: 'dot', tracks });
const times = (l: Layer, param: string) => l.tracks?.find((t) => t.param === param)?.keys.map((k) => k.t);
const move = (l: Layer, target: KeyTarget, to: number) => moveTarget(l, target, to, FPS, TOTAL);
const row = (frame: number): KeyTarget => ({ kind: 'key', layerId: 'a', param: null, frame });
const lane = (param: string, frame: number): KeyTarget => ({ kind: 'key', layerId: 'a', param, frame });

describe('keyMarks and keyLanes', () => {
  it('groups keys by frame, naming their params, in time order', () => {
    const marks = keyMarks([track('x', 1, 2), track('y', 1.01, 0.5)], FPS, TOTAL);
    expect(marks).toEqual([
      { frame: 6, at: 6, params: ['y'] },
      { frame: 12, at: 12, params: ['x', 'y'] },
      { frame: 24, at: 24, params: ['x'] },
    ]);
  });

  it('pins a key outside the scene to its edge, and keeps its real frame', () => {
    const marks = keyMarks([track('x', -1, 5)], FPS, TOTAL);
    expect(marks).toEqual([
      { frame: -12, at: 0, params: ['x'] },
      { frame: 60, at: 48, params: ['x'] },
    ]);
  });

  it('gives each param a lane', () => {
    const lanes = keyLanes([track('x', 1), track('y', 2)], FPS, TOTAL);
    expect(lanes.map((l) => [l.param, l.keys.map((k) => k.frame)])).toEqual([
      ['x', [12]],
      ['y', [24]],
    ]);
    expect(keyLanes(undefined, FPS, TOTAL)).toEqual([]);
  });
});

describe('keysAt', () => {
  it('takes every param on the row, one on a lane', () => {
    const tracks = [track('x', 1, 2), track('y', 1)];
    expect(keysAt(tracks, 12, FPS, null)).toEqual([
      { param: 'x', index: 0 },
      { param: 'y', index: 0 },
    ]);
    expect(keysAt(tracks, 12, FPS, 'y')).toEqual([{ param: 'y', index: 0 }]);
  });
});

describe('keyTime', () => {
  it('stays on its frame at any rate', () => {
    for (const fps of [12, 24, 25, 30]) {
      for (let frame = 0; frame < fps * 8; frame++) expect(Math.floor(keyTime(frame, fps) * fps + 1e-9)).toBe(frame);
    }
    expect(keyTime(3, 12)).toBe(0.25);
    expect(keyTime(1, 12)).toBe(0.083334);
  });
});

describe('moving a diamond', () => {
  it('moves one param on a lane, and every param at that time on the row', () => {
    const l = layer(track('x', 1, 2), track('y', 1, 3));
    expect(times(move(l, lane('x', 12), 18).layer, 'x')).toEqual([1.5, 2]);
    expect(times(move(l, lane('x', 12), 18).layer, 'y')).toEqual([1, 3]);
    const both = move(l, row(12), 6);
    expect(times(both.layer, 'x')).toEqual([0.5, 2]);
    expect(times(both.layer, 'y')).toEqual([0.5, 3]);
    expect(both.frame).toBe(6);
  });

  it('leaves values and easing alone', () => {
    const l: Layer = { id: 'a', rig: 'dot', tracks: [{ param: 'x', keys: [{ t: 1, v: 9, ease: 'inOutCubic' }] }] };
    expect(move(l, row(12), 24).layer.tracks![0].keys).toEqual([{ t: 2, v: 9, ease: 'inOutCubic' }]);
  });

  it('stops short of a neighbour of the same param, on either side', () => {
    const l = layer(track('x', 1, 2, 3));
    expect(move(l, lane('x', 24), 40)).toMatchObject({ frame: 35 });
    expect(move(l, lane('x', 24), 0)).toMatchObject({ frame: 13 });
  });

  it('stops by a neighbour between frames without touching it', () => {
    const l = layer(track('x', 1.01, 2, 2.99));
    expect(landRange(l.tracks!, keysAt(l.tracks, 24, FPS, 'x'), FPS, TOTAL)).toEqual({ min: 13, max: 35 });
  });

  it("isn't stopped by another param on the row or a lane", () => {
    const l = layer(track('x', 1), track('y', 2));
    expect(move(l, lane('x', 12), 30).frame).toBe(30);
  });

  it('stays inside the scene', () => {
    const l = layer(track('x', 1));
    expect(move(l, row(12), -5).frame).toBe(0);
    expect(move(l, row(12), 90).frame).toBe(48);
  });

  it('brings a key at a negative time back into the scene', () => {
    const l = layer(track('x', -1, 2));
    const moved = move(l, row(-12), 6);
    expect(times(moved.layer, 'x')).toEqual([0.5, 2]);
    expect(moved.frame).toBe(6);
    expect(times(move(l, row(-12), -3).layer, 'x')).toEqual([0, 2]);
  });

  it('gives back the same layer when it lands where it was', () => {
    const l = layer(track('x', 1));
    expect(move(l, row(12), 12).layer).toBe(l);
  });

  it('keeps two keys of one track in one frame apart', () => {
    const l = layer(track('x', 1, 1.02));
    expect(times(move(l, row(12), 24).layer, 'x')).toEqual([2, 2.02]);
  });

  it('snaps a key between frames onto its frame', () => {
    const l = layer(track('opacity', 3.45));
    expect(times(move(l, row(41), 42).layer, 'opacity')).toEqual([3.5]);
  });
});

describe('shifting a layer', () => {
  it('leaves a key before the scene there, shifted by frames', () => {
    expect(times(shiftLayer(layer(track('opacity', -0.1, 0.05)), -1, FPS), 'opacity')?.[0]).toBeLessThan(-0.1);
  });

  const l: Layer = { ...layer(track('x', 1, 2), track('opacity', 0.5, 3)), overrides: [{ from: 18, to: 30 }] };

  it("moves all its keys and overrides, and a mask's keys", () => {
    const masked = { ...l, mask: { rig: 'dot', tracks: [track('x', 1)] } };
    const moved = move(masked, { kind: 'bar', layerId: 'a' }, 6).layer;
    expect(times(moved, 'x')).toEqual([1.5, 2.5]);
    expect(times(moved, 'opacity')).toEqual([1, 3.5]);
    expect(moved.overrides).toEqual([{ from: 24, to: 36 }]);
    expect(moved.mask?.tracks?.[0].keys[0].t).toBe(1.5);
  });

  it('keeps every key and override in the scene', () => {
    expect(layerShiftRange(l, FPS, TOTAL)).toEqual({ min: -6, max: 12 });
    expect(times(move(l, { kind: 'bar', layerId: 'a' }, 100).layer, 'opacity')).toEqual([1.5, 4]);
    expect(move(l, { kind: 'bar', layerId: 'a' }, -100).layer.overrides).toEqual([{ from: 12, to: 24 }]);
  });

  it('keeps a key between frames between frames', () => {
    expect(times(shiftLayer(layer(track('opacity', 3.45)), 6, FPS), 'opacity')).toEqual([3.95]);
  });

  it("doesn't let a key already outside the scene hold the rest back", () => {
    expect(layerShiftRange(layer(track('x', -1, 2)), FPS, TOTAL)).toEqual({ min: -24, max: 24 });
  });
});

describe("moving a fade's pair of keys", () => {
  const l = layer({ param: 'opacity', keys: [{ t: 1, v: 0 }, { t: 1.5, v: 1 }, { t: 3, v: 1 }, { t: 3.5, v: 0 }] });
  const edge: KeyTarget = { kind: 'edge', layerId: 'a', pair: [0, 1] };

  it('moves the two together and keeps the fade its length', () => {
    expect(times(move(l, edge, 6).layer, 'opacity')).toEqual([1.5, 2, 3, 3.5]);
  });

  it('stops short of the next key, and at the start', () => {
    expect(shiftRange(l.tracks!, edge.pair.map((index) => ({ param: 'opacity', index })), FPS, TOTAL)).toEqual({ min: -12, max: 17 });
    expect(times(move(l, edge, 90).layer, 'opacity')?.[1]).toBeCloseTo(2.916667, 5);
  });
});

describe('deleteKeys', () => {
  it('removes a key and leaves the track', () => {
    const next = deleteKeys(layer(track('x', 1, 2)), [{ param: 'x', index: 0 }]);
    expect(times(next, 'x')).toEqual([2]);
  });

  it("removes a track with its last key, and writes the value to the param", () => {
    const l: Layer = { id: 'a', rig: 'dot', params: { y: 3 }, tracks: [{ param: 'x', keys: [{ t: 1, v: 40 }] }] };
    expect(deleteKeys(l, [{ param: 'x', index: 0 }])).toEqual({ id: 'a', rig: 'dot', params: { y: 3, x: 40 } });
  });

  it('keeps other tracks, and non-numeric values', () => {
    const l: Layer = { id: 'a', rig: 'dot', tracks: [{ param: 'pose', keys: [{ t: 1, v: 'fly' }] }, track('x', 1)] };
    expect(deleteKeys(l, [{ param: 'pose', index: 0 }])).toEqual({ id: 'a', rig: 'dot', params: { pose: 'fly' }, tracks: [track('x', 1)] });
  });
});

describe('word anchors (ADR 0016)', () => {
  const FPS_ = 12;
  const anchored: Layer = { id: 'a', rig: 'circle', tracks: [{ param: 'x', keys: [{ t: 1, v: 0, word: 'voice#w1' }, { t: 2, v: 1 }] }] };

  it('marks the diamond of an anchored key', () => {
    expect(keyMarks(anchored.tracks, FPS_, 48).map((m) => m.anchored ?? false)).toEqual([true, false]);
  });

  it('dragging a key lets go of its word', () => {
    const { layer } = moveTarget(anchored, { kind: 'key', layerId: 'a', param: 'x', frame: 12 }, 15, FPS_, 48);
    expect(layer.tracks![0].keys[0]).toEqual({ t: 1.25, v: 0 });
    expect(keyMarks(layer.tracks, FPS_, 48)[0].anchored).toBeUndefined();
  });

  it('a key that lands where it was keeps its word', () => {
    const { layer } = moveTarget(anchored, { kind: 'key', layerId: 'a', param: 'x', frame: 12 }, 12, FPS_, 48);
    expect(layer.tracks![0].keys[0].word).toBe('voice#w1');
  });

  it('shifting a layer lets go too', () => {
    expect(shiftLayer(anchored, 2, FPS_).tracks![0].keys[0].word).toBeUndefined();
  });

  it('anchors keys at the word, in time order', () => {
    const next = anchorKeys(anchored, [{ param: 'x', index: 1 }], 'voice#w0', 0.5);
    expect(next.tracks![0].keys.map((k) => [k.t, k.word])).toEqual([[0.5, 'voice#w0'], [1, 'voice#w1']]);
  });
});
