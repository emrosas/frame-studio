import { describe, expect, it } from 'vitest';
import { EASING_NAMES, ease, easings } from './easing';
import type { EasingName } from './types';

const ALL: EasingName[] = [
  'linear', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic',
  'inQuart', 'outQuart', 'inOutQuart', 'inSine', 'outSine', 'inOutSine',
  'inExpo', 'outExpo', 'inOutExpo', 'inBack', 'outBack', 'inOutBack',
];

describe('easing table', () => {
  it('EASING_NAMES lists every easing exactly once', () => {
    expect([...EASING_NAMES].sort()).toEqual([...ALL].sort());
    expect(Object.keys(easings).sort()).toEqual([...ALL].sort());
  });

  it.each(ALL)('%s returns exactly 0 at u=0 and exactly 1 at u=1', (name) => {
    expect(Object.is(easings[name](0), 0)).toBe(true);
    expect(easings[name](1)).toBe(1);
    expect(Object.is(ease(name, 0), 0)).toBe(true);
    expect(ease(name, 1)).toBe(1);
  });

  it.each(ALL)('%s stays finite across [0, 1]', (name) => {
    for (let i = 0; i <= 100; i++) {
      expect(Number.isFinite(easings[name](i / 100))).toBe(true);
    }
  });

  it.each(ALL.filter((n) => n.startsWith('inOut')))('%s passes through 0.5 at the midpoint', (name) => {
    expect(easings[name](0.5)).toBeCloseTo(0.5, 12);
  });

  // The exact-endpoint test above only checks the clamp in `pinned`. These
  // check that each formula itself arrives where the clamp says it does, so a
  // typo cannot pop the last frame of a move.
  it.each(ALL)('%s runs into its endpoints without a jump', (name) => {
    // inExpo and outExpo sit 2^-10 (about 0.001) off their ends by design.
    expect(Math.abs(easings[name](1e-9))).toBeLessThan(2e-3);
    expect(Math.abs(easings[name](1 - 1e-9) - 1)).toBeLessThan(2e-3);
  });

  it.each(ALL.filter((n) => n.startsWith('inOut')))('%s joins its two halves at u = 0.5', (name) => {
    expect(easings[name](0.5 - 1e-9)).toBeCloseTo(easings[name](0.5 + 1e-9), 6);
  });
});

/** easings.net values at u = 0.25 and 0.75, written out so a changed formula fails here. */
const REFERENCE: Record<EasingName, [number, number]> = {
  linear: [0.25, 0.75],
  inQuad: [0.0625, 0.5625],
  outQuad: [0.4375, 0.9375],
  inOutQuad: [0.125, 0.875],
  inCubic: [0.015625, 0.421875],
  outCubic: [0.578125, 0.984375],
  inOutCubic: [0.0625, 0.9375],
  inQuart: [0.00390625, 0.31640625],
  outQuart: [0.68359375, 0.99609375],
  inOutQuart: [0.03125, 0.96875],
  inSine: [0.0761204674887, 0.617316567635],
  outSine: [0.382683432365, 0.923879532511],
  inOutSine: [0.146446609407, 0.853553390593],
  inExpo: [0.00552427172802, 0.176776695297],
  outExpo: [0.823223304703, 0.994475728272],
  inOutExpo: [0.015625, 0.984375],
  inBack: [-0.0641365625, 0.1825903125],
  outBack: [0.8174096875, 1.0641365625],
  inOutBack: [-0.09968184375, 1.09968184375],
};

describe('easing shapes', () => {
  it.each(ALL)('%s matches its reference values at u = 0.25 and 0.75', (name) => {
    expect(easings[name](0.25)).toBeCloseTo(REFERENCE[name][0], 10);
    expect(easings[name](0.75)).toBeCloseTo(REFERENCE[name][1], 10);
  });

  it('matches known values', () => {
    expect(easings.linear(0.3)).toBe(0.3);
    expect(easings.inQuad(0.5)).toBe(0.25);
    expect(easings.outQuad(0.5)).toBe(0.75);
    expect(easings.inCubic(0.5)).toBe(0.125);
    expect(easings.inQuart(0.5)).toBe(0.0625);
    expect(easings.inOutCubic(0.25)).toBeCloseTo(0.0625, 12);
    expect(easings.inSine(0.5)).toBeCloseTo(1 - Math.cos(Math.PI / 4), 12);
    expect(easings.inExpo(0.5)).toBeCloseTo(Math.pow(2, -5), 12);
  });

  it('in easings start slow, out easings start fast', () => {
    for (const kind of ['Quad', 'Cubic', 'Quart', 'Sine', 'Expo'] as const) {
      expect(easings[`in${kind}`](0.25)).toBeLessThan(0.25);
      expect(easings[`out${kind}`](0.25)).toBeGreaterThan(0.25);
    }
  });

  it('back easings overshoot', () => {
    expect(easings.inBack(0.2)).toBeLessThan(0);
    expect(easings.outBack(0.8)).toBeGreaterThan(1);
    expect(easings.inOutBack(0.1)).toBeLessThan(0);
    expect(easings.inOutBack(0.9)).toBeGreaterThan(1);
  });
});

describe('ease()', () => {
  it('undefined means linear', () => {
    for (const u of [0, 0.1, 0.5, 0.77, 1]) expect(ease(undefined, u)).toBe(u);
  });

  it('clamps u to [0, 1]', () => {
    for (const name of ALL) {
      expect(ease(name, -0.5)).toBe(0);
      expect(ease(name, -Infinity)).toBe(0);
      expect(ease(name, 1.5)).toBe(1);
      expect(ease(name, Infinity)).toBe(1);
    }
    expect(ease(undefined, 2)).toBe(1);
    expect(ease(undefined, -2)).toBe(0);
  });

  it('delegates to the named easing inside [0, 1]', () => {
    expect(ease('inQuad', 0.5)).toBe(0.25);
    expect(ease('outBack', 0.8)).toBe(easings.outBack(0.8));
  });
});
