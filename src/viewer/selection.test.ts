import { describe, expect, it } from 'vitest';
import {
  CHEVRON,
  describeRange,
  editRangeEnd,
  isRepeatClick,
  layerLabel,
  markIn,
  markOut,
  nextCandidate,
  parseFrameText,
  rangeError,
  resolveSelectionParams,
  sceneShape,
  type SceneShape,
} from './selection';
import type { Rig, RigRegistry, Scene } from '../engine/types';

describe('markIn and markOut (I and O)', () => {
  const N = 72;

  it('I with no range runs from the frame on screen to the end', () => {
    expect(markIn(null, 10, N)).toEqual({ from: 10, to: 72 });
  });

  it('O with no range runs from the start to and including the frame on screen', () => {
    expect(markOut(null, 30, N)).toEqual({ from: 0, to: 31 });
  });

  it('I then O gives [in, out + 1)', () => {
    expect(markOut(markIn(null, 10, N), 30, N)).toEqual({ from: 10, to: 31 });
    // O then I too.
    expect(markIn(markOut(null, 30, N), 10, N)).toEqual({ from: 10, to: 31 });
  });

  it('I on the out frame keeps a one-frame range', () => {
    expect(markIn({ from: 10, to: 31 }, 30, N)).toEqual({ from: 30, to: 31 });
  });

  it('I past the out point moves out to in + 1', () => {
    expect(markIn({ from: 10, to: 31 }, 31, N)).toEqual({ from: 31, to: 32 });
    expect(markIn({ from: 10, to: 31 }, 50, N)).toEqual({ from: 50, to: 51 });
  });

  it('O on the in frame keeps a one-frame range', () => {
    expect(markOut({ from: 10, to: 31 }, 10, N)).toEqual({ from: 10, to: 11 });
  });

  it('clamps frames like the clock, non-finite ones included', () => {
    expect(markIn(null, Infinity, N)).toEqual({ from: 71, to: 72 });
    expect(markOut(null, -Infinity, N)).toEqual({ from: 0, to: 1 });
    expect(markOut(null, NaN, N)).toEqual({ from: 0, to: 1 });
  });

  it('O before the in point moves in to out - 1', () => {
    expect(markOut({ from: 10, to: 31 }, 9, N)).toEqual({ from: 9, to: 10 });
    expect(markOut({ from: 10, to: 31 }, 0, N)).toEqual({ from: 0, to: 1 });
  });

  it('works on the last frame and clamps frames into the scene', () => {
    expect(markIn(null, 71, N)).toEqual({ from: 71, to: 72 });
    expect(markOut(null, 71, N)).toEqual({ from: 0, to: 72 });
    expect(markIn(null, 500, N)).toEqual({ from: 71, to: 72 });
    expect(markOut(null, -3, N)).toEqual({ from: 0, to: 1 });
  });
});

describe('rangeError', () => {
  it('accepts integer [from, to) inside the scene', () => {
    expect(rangeError(0, 72, 72)).toBeNull();
    expect(rangeError(71, 72, 72)).toBeNull();
    expect(rangeError(5, 6, 72)).toBeNull();
  });

  it('rejects empty, reversed, out-of-scene and non-integer ranges', () => {
    expect(rangeError(5, 5, 72)).toMatch(/before/);
    expect(rangeError(6, 5, 72)).toMatch(/before/);
    expect(rangeError(-1, 5, 72)).toMatch(/from/);
    expect(rangeError(0, 73, 72)).toMatch(/to/);
    expect(rangeError(72, 73, 72)).toMatch(/from|to/);
    expect(rangeError(1.5, 5, 72)).toMatch(/integer/);
    expect(rangeError(1, Number.NaN, 72)).toMatch(/integer/);
    expect(rangeError('1', 5, 72)).toMatch(/integer/);
  });
});

describe('parseFrameText', () => {
  it('reads frame numbers', () => {
    expect(parseFrameText('12', 12)).toEqual({ ok: true, frame: 12 });
    expect(parseFrameText('  0 ', 12)).toEqual({ ok: true, frame: 0 });
  });

  it('reads MM:SS:FF timecodes at the scene fps', () => {
    expect(parseFrameText('00:03:05', 12)).toEqual({ ok: true, frame: 41 });
    expect(parseFrameText('00:01:00', 24)).toEqual({ ok: true, frame: 24 });
    expect(parseFrameText('0:1:0', 24)).toEqual({ ok: true, frame: 24 });
  });

  it('rejects anything else with a message', () => {
    for (const bad of ['', '  ', 'abc', '-3', '1.5', '1e3', '00:03', '00:60:00', '00:00:12']) {
      const r = parseFrameText(bad, 12);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('editRangeEnd (typed from and to)', () => {
  const N = 72;
  const fps = 12;

  it('sets from or to on an existing range', () => {
    expect(editRangeEnd({ from: 10, to: 31 }, 'from', '20', fps, N)).toEqual({ ok: true, range: { from: 20, to: 31 } });
    expect(editRangeEnd({ from: 10, to: 31 }, 'to', '00:04:00', fps, N)).toEqual({ ok: true, range: { from: 10, to: 48 } });
  });

  it('starts from the whole scene when no range is set', () => {
    expect(editRangeEnd(null, 'from', '12', fps, N)).toEqual({ ok: true, range: { from: 12, to: 72 } });
    expect(editRangeEnd(null, 'to', '24', fps, N)).toEqual({ ok: true, range: { from: 0, to: 24 } });
  });

  it('takes to as exclusive: the end of the scene is allowed, as a number or its timecode', () => {
    expect(editRangeEnd(null, 'to', '72', fps, N)).toEqual({ ok: true, range: { from: 0, to: 72 } });
    expect(editRangeEnd(null, 'to', '00:06:00', fps, N)).toEqual({ ok: true, range: { from: 0, to: 72 } });
  });

  it('reads an emptied field as that end of the scene', () => {
    expect(editRangeEnd({ from: 10, to: 31 }, 'from', '  ', fps, N)).toEqual({ ok: true, range: { from: 0, to: 31 } });
    expect(editRangeEnd({ from: 10, to: 31 }, 'to', '', fps, N)).toEqual({ ok: true, range: { from: 10, to: 72 } });
  });

  it('rejects unreadable input, frames outside the scene and empty ranges', () => {
    expect(editRangeEnd({ from: 10, to: 31 }, 'from', 'soon', fps, N).ok).toBe(false);
    expect(editRangeEnd({ from: 10, to: 31 }, 'from', '72', fps, N).ok).toBe(false);
    expect(editRangeEnd({ from: 10, to: 31 }, 'to', '73', fps, N).ok).toBe(false);
    expect(editRangeEnd({ from: 10, to: 31 }, 'to', '0', fps, N).ok).toBe(false);
    expect(editRangeEnd({ from: 10, to: 31 }, 'from', '31', fps, N).ok).toBe(false);
    expect(editRangeEnd({ from: 10, to: 31 }, 'to', '10', fps, N).ok).toBe(false);
    const r = editRangeEnd({ from: 10, to: 31 }, 'from', '40', fps, N);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/before/);
  });
});

describe('describeRange', () => {
  it('shows [from, to) with both timecodes and the frame count', () => {
    expect(describeRange({ from: 12, to: 36 }, 12, 72)).toEqual({ interval: '[12, 36)', timecodes: '00:01:00 – 00:03:00', count: '24 frames' });
    expect(describeRange({ from: 5, to: 6 }, 12, 72).count).toBe('1 frame');
  });

  it('says "all frames" without a range', () => {
    expect(describeRange(null, 12, 72)).toEqual({ interval: 'all frames', timecodes: '', count: '72 frames' });
  });
});

describe('layerLabel', () => {
  it('joins layer and part with a chevron', () => {
    expect(CHEVRON).toBe('›');
    expect(layerLabel('bear', 'nose')).toBe('bear › nose');
    expect(layerLabel('bear', null)).toBe('bear');
    expect(layerLabel(null, null)).toBe('');
  });
});

describe('click cycling', () => {
  const first = { scene: 'v1', frame: 12, x: 100, y: 200, layerId: 'star' };

  it('counts a click as a repeat within 4 CSS px, on the same frame and scene, while the last pick is still selected', () => {
    expect(isRepeatClick(first, { scene: 'v1', frame: 12, x: 100, y: 200 }, 'star')).toBe(true);
    expect(isRepeatClick(first, { scene: 'v1', frame: 12, x: 103, y: 202 }, 'star')).toBe(true);
    expect(isRepeatClick(first, { scene: 'v1', frame: 12, x: 104, y: 200 }, 'star')).toBe(true);
  });

  it('starts over when the click moved, the frame or scene changed, or the selection changed since', () => {
    expect(isRepeatClick(null, { scene: 'v1', frame: 12, x: 100, y: 200 }, 'star')).toBe(false);
    expect(isRepeatClick(first, { scene: 'v1', frame: 12, x: 104, y: 201 }, 'star')).toBe(false);
    expect(isRepeatClick(first, { scene: 'v1', frame: 13, x: 100, y: 200 }, 'star')).toBe(false);
    expect(isRepeatClick(first, { scene: 'v2', frame: 12, x: 100, y: 200 }, 'star')).toBe(false);
    expect(isRepeatClick(first, { scene: 'v1', frame: 12, x: 100, y: 200 }, null)).toBe(false);
    expect(isRepeatClick(first, { scene: 'v1', frame: 12, x: 100, y: 200 }, 'block')).toBe(false);
    expect(isRepeatClick({ ...first, layerId: null }, { scene: 'v1', frame: 12, x: 100, y: 200 }, null)).toBe(false);
  });

  it('steps through candidates top to bottom and back to the top', () => {
    const ids = ['star', 'onTwos', 'background'];
    expect(nextCandidate(ids, 'star')).toBe('onTwos');
    expect(nextCandidate(ids, 'onTwos')).toBe('background');
    expect(nextCandidate(ids, 'background')).toBe('star');
    // The current pick is not under the pointer any more: start at the top.
    expect(nextCandidate(ids, 'block')).toBe('star');
    expect(nextCandidate(['background'], 'background')).toBe('background');
    expect(nextCandidate([], 'star')).toBeNull();
  });
});

describe('resolveSelectionParams (URL values against the scene)', () => {
  const shape: SceneShape = {
    fps: 12,
    frameCount: 72,
    layers: new Map<string, readonly string[]>([
      ['background', []],
      ['bear', ['ears', 'body', 'nose']],
      ['star', []],
    ]),
  };
  const none = { layer: null, part: null, from: null, to: null };

  it('keeps a valid layer, part and range', () => {
    expect(resolveSelectionParams({ layer: 'bear', part: 'nose', from: '12', to: '36' }, shape)).toEqual({
      layerId: 'bear',
      partId: 'nose',
      range: { from: 12, to: 36 },
      ignored: [],
    });
  });

  it('reads range ends as timecodes too, and fills a missing end from the scene', () => {
    expect(resolveSelectionParams({ ...none, from: '00:01:00', to: '00:03:00' }, shape).range).toEqual({ from: 12, to: 36 });
    expect(resolveSelectionParams({ ...none, from: '12' }, shape).range).toEqual({ from: 12, to: 72 });
    expect(resolveSelectionParams({ ...none, to: '36' }, shape).range).toEqual({ from: 0, to: 36 });
  });

  it('returns nothing for nothing', () => {
    expect(resolveSelectionParams(none, shape)).toEqual({ layerId: null, partId: null, range: null, ignored: [] });
  });

  it('ignores an unknown layer, and a part without a valid layer or unknown to its rig', () => {
    expect(resolveSelectionParams({ ...none, layer: 'ghost', part: 'nose' }, shape)).toMatchObject({ layerId: null, partId: null });
    expect(resolveSelectionParams({ ...none, part: 'nose' }, shape)).toMatchObject({ layerId: null, partId: null });
    const r = resolveSelectionParams({ ...none, layer: 'star', part: 'nose' }, shape);
    expect(r).toMatchObject({ layerId: 'star', partId: null });
    expect(r.ignored.length).toBe(1);
  });

  it('ignores a bad range as a whole', () => {
    for (const [from, to] of [
      ['36', '12'],
      ['12', '12'],
      ['12', '73'],
      ['-1', '5'],
      ['x', '5'],
      ['1.5', '5'],
    ]) {
      const r = resolveSelectionParams({ ...none, layer: 'star', from, to }, shape);
      expect(r.range, `${from}..${to}`).toBeNull();
      expect(r.layerId).toBe('star');
      expect(r.ignored.length).toBe(1);
    }
  });
});

describe('sceneShape', () => {
  const rig = (id: string, parts?: string[]): Rig => ({ id, params: {}, parts, draw() {} });
  const registry: RigRegistry = new Map([
    ['paper', rig('paper')],
    ['bear', rig('bear', ['ears', 'body'])],
    ['bear.bandaged', rig('bear.bandaged', ['ears', 'body', 'plaster'])],
  ]);
  const scene: Scene = {
    id: 's',
    fps: 12,
    duration: 2,
    size: [100, 100],
    seed: 1,
    background: { rig: 'paper' },
    layers: [
      { id: 'a', rig: 'bear', overrides: [{ from: 2, to: 4, rig: 'bear.bandaged' }] },
      { id: 'b', rig: 'bear' },
    ],
  };

  it('lists layers in draw order with the parts of their rigs and override rigs', () => {
    const shape = sceneShape(scene, registry, 24);
    expect(shape.fps).toBe(12);
    expect(shape.frameCount).toBe(24);
    expect([...shape.layers.keys()]).toEqual(['background', 'a', 'b']);
    expect(shape.layers.get('background')).toEqual([]);
    expect(shape.layers.get('a')).toEqual(['ears', 'body', 'plaster']);
    expect(shape.layers.get('b')).toEqual(['ears', 'body']);
  });
});
