import { describe, expect, it } from 'vitest';
import { easings } from './easing';
import { evaluateTrack, evaluateTracks } from './tracks';
import type { Track } from './types';

const x: Track = {
  param: 'x',
  keys: [
    { t: 1, v: 100 },
    { t: 3, v: 500, ease: 'inQuad' },
    { t: 4, v: 0 },
  ],
};

describe('evaluateTrack (numbers)', () => {
  it('holds the first value before the first key', () => {
    expect(evaluateTrack(x, 0)).toBe(100);
    expect(evaluateTrack(x, -10)).toBe(100);
  });

  it('holds the last value after the last key', () => {
    expect(evaluateTrack(x, 4.0001)).toBe(0);
    expect(evaluateTrack(x, 1000)).toBe(0);
  });

  it('returns key values exactly at key times', () => {
    expect(evaluateTrack(x, 1)).toBe(100);
    expect(evaluateTrack(x, 3)).toBe(500);
    expect(evaluateTrack(x, 4)).toBe(0);
  });

  it('interpolates with the easing of the ARRIVING key', () => {
    // segment 1 -> 3 arrives at a key with ease inQuad
    expect(evaluateTrack(x, 2)).toBe(100 + 400 * easings.inQuad(0.5));
    expect(evaluateTrack(x, 2)).toBe(200);
    expect(evaluateTrack(x, 1.5)).toBe(100 + 400 * easings.inQuad(0.25));
    // segment 3 -> 4 arrives at a key with no ease: linear
    expect(evaluateTrack(x, 3.5)).toBe(250);
    expect(evaluateTrack(x, 3.25)).toBe(375);
  });

  it('a single key is constant', () => {
    const one: Track = { param: 'x', keys: [{ t: 2, v: 7 }] };
    for (const t of [-1, 0, 2, 5]) expect(evaluateTrack(one, t)).toBe(7);
  });

  it('works with many keys', () => {
    const keys = Array.from({ length: 200 }, (_, i) => ({ t: i, v: i * 10 }));
    const track: Track = { param: 'x', keys };
    for (let i = 0; i < 199; i++) {
      expect(evaluateTrack(track, i)).toBe(i * 10);
      expect(evaluateTrack(track, i + 0.5)).toBe(i * 10 + 5);
    }
  });

  it('throws a readable error on an empty track', () => {
    expect(() => evaluateTrack({ param: 'x', keys: [] }, 0)).toThrow(/"x".*no keys/);
  });
});

describe('evaluateTrack (non-numeric values step)', () => {
  const pose: Track = {
    param: 'pose',
    keys: [
      { t: 0, v: 'idle' },
      { t: 2, v: 'fly', ease: 'inOutCubic' },
      { t: 3, v: 'land' },
    ],
  };

  it('strings step, holding the earlier value until the next key time', () => {
    expect(evaluateTrack(pose, -1)).toBe('idle');
    expect(evaluateTrack(pose, 0)).toBe('idle');
    expect(evaluateTrack(pose, 1.999)).toBe('idle');
    expect(evaluateTrack(pose, 2)).toBe('fly');
    expect(evaluateTrack(pose, 2.9)).toBe('fly');
    expect(evaluateTrack(pose, 3)).toBe('land');
    expect(evaluateTrack(pose, 9)).toBe('land');
  });

  it('booleans step', () => {
    const visible: Track = { param: 'visible', keys: [{ t: 0, v: true }, { t: 1, v: false }, { t: 2, v: true }] };
    expect(evaluateTrack(visible, 0.5)).toBe(true);
    expect(evaluateTrack(visible, 0.999)).toBe(true);
    expect(evaluateTrack(visible, 1)).toBe(false);
    expect(evaluateTrack(visible, 1.5)).toBe(false);
    expect(evaluateTrack(visible, 2)).toBe(true);
  });

  it('mixed number/string segments step', () => {
    const mixed: Track = { param: 'm', keys: [{ t: 0, v: 1 }, { t: 1, v: 'auto' }, { t: 2, v: 5 }, { t: 3, v: 10 }] };
    expect(evaluateTrack(mixed, 0.5)).toBe(1);
    expect(evaluateTrack(mixed, 1.5)).toBe('auto');
    expect(evaluateTrack(mixed, 2)).toBe(5);
    expect(evaluateTrack(mixed, 2.5)).toBe(7.5);
  });

  it('number/boolean segments step', () => {
    const mixed: Track = { param: 'm', keys: [{ t: 0, v: 0 }, { t: 1, v: true }] };
    expect(evaluateTrack(mixed, 0.5)).toBe(0);
    expect(evaluateTrack(mixed, 1)).toBe(true);
  });
});

describe('evaluateTracks', () => {
  it('returns an empty object for no tracks', () => {
    expect(evaluateTracks(undefined, 1)).toEqual({});
    expect(evaluateTracks([], 1)).toEqual({});
  });

  it('maps each track param to its value', () => {
    const tracks: Track[] = [
      x,
      { param: 'pose', keys: [{ t: 0, v: 'idle' }, { t: 2, v: 'fly' }] },
    ];
    expect(evaluateTracks(tracks, 2)).toEqual({ x: 200, pose: 'fly' });
    expect(evaluateTracks(tracks, 0)).toEqual({ x: 100, pose: 'idle' });
  });
});
