import { describe, expect, it } from 'vitest';
import {
  checkReadingTime,
  checkTextContrast,
  checkTextFrame,
  checkTextSafe,
  contrastFrames,
  contrastRatio,
  isLarge,
  luminance,
  measureContrast,
  readingSeconds,
  restingFrames,
  type ContrastInput,
  type Rgba,
} from './text-check';
import type { Appearance, Box, TextMark } from './text-marks';

const FPS = 12;
const WIDE: [number, number] = [1920, 1080];
const TALL: [number, number] = [1080, 1920];

function mark(box: Box, over: Partial<TextMark> = {}, size: readonly [number, number] = WIDE): TextMark {
  return {
    path: 'title',
    owner: { scene: 's', layer: 'title' },
    top: true,
    rig: 'text',
    text: 'Hello there',
    complete: true,
    opacity: 1,
    fills: ['#000000'],
    stroke: null,
    strokeWidth: 0,
    size: 80,
    lines: [{ x: 0, y: 0, width: box.width, height: box.height }],
    transform: [1, 0, 0, 1, box.x, box.y],
    box,
    area: { x: 0, y: 0, width: size[0], height: size[1] },
    clips: [],
    ...over,
  };
}

/** An appearance from frame `start`, one box (and mark overrides) a frame. */
function appearance(start: number, frames: readonly (Box | [Box, Partial<TextMark>])[], over: Partial<Appearance> = {}, size: readonly [number, number] = WIDE): Appearance {
  return {
    path: 'title',
    text: 'Hello there',
    rig: 'text',
    top: true,
    frames: frames.map((f, i) => ({ frame: start + i, mark: Array.isArray(f) ? mark(f[0], f[1], size) : mark(f, {}, size) })),
    ...over,
  };
}

const at = (x: number, y: number, width = 400, height = 80): Box => ({ x, y, width, height });
const still = <T extends Box | [Box, Partial<TextMark>]>(count: number, frame: T): T[] => Array.from({ length: count }, () => frame);

describe('restingFrames', () => {
  it('calls a box still only when it holds for a quarter second either side', () => {
    const slide = [...Array.from({ length: 6 }, (_, i) => at(-400 + i * 80, 100)), ...still(12, at(80, 100))];
    const resting = restingFrames(appearance(0, slide), FPS);
    expect(resting.slice(0, 9).some(Boolean)).toBe(false);
    expect(resting.slice(9).every(Boolean)).toBe(true);
  });
});

describe('text-frame', () => {
  it('passes text sliding in from off frame and coming to rest inside it', () => {
    const slide = [...Array.from({ length: 6 }, (_, i) => at(-400 + i * 80, 100)), ...still(12, at(80, 100))];
    expect(checkTextFrame([appearance(0, slide)], FPS, 0, 24)).toMatchObject({ status: 'pass' });
  });

  it('warns on text resting across an edge, with the frames and the edge', () => {
    const result = checkTextFrame([appearance(4, still(12, at(1700, 100)))], FPS, 0, 24);
    expect(result).toMatchObject({ status: 'warn', frames: [[4, 16]], value: 1 });
    expect(result.message).toBe('"Hello there" (title) runs past the right edge.');
  });

  it('allows a couple of pixels of slack, and ignores text wholly off frame', () => {
    expect(checkTextFrame([appearance(0, still(12, at(-1.5, 100)))], FPS, 0, 24).status).toBe('pass');
    expect(checkTextFrame([appearance(0, still(12, at(-900, 100)))], FPS, 0, 24).status).toBe('pass');
  });

  it('only judges frames in range', () => {
    expect(checkTextFrame([appearance(30, still(12, at(1700, 100)))], FPS, 0, 24).status).toBe('pass');
  });

  it("counts a moved clip's edge as an edge too", () => {
    const inClip = still(12, [at(100, 100), { area: { x: 0, y: 0, width: 300, height: 1080 } }] as [Box, Partial<TextMark>]);
    expect(checkTextFrame([appearance(0, inClip)], FPS, 0, 24).message).toContain('runs past the right edge');
  });

  it('passes with no text', () => {
    expect(checkTextFrame([], FPS, 0, 24)).toMatchObject({ status: 'pass', message: 'There is no text.' });
  });
});

describe('text-safe', () => {
  it('names the platform zone on a vertical stage, at P1', () => {
    // The safe area of 1080x1920 runs from y 260 to 1440 and x 60 to 940.
    const result = checkTextSafe([appearance(0, still(12, at(100, 1500, 400, 100)), {}, TALL)], TALL, FPS, 0, 24);
    expect(result).toMatchObject({ status: 'warn', rank: 'P1', frames: [[0, 12]] });
    expect(result.message).toContain('the caption and name at the bottom');
    const side = checkTextSafe([appearance(0, still(12, at(600, 800, 400, 100)), {}, TALL)], TALL, FPS, 0, 24);
    expect(side.message).toContain('the buttons on the right');
  });

  it('holds other shapes to a title-safe margin, at P3', () => {
    const result = checkTextSafe([appearance(0, still(12, at(20, 500)))], WIDE, FPS, 0, 24);
    expect(result).toMatchObject({ status: 'warn', rank: 'P3' });
    expect(result.message).toContain('title-safe margin at the left');
    expect(checkTextSafe([appearance(0, still(12, at(200, 500)))], WIDE, FPS, 0, 24)).toMatchObject({ status: 'pass', rank: 'P3' });
  });

  it("leaves cut text to text-frame, and the scene's own captions to caption-safe", () => {
    expect(checkTextSafe([appearance(0, still(12, at(1700, 100)))], WIDE, FPS, 0, 24).status).toBe('pass');
    const low = still(12, at(100, 1500, 400, 100));
    expect(checkTextSafe([appearance(0, low, { rig: 'captions' }, TALL)], TALL, FPS, 0, 24).status).toBe('pass');
    expect(checkTextSafe([appearance(0, low, { rig: 'captions', top: false, path: 'clip/subs' }, TALL)], TALL, FPS, 0, 24).status).toBe('warn');
  });
});

describe('reading-time', () => {
  it('asks 0.3 s a word, and at least a second', () => {
    expect(readingSeconds('Hi')).toBe(1);
    expect(readingSeconds('one two three four five six seven eight nine ten')).toBeCloseTo(3);
  });

  it('passes text up long enough, and warns on text gone too soon', () => {
    expect(checkReadingTime([appearance(0, still(12, at(100, 100)))], FPS, 0, 48).status).toBe('pass');
    const result = checkReadingTime([appearance(5, still(6, at(100, 100)))], FPS, 0, 48);
    expect(result).toMatchObject({ status: 'warn', frames: [[5, 11]], value: 1 });
    expect(result.message).toBe('"Hello there" (title) reads for 0.5 s and needs 1 s.');
  });

  it('counts a reveal only once it finishes, and a fade from half opacity', () => {
    const typing = [...Array.from({ length: 12 }, () => [at(100, 100), { complete: false }] as [Box, Partial<TextMark>]), ...still(6, at(100, 100))];
    expect(checkReadingTime([appearance(0, typing)], FPS, 0, 48).message).toContain('reads for 0.5 s');
    const fading = Array.from({ length: 12 }, (_, i) => [at(100, 100), { opacity: i / 11 }] as [Box, Partial<TextMark>]);
    expect(checkReadingTime([appearance(0, fading)], FPS, 0, 48).message).toContain('reads for 0.5 s');
  });

  it('judges each text of a layer on its own, and only those touching the range', () => {
    const first = appearance(0, still(18, at(100, 100)), { text: 'First line' });
    const second = appearance(18, still(4, at(100, 100)), { text: 'Second line' });
    const result = checkReadingTime([first, second], FPS, 0, 48);
    expect(result.frames).toEqual([[18, 22]]);
    expect(checkReadingTime([first, second], FPS, 0, 18).status).toBe('pass');
  });

  it('leaves captions to caption-speed', () => {
    expect(checkReadingTime([appearance(0, still(3, at(100, 100)), { rig: 'captions' })], FPS, 0, 48)).toMatchObject({ status: 'pass', message: 'There is no text to read.' });
  });
});

describe('contrast arithmetic', () => {
  it('matches WCAG for black, white and mid grey', () => {
    expect(contrastRatio(luminance(0, 0, 0), luminance(255, 255, 255))).toBeCloseTo(21);
    expect(contrastRatio(luminance(255, 255, 255), luminance(255, 255, 255))).toBe(1);
    // #767676 on white is the classic 4.5:1 grey.
    expect(contrastRatio(luminance(0x76, 0x76, 0x76), luminance(255, 255, 255))).toBeCloseTo(4.54, 1);
  });

  it('calls an em of a thirtieth of the short side large', () => {
    expect(isLarge(36, WIDE)).toBe(true);
    expect(isLarge(35, WIDE)).toBe(false);
  });
});

describe('measureContrast', () => {
  const W = 20;
  const H = 10;
  /** A ground of one colour, with the left `split` columns another. */
  function ground(colour: readonly number[], split = 0, left: readonly number[] = colour): Uint8ClampedArray {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) out.set([...(i % W < split ? left : colour), 255], i * 4);
    return out;
  }
  const input = (over: Partial<ContrastInput>): ContrastInput => ({
    pixels: ground([255, 255, 255]),
    width: W,
    height: H,
    scale: [1, 1],
    inside: () => true,
    fills: [[0, 0, 0, 1]],
    stroke: null,
    strokeWidth: 0,
    size: 40,
    opacity: 1,
    ...over,
  });
  const grey: Rgba = [0x76, 0x76, 0x76, 1];

  it('measures a fill against a plain ground', () => {
    expect(measureContrast(input({}))).toBeCloseTo(21);
    expect(measureContrast(input({ fills: [grey] }))).toBeCloseTo(4.54, 1);
  });

  it('mixes a translucent fill over the ground', () => {
    expect(measureContrast(input({ opacity: 0.3 }))).toBeCloseTo(2.1, 1);
    expect(measureContrast(input({ fills: [[0, 0, 0, 0.3]] }))).toBeCloseTo(2.1, 1);
  });

  it('reads a fill against a wide enough outline', () => {
    const pale: Rgba = [250, 250, 250, 1];
    expect(measureContrast(input({ fills: [pale] }))!).toBeLessThan(1.1);
    expect(measureContrast(input({ fills: [pale], stroke: [0, 0, 0, 1], strokeWidth: 4 }))!).toBeGreaterThan(19);
    // Thinner than 2 px, or a twentieth of the em, it doesn't count.
    expect(measureContrast(input({ fills: [pale], stroke: [0, 0, 0, 1], strokeWidth: 1 }))!).toBeLessThan(1.1);
  });

  it('takes the worst fill, as for a caption highlight', () => {
    expect(measureContrast(input({ fills: [[0, 0, 0, 1], [255, 230, 0, 1]] }))!).toBeLessThan(1.5);
  });

  it('is decided by a patch behind a tenth of the text, not by a stray pixel or grain', () => {
    // Black text over white, with one black pixel, or the left four columns black.
    const speck = ground([255, 255, 255]);
    speck.set([0, 0, 0], (5 * W + 5) * 4);
    expect(measureContrast(input({ pixels: speck }))).toBeCloseTo(21);
    expect(measureContrast(input({ pixels: ground([255, 255, 255], 4, [0, 0, 0]) }))).toBeCloseTo(1);
    // Grain a pixel wide, alternating light and dark, reads as its mean.
    const grain = ground([255, 255, 255]);
    for (let i = 0; i < W * H; i += 2) grain.set([200, 200, 200], i * 4);
    expect(measureContrast(input({ pixels: grain }))).toBeGreaterThan(15);
  });

  it('reads only the pixels behind the text, at the measured scale', () => {
    // Behind the text is the left eight columns, in output pixels twice the measured ones; black starts at column 10.
    const result = measureContrast(input({ pixels: ground([0, 0, 0], 10, [255, 255, 255]), scale: [2, 2], inside: (x) => x < 16 }));
    expect(result).toBeCloseTo(21);
    expect(measureContrast(input({ inside: () => false }))).toBeNull();
  });
});

describe('text-contrast', () => {
  it('passes clear text and reports the lowest ratio', () => {
    expect(checkTextContrast([{ path: 'title', text: 'Hi', frame: 0, ratio: 12, large: false }])).toMatchObject({ status: 'pass', value: 12 });
    expect(checkTextContrast([])).toMatchObject({ status: 'pass' });
  });

  it('reports each text at its worst moment: P1 under 3:1, P2 for small text under 4.5:1', () => {
    const samples = [
      { path: 'title', text: 'Big', frame: 0, ratio: 5, large: true },
      { path: 'title', text: 'Big', frame: 6, ratio: 2.5, large: true },
      { path: 'note', text: 'Small print', frame: 3, ratio: 4, large: false },
    ];
    const result = checkTextContrast(samples);
    expect(result).toMatchObject({ status: 'warn', rank: 'P1', frames: [[6, 7], [3, 4]], value: 2.5 });
    expect(result.message).toBe('"Big" (title) is 2.5:1 against what\'s behind it at frame 6, under 3:1. "Small print" (note) is 4:1 against what\'s behind it at frame 3, under 4.5:1.');
    expect(checkTextContrast([samples[2]])).toMatchObject({ status: 'warn', rank: 'P2' });
    expect(checkTextContrast([{ ...samples[2], large: true }]).status).toBe('pass');
  });
});

describe('contrastFrames', () => {
  it('samples readable frames in range: the first, then every half second', () => {
    const typing = Array.from({ length: 30 }, (_, i) => [at(100, 100), { complete: i >= 4 }] as [Box, Partial<TextMark>]);
    expect(contrastFrames(appearance(0, typing), FPS, 0, 48)).toEqual([4, 10, 16, 22, 28]);
    expect(contrastFrames(appearance(0, typing), FPS, 12, 20)).toEqual([12, 18]);
  });

  it('caps the samples on a long appearance', () => {
    expect(contrastFrames(appearance(0, still(1200, at(100, 100))), FPS, 0, 1200).length).toBeLessThanOrEqual(24);
  });
});
