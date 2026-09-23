import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimecode } from './timecode';

const FPS_LIST = [1, 12, 24, 25, 30, 60];

describe('formatTimecode', () => {
  it('formats MM:SS:FF with zero padding', () => {
    expect(formatTimecode(0, 12)).toBe('00:00:00');
    expect(formatTimecode(1, 12)).toBe('00:00:01');
    expect(formatTimecode(11, 12)).toBe('00:00:11');
    expect(formatTimecode(12, 12)).toBe('00:01:00');
    expect(formatTimecode(47, 12)).toBe('00:03:11');
    expect(formatTimecode(12 * 60, 12)).toBe('01:00:00');
    expect(formatTimecode(12 * 61 + 5, 12)).toBe('01:01:05');
    expect(formatTimecode(29, 30)).toBe('00:00:29');
    expect(formatTimecode(59, 1)).toBe('00:59:00');
  });

  it('lets minutes grow past two digits', () => {
    expect(formatTimecode(24 * 60 * 100, 24)).toBe('100:00:00');
    expect(formatTimecode(24 * 3600, 24)).toBe('60:00:00');
  });

  it('widens FF when fps - 1 has more than two digits', () => {
    expect(formatTimecode(0, 120)).toBe('00:00:000');
    expect(formatTimecode(119, 120)).toBe('00:00:119');
    expect(formatTimecode(125, 120)).toBe('00:01:005');
    expect(formatTimecode(100, 101)).toBe('00:00:100');
    expect(formatTimecode(99, 100)).toBe('00:00:99');
  });

  it('rejects frames that are negative or not integers', () => {
    expect(() => formatTimecode(-1, 12)).toThrow(RangeError);
    expect(() => formatTimecode(1.5, 12)).toThrow(RangeError);
    expect(() => formatTimecode(Number.NaN, 12)).toThrow(RangeError);
  });

  it('rejects an fps that is not a positive integer', () => {
    expect(() => formatTimecode(0, 0)).toThrow(RangeError);
    expect(() => formatTimecode(0, 12.5)).toThrow(RangeError);
  });
});

describe('parseTimecode', () => {
  it('parses examples', () => {
    expect(parseTimecode('00:00:00', 12)).toBe(0);
    expect(parseTimecode('00:03:11', 12)).toBe(47);
    expect(parseTimecode('01:01:05', 12)).toBe(12 * 61 + 5);
    expect(parseTimecode('100:00:00', 24)).toBe(24 * 60 * 100);
    expect(parseTimecode('00:01:005', 120)).toBe(125);
  });

  it('accepts unpadded fields and surrounding whitespace', () => {
    expect(parseTimecode('0:3:11', 12)).toBe(47);
    expect(parseTimecode('  00:03:11\n', 12)).toBe(47);
  });

  it.each([
    ['', 'empty'],
    ['00:00', 'two fields'],
    ['00:00:00:00', 'four fields'],
    ['aa:bb:cc', 'letters'],
    ['00:00:0x', 'trailing junk'],
    ['00::00', 'empty field'],
    ['00:00:1.5', 'decimal'],
    ['00;00;00', 'wrong separator'],
  ])('throws on malformed input %j (%s)', (tc) => {
    expect(() => parseTimecode(tc, 12)).toThrow(/timecode/i);
  });

  it('throws on seconds >= 60', () => {
    expect(() => parseTimecode('00:60:00', 12)).toThrow(/seconds/i);
    expect(() => parseTimecode('00:99:00', 12)).toThrow(/seconds/i);
  });

  it('throws on frames >= fps', () => {
    expect(() => parseTimecode('00:00:12', 12)).toThrow(/frame/i);
    expect(() => parseTimecode('00:00:30', 30)).toThrow(/frame/i);
    expect(() => parseTimecode('00:00:01', 1)).toThrow(/frame/i);
  });

  it('throws on negatives', () => {
    expect(() => parseTimecode('-01:00:00', 12)).toThrow(/negative/i);
    expect(() => parseTimecode('00:-01:00', 12)).toThrow(/negative/i);
    expect(() => parseTimecode('00:00:-1', 12)).toThrow(/negative/i);
  });

  it('throws on non-string input', () => {
    expect(() => parseTimecode(47 as unknown as string, 12)).toThrow(/timecode/i);
  });

  it('includes the offending input in the message', () => {
    expect(() => parseTimecode('00:00:12', 12)).toThrow(/00:00:12/);
  });
});

describe('round trip parse(format(f)) === f', () => {
  for (const fps of FPS_LIST) {
    it(`holds for every frame 0..${fps * 3600} at ${fps} fps`, () => {
      const last = fps * 3600;
      for (let f = 0; f <= last; f++) {
        const tc = formatTimecode(f, fps);
        const back = parseTimecode(tc, fps);
        if (back !== f) {
          expect(back, `${tc} at ${fps} fps`).toBe(f);
        }
      }
    });
  }

  it('holds for wide-FF fps values too', () => {
    for (const fps of [100, 101, 120]) {
      for (let f = 0; f <= fps * 130; f++) {
        expect(parseTimecode(formatTimecode(f, fps), fps)).toBe(f);
      }
    }
  });
});
