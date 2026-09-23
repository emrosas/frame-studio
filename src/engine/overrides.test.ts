import { describe, expect, it } from 'vitest';
import { activeOverride } from './overrides';
import type { Override } from './types';

describe('activeOverride', () => {
  const a: Override = { from: 36, to: 48, rig: 'fly.wingTorn' };
  const b: Override = { from: 48, to: 50, params: { x: 1 } };
  const c: Override = { from: 0, to: 1, params: { y: 2 } };
  const overrides = [a, b, c];

  it('uses [from, to) boundaries', () => {
    expect(activeOverride([a], 35)).toBeUndefined(); // from - 1
    expect(activeOverride([a], 36)).toBe(a); // from
    expect(activeOverride([a], 47)).toBe(a); // to - 1
    expect(activeOverride([a], 48)).toBeUndefined(); // to
  });

  it('picks the right override among touching ranges', () => {
    expect(activeOverride(overrides, 47)).toBe(a);
    expect(activeOverride(overrides, 48)).toBe(b);
    expect(activeOverride(overrides, 49)).toBe(b);
    expect(activeOverride(overrides, 50)).toBeUndefined();
    expect(activeOverride(overrides, 0)).toBe(c);
    expect(activeOverride(overrides, 1)).toBeUndefined();
  });

  it('returns undefined with no overrides', () => {
    expect(activeOverride(undefined, 3)).toBeUndefined();
    expect(activeOverride([], 3)).toBeUndefined();
  });

  it('a one-frame range covers exactly one frame', () => {
    const one: Override = { from: 5, to: 6 };
    expect(activeOverride([one], 4)).toBeUndefined();
    expect(activeOverride([one], 5)).toBe(one);
    expect(activeOverride([one], 6)).toBeUndefined();
  });
});
