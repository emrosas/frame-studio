import { describe, expect, it } from 'vitest';
import { avcCodecString, frameDurationUs, frameTimestampUs, gifDelaysCs, isKeyFrame } from './timing';

describe('frameTimestampUs and frameDurationUs', () => {
  it('rounds frame * 1e6 / fps to whole microseconds', () => {
    expect(frameTimestampUs(0, 12)).toBe(0);
    expect(frameTimestampUs(1, 12)).toBe(83333);
    expect(frameTimestampUs(2, 12)).toBe(166667);
    expect(frameTimestampUs(12, 12)).toBe(1_000_000);
    expect(frameTimestampUs(1, 30)).toBe(33333);
  });

  it('gives durations that tile the timeline with no gap or overlap', () => {
    for (const fps of [12, 24, 25, 30, 60]) {
      let end = 0;
      for (let f = 0; f < fps * 10; f++) {
        expect(frameTimestampUs(f, fps), `fps ${fps} frame ${f}`).toBe(end);
        end += frameDurationUs(f, fps);
      }
      expect(end, `fps ${fps}`).toBe(10_000_000);
    }
  });
});

describe('gifDelaysCs', () => {
  it('spreads centiseconds so the total is exactly the duration', () => {
    const delays = gifDelaysCs(96, 12); // 8 s
    expect(delays).toHaveLength(96);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(800);
    expect(new Set(delays)).toEqual(new Set([8, 9]));
    expect(delays.slice(0, 3)).toEqual([8, 9, 8]);
  });

  it('is exact at 24, 25 and 30 fps too', () => {
    for (const fps of [24, 25, 30]) {
      const delays = gifDelaysCs(fps * 7, fps);
      expect(delays.reduce((a, b) => a + b, 0), `fps ${fps}`).toBe(700);
      expect(Math.min(...delays), `fps ${fps}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('refuses frame rates above 50, where a delay would drop below 2 cs and browsers slow it to 10 cs', () => {
    expect(() => gifDelaysCs(10, 60)).toThrow(/50 fps/);
    expect(() => gifDelaysCs(10, 50)).not.toThrow();
  });
});

describe('avcCodecString', () => {
  it('uses High profile at level 4.0 for 1080p up to 30 fps', () => {
    expect(avcCodecString(1920, 1080, 12)).toBe('avc1.640028');
    expect(avcCodecString(1920, 1080, 30)).toBe('avc1.640028');
    expect(avcCodecString(1280, 720, 24)).toBe('avc1.640028');
  });

  it('steps up the level for higher rates and sizes', () => {
    expect(avcCodecString(1920, 1080, 60)).toBe('avc1.64002a');
    expect(avcCodecString(3840, 2160, 30)).toBe('avc1.640033');
    expect(avcCodecString(3840, 2160, 60)).toBe('avc1.640034');
  });

  it('rejects odd sizes, which 4:2:0 H.264 cannot hold, and sizes beyond level 5.2', () => {
    expect(() => avcCodecString(1921, 1080, 12)).toThrow(/even/);
    expect(() => avcCodecString(1920, 1081, 12)).toThrow(/even/);
    expect(() => avcCodecString(7680, 4320, 30)).toThrow(/too large/);
  });
});

describe('isKeyFrame', () => {
  it('puts a key frame on frame 0 and every 2 seconds after', () => {
    const keys = Array.from({ length: 60 }, (_, f) => f).filter((f) => isKeyFrame(f, 12));
    expect(keys).toEqual([0, 24, 48]);
    expect([0, 1, 59, 60].map((f) => isKeyFrame(f, 30))).toEqual([true, false, false, true]);
  });
});
