import { describe, expect, it } from 'vitest';
import { contactSheetFrames, contactSheetLayout } from './contact-sheet';

describe('contactSheetFrames', () => {
  it('lists every Nth frame of [from, to)', () => {
    expect(contactSheetFrames(0, 96, 12)).toEqual([0, 12, 24, 36, 48, 60, 72, 84]);
    expect(contactSheetFrames(10, 20, 3)).toEqual([10, 13, 16, 19]);
    expect(contactSheetFrames(5, 6, 4)).toEqual([5]);
  });

  it('picks a step for about 24 frames when every is left out', () => {
    expect(contactSheetFrames(0, 96)).toEqual(contactSheetFrames(0, 96, 4));
    expect(contactSheetFrames(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rejects an empty range or a step below 1', () => {
    expect(() => contactSheetFrames(10, 10, 1)).toThrow(/range/);
    expect(() => contactSheetFrames(0, 10, 0)).toThrow(/every/);
    expect(() => contactSheetFrames(0, 10, 1.5)).toThrow(/every/);
  });
});

describe('contactSheetLayout', () => {
  it('lays thumbnails out in a near-square grid at the scene aspect, with a label strip under each', () => {
    const l = contactSheetLayout({ count: 16, frameWidth: 1920, frameHeight: 1080 });
    expect(l).toMatchObject({ columns: 4, rows: 4, thumbWidth: 480, thumbHeight: 270 });
    expect(l.cellHeight).toBe(270 + l.labelHeight);
    expect(l.width).toBe(l.gap + 4 * (480 + l.gap));
    expect(l.height).toBe(l.gap + 4 * (l.cellHeight + l.gap));
    expect(l.cell(0)).toEqual({ x: l.gap, y: l.gap });
    expect(l.cell(5)).toEqual({ x: l.gap + (480 + l.gap), y: l.gap + (l.cellHeight + l.gap) });
  });

  it('keeps the last row short instead of adding an empty one', () => {
    expect(contactSheetLayout({ count: 17, frameWidth: 1920, frameHeight: 1080 })).toMatchObject({ columns: 5, rows: 4 });
    expect(contactSheetLayout({ count: 1, frameWidth: 1080, frameHeight: 1920 })).toMatchObject({ columns: 1, rows: 1, thumbHeight: 853 });
  });

  it('takes columns and thumbnail width, and caps automatic columns at 8', () => {
    expect(contactSheetLayout({ count: 12, frameWidth: 100, frameHeight: 50, columns: 6, thumbWidth: 100 })).toMatchObject({
      columns: 6,
      rows: 2,
      thumbHeight: 50,
    });
    expect(contactSheetLayout({ count: 200, frameWidth: 1920, frameHeight: 1080 }).columns).toBe(8);
  });

  it('refuses a sheet larger than a canvas can hold, and says how to shrink it', () => {
    // 1800 frames in 8 columns is 225 rows, about 68,000 px tall.
    expect(() => contactSheetLayout({ count: 1800, frameWidth: 1920, frameHeight: 1080 })).toThrow(/1800 frames.*16384.*--every/s);
    expect(() => contactSheetLayout({ count: 40, frameWidth: 1920, frameHeight: 1080, columns: 40 })).toThrow(/wide/);
    expect(() => contactSheetLayout({ count: 200, frameWidth: 1920, frameHeight: 1080 })).not.toThrow();
  });
});
