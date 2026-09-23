import { describe, expect, it } from 'vitest';
import { frameCount, frameToTime, quantizeTime, timeToFrame } from './time';

const FPS_LIST = [1, 12, 24, 25, 30, 60];

describe('frameToTime / timeToFrame', () => {
  it('frameToTime is frame / fps', () => {
    expect(frameToTime(0, 12)).toBe(0);
    expect(frameToTime(12, 12)).toBe(1);
    expect(frameToTime(6, 12)).toBe(0.5);
  });

  it('timeToFrame floors', () => {
    expect(timeToFrame(0, 12)).toBe(0);
    expect(timeToFrame(0.99, 1)).toBe(0);
    expect(timeToFrame(1, 1)).toBe(1);
    expect(timeToFrame(0.5 + 1 / 48, 12)).toBe(6);
  });

  it('timeToFrame absorbs float error that lands just below a whole frame', () => {
    expect(1.16 * 25).toBe(28.999999999999996);
    expect(timeToFrame(1.16, 25)).toBe(29);
  });

  for (const fps of FPS_LIST) {
    it(`round-trips every frame for one hour at ${fps} fps`, () => {
      const last = fps * 3600;
      for (let f = 0; f <= last; f++) {
        const back = timeToFrame(frameToTime(f, fps), fps);
        if (back !== f) {
          expect(back, `frame ${f} at ${fps} fps`).toBe(f);
        }
      }
    });
  }
});

describe('frameCount', () => {
  it('uses integer frame counts exactly', () => {
    expect(frameCount({ fps: 12, duration: 10 })).toBe(120);
    expect(frameCount({ fps: 24, duration: 1 })).toBe(24);
    expect(frameCount({ fps: 30, duration: 0.1 })).toBe(3);
    expect(frameCount({ fps: 60, duration: 0.7 })).toBe(42);
  });

  it('absorbs float error that lands just above a whole frame count', () => {
    expect(8.3 * 30).toBe(249.00000000000003);
    expect(frameCount({ fps: 30, duration: 8.3 })).toBe(249);
    expect(0.28 * 25).toBe(7.000000000000001);
    expect(frameCount({ fps: 25, duration: 0.28 })).toBe(7);
  });

  it('rounds non-integer frame counts up so the tail is covered', () => {
    expect(frameCount({ fps: 12, duration: 1.05 })).toBe(13); // 12.6
    expect(frameCount({ fps: 24, duration: 0.01 })).toBe(1); // 0.24
    expect(frameCount({ fps: 25, duration: 2.5 })).toBe(63); // 62.5
  });
});

describe('quantizeTime', () => {
  it('undefined stepFps equals frame / fps', () => {
    for (let f = 0; f < 100; f++) {
      expect(quantizeTime(f, 12)).toBe(f / 12);
      expect(quantizeTime(f, 30, undefined)).toBe(f / 30);
    }
  });

  it('stepFps 6 at fps 12 holds frames in pairs', () => {
    for (let k = 0; k < 60; k++) {
      const a = quantizeTime(2 * k, 12, 6);
      const b = quantizeTime(2 * k + 1, 12, 6);
      expect(a).toBe(b);
      expect(a).toBe(k / 6);
      expect(a).toBe(frameToTime(2 * k, 12));
    }
  });

  it('stepFps === fps is identity', () => {
    for (const fps of FPS_LIST) {
      for (let f = 0; f < fps * 4; f++) {
        expect(quantizeTime(f, fps, fps)).toBe(f / fps);
      }
    }
  });

  it('handles a non-divisor stepFps (fps 30, stepFps 12)', () => {
    const values: number[] = [];
    for (let f = 0; f < 30; f++) values.push(quantizeTime(f, 30, 12));
    // never ahead of real time, never more than one step behind
    values.forEach((q, f) => {
      expect(q).toBeLessThanOrEqual(f / 30 + 1e-12);
      expect(f / 30 - q).toBeLessThan(1 / 12);
    });
    // monotonic non-decreasing
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    // exactly 12 distinct held poses per second
    expect(new Set(values).size).toBe(12);
    // spot checks: floor(f * 12 / 30) / 12
    expect(quantizeTime(0, 30, 12)).toBe(0);
    expect(quantizeTime(2, 30, 12)).toBe(0);
    expect(quantizeTime(3, 30, 12)).toBe(1 / 12);
    expect(quantizeTime(5, 30, 12)).toBe(2 / 12);
    expect(quantizeTime(30, 30, 12)).toBe(1);
  });

  it('lands on exact step boundaries for decimal stepFps', () => {
    // 360 * 0.7 / 12 is exactly 21, but the float product is 251.99999999999997
    expect(quantizeTime(360, 12, 0.7)).toBe(21 / 0.7);
    expect(quantizeTime(180, 12, 1.4)).toBe(21 / 1.4);
    // sweep one-decimal stepFps against exact integer math (tenths)
    for (const fps of [12, 24, 25, 30, 60]) {
      for (let tenths = 1; tenths <= fps * 10; tenths++) {
        for (let f = 0; f < fps * 60; f++) {
          const step = Math.floor((f * tenths) / (fps * 10));
          const q = quantizeTime(f, fps, tenths / 10);
          if (q !== step / (tenths / 10)) expect({ fps, tenths, f, q }).toEqual({ fps, tenths, f, q: step / (tenths / 10) });
        }
      }
    }
  });
});
