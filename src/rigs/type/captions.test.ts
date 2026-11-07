import { describe, expect, it } from 'vitest';
import { safeArea } from '../../engine/safe-area';
import { PASS_THROUGH } from '../../engine/kit';
import { createRng } from '../../engine/rng';
import { createRecordingContext } from '../../engine/testing/recording-context';
import type { Ctx2D, SpokenWord } from '../../engine/types';
import { defaultParams } from '../../engine/registry';
import { layoutCaptions, type CaptionOptions } from './caption-layout';
import { captions } from './captions';

const WORDS: SpokenWord[] = [
  { id: 'w0', text: '¿Por', start: 0, end: 0.16 },
  { id: 'w1', text: 'qué', start: 0.16, end: 0.36 },
  { id: 'w2', text: 'un', start: 0.36, end: 0.56 },
  { id: 'w3', text: 'lago', start: 0.56, end: 0.88 },
  { id: 'w4', text: 'no', start: 0.88, end: 1.22 },
  { id: 'w5', text: 'se', start: 1.22, end: 1.4 },
  { id: 'w6', text: 'congela?', start: 1.4, end: 2 },
  { id: 'w7', text: 'El', start: 3, end: 3.2 },
  { id: 'w8', text: 'agua.', start: 3.2, end: 3.6 },
];
const STAGE = { width: 1080, height: 1920 };
const OPTIONS: CaptionOptions = { font: 'inter-bold', size: 0, lines: 2, width: 0, position: 'bottom', offsetX: 0, offsetY: 0, letterCase: 'none' };

const draw = (params: Record<string, string | number>, t: number, words = WORDS) => {
  const { ctx, log } = createRecordingContext();
  captions.draw(ctx as unknown as Ctx2D, { ...defaultParams(captions), ...params }, t, createRng(1, 'c'), STAGE, { ...PASS_THROUGH, speech: () => words });
  return log;
};

describe('caption pages', () => {
  const pages = (options = OPTIONS, words = WORDS) => layoutCaptions(words, options, STAGE).pages;

  it('ends a page at a sentence', () => {
    expect(pages().at(-2)?.words.at(-1)?.text).toBe('congela?');
    expect(pages().at(-1)?.words.map((w) => w.text)).toEqual(['El', 'agua.']);
  });

  it('ends a page at a pause', () => {
    const words = [{ ...WORDS[0], text: 'one' }, { ...WORDS[1], text: 'two', start: 1, end: 1.2 }];
    expect(pages(OPTIONS, words)).toHaveLength(2);
  });

  it('keeps each page to its lines', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, text: 'palabra', start: i / 4, end: (i + 1) / 4 }));
    for (const page of pages({ ...OPTIONS, lines: 1 }, long)) expect(new Set(page.words.map((w) => w.top)).size).toBe(1);
  });

  it('holds a page a little past its last word, and never over the next', () => {
    const [first, second] = pages({ ...OPTIONS, lines: 4 });
    expect(first.end).toBeCloseTo(2.35);
    expect(first.end).toBeLessThanOrEqual(second.start);
  });

  it('sits inside the vertical safe area by default', () => {
    const area = safeArea(STAGE.width, STAGE.height);
    for (const { box } of pages()) {
      expect(box.x).toBeGreaterThanOrEqual(area.x);
      expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width);
      expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height + 0.5);
    }
  });

  it('breaks lines the same in the pixel font, with whole pixels', () => {
    const { pages: p, pixel } = layoutCaptions(WORDS, { ...OPTIONS, font: 'pixel' }, { width: 180, height: 320 });
    expect(pixel).toBe(true);
    for (const word of p.flatMap((page) => page.words)) expect(Number.isInteger(word.x) && Number.isInteger(word.top)).toBe(true);
  });
});

describe('the rig', () => {
  const fills = (log: ReturnType<typeof draw>) => log.filter((e) => e.op === 'call' && e.name === 'fill').length;
  const colours = (log: ReturnType<typeof draw>) => log.flatMap((e) => (e.op === 'set' && e.name === 'fillStyle' ? [e.value] : []));

  it('draws nothing before the first word, between pages or without words', () => {
    expect(draw({}, 2.9)).toEqual([]);
    expect(draw({}, 0, [])).toEqual([]);
  });

  it('never calls fillText', () => {
    expect(draw({}, 0.2).some((e) => e.op === 'call' && /Text$/.test(e.name))).toBe(false);
  });

  it('word-highlight lights the word being said, and only it', () => {
    const lit = colours(draw({ highlight: '#ff0000', color: '#ffffff' }, 0.2));
    expect(lit.filter((c) => c === '#ff0000')).toHaveLength(1);
    expect(lit.filter((c) => c === '#ffffff').length).toBeGreaterThan(1);
  });

  it('pop-in shows only the words said so far', () => {
    expect(fills(draw({ style: 'pop-in' }, 0.2))).toBe(2);
    expect(fills(draw({ style: 'pop-in' }, 0.6))).toBe(4);
  });

  it('line lights nothing', () => {
    expect(colours(draw({ style: 'line', highlight: '#ff0000' }, 0.2))).not.toContain('#ff0000');
  });

  it('gives the same log for the same time, however it got there', () => {
    const a = draw({ style: 'pop-in' }, 0.62);
    draw({ style: 'pop-in' }, 3.1);
    expect(draw({ style: 'pop-in' }, 0.62)).toEqual(a);
  });
});
