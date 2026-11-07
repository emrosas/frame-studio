// How captions read (ADR 0016): which words share a screen, and where each word
// sits. Pure, and from the typeface alone like all our type, so the check tool
// measures the same boxes the rig draws. Words stay as the cue spells them;
// only what fits and how long a page holds is decided here.

import { safeArea } from '../../engine/safe-area';
import type { SpokenWord, Stage } from '../../engine/types';
import { ACCENT_HEIGHT, GLYPH_HEIGHT, lineWidth } from '../pixel/font';
import { typefaces } from './faces/index';
import { CAPTION_FACE } from './caption-face';
import { layoutText, type PlacedGlyph } from './layout';
import { glyphOf } from './typeface';

export { CAPTION_FACE };

/** Captions in the pixel font rather than a typeface. */
export const PIXEL_FONT = 'pixel';

const LINE_HEIGHT = 1.15;
/** Blocky rows between pixel lines, leaving an accent room. */
const PIXEL_GAP = ACCENT_HEIGHT + 1;
/** A silence this long ends a page. */
const PAUSE = 0.45;
/** A page stays up this long after its last word, unless the next one needs the room. */
const HOLD = 0.35;
const ENDS_SENTENCE = /[.!?…]["')»]*$/;
const ENDS_CLAUSE = /[,;:]["')»]*$/;

export type CaptionPosition = 'top' | 'middle' | 'bottom';
export type CaptionCase = 'none' | 'upper' | 'lower';

export interface CaptionOptions {
  font: string;
  /** Font size, or for the pixel font stage pixels per font pixel. 0 picks one for the stage. */
  size: number;
  /** Most lines on a page. */
  lines: number;
  /** Line width. 0 is the safe area's. */
  width: number;
  position: CaptionPosition;
  offsetX: number;
  offsetY: number;
  letterCase: CaptionCase;
}

/** A word on a page, with its box on the stage. */
export interface PlacedWord {
  word: SpokenWord;
  text: string;
  x: number;
  width: number;
  /** The top of its line, and the baseline for a typeface. */
  top: number;
  baseline: number;
  height: number;
  /** A typeface's glyphs, from x. Empty for the pixel font. */
  glyphs: PlacedGlyph[];
}

export interface CaptionPage {
  start: number;
  end: number;
  words: PlacedWord[];
  box: { x: number; y: number; width: number; height: number };
}

export interface CaptionLayout {
  pages: CaptionPage[];
  size: number;
  /** Scene pixels per font unit, for a typeface. */
  scale: number;
  pixel: boolean;
}

const cased = (text: string, letterCase: CaptionCase) => (letterCase === 'upper' ? text.toUpperCase() : letterCase === 'lower' ? text.toLowerCase() : text);

/** Font size for the stage, when a scene leaves it to us: the short side over 15, or a whole font pixel per 180 stage pixels. */
function autoSize(pixel: boolean, stage: Stage): number {
  const short = Math.min(stage.width, stage.height);
  return pixel ? Math.max(1, Math.round(short / 180)) : Math.round(short / 15);
}

interface Setter {
  /** The lines a run of text breaks into, each with the indices of the words on it. */
  lines(words: readonly string[]): number[][];
  wordWidth(text: string): number;
  spaceWidth: number;
  lineHeight: number;
}

function pixelSetter(size: number, width: number): Setter {
  const spaceWidth = (lineWidth(' ') + 1) * size;
  const wordWidth = (text: string) => lineWidth(text) * size;
  return {
    wordWidth,
    spaceWidth,
    lineHeight: (GLYPH_HEIGHT + PIXEL_GAP) * size,
    lines: (words) => wrapWords(words, wordWidth, spaceWidth, width),
  };
}

/** Greedy line breaks over whole words. A word wider than the line takes one alone and may overhang; the check says so. */
function wrapWords(words: readonly string[], wordWidth: (text: string) => number, spaceWidth: number, width: number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let used = 0;
  words.forEach((text, i) => {
    const w = wordWidth(text);
    if (line.length > 0 && used + spaceWidth + w > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length > 0 ? spaceWidth : 0) + w;
    line.push(i);
  });
  if (line.length > 0) lines.push(line);
  return lines;
}

function faceSetter(font: string, size: number, width: number): Setter & { face: (typeof typefaces)[number]; scale: number } {
  const face = typefaces.find((f) => f.id === font) ?? typefaces.find((f) => f.id === CAPTION_FACE) ?? typefaces[0];
  const measure = (text: string) => layoutText(face, text, { size }).width;
  const spaceWidth = glyphOf(face, ' ')[0] * (size / face.unitsPerEm);
  return {
    face,
    scale: size / face.unitsPerEm,
    wordWidth: measure,
    spaceWidth,
    lineHeight: size * LINE_HEIGHT,
    lines: (words) => wrapWords(words, measure, spaceWidth, width),
  };
}

/** Splits words into pages: a page ends at a sentence, at a pause, past a clause once it's mostly full, or when the next word wouldn't fit. */
function splitPages(words: readonly SpokenWord[], texts: readonly string[], setter: Setter, maxLines: number): number[][] {
  const pages: number[][] = [];
  let page: number[] = [];
  const fits = (candidate: number[]) => setter.lines(candidate.map((i) => texts[i])).length <= maxLines;
  words.forEach((word, i) => {
    if (page.length > 0 && !fits([...page, i])) {
      pages.push(page);
      page = [];
    }
    page.push(i);
    const next = words[i + 1];
    const full = setter.lines(page.map((p) => texts[p])).length >= maxLines;
    if (!next || ENDS_SENTENCE.test(word.text) || next.start - word.end >= PAUSE || (full && ENDS_CLAUSE.test(word.text))) {
      pages.push(page);
      page = [];
    }
  });
  if (page.length > 0) pages.push(page);
  return pages;
}

/** Every page of captions for these words, placed on the stage. */
export function layoutCaptions(words: readonly SpokenWord[], options: CaptionOptions, stage: Stage): CaptionLayout {
  const pixel = options.font === PIXEL_FONT;
  const size = options.size > 0 ? (pixel ? Math.max(1, Math.round(options.size)) : options.size) : autoSize(pixel, stage);
  const area = safeArea(stage.width, stage.height);
  // Centred on the stage, not the safe area: a vertical safe area leans left of the buttons, and the words shouldn't.
  const middle = stage.width / 2;
  const width = options.width > 0 ? options.width : 2 * Math.min(middle - area.x, area.x + area.width - middle);
  const setter = pixel ? pixelSetter(size, width) : faceSetter(options.font, size, width);
  const scale = 'scale' in setter ? (setter.scale as number) : 1;
  const texts = words.map((w) => cased(w.text, options.letterCase));
  const cx = middle + options.offsetX;

  const pages = splitPages(words, texts, setter, Math.max(1, options.lines)).map((indices, p, all) => {
    const lines = setter.lines(indices.map((i) => texts[i])).map((line) => line.map((n) => indices[n]));
    const height = lines.length * setter.lineHeight - (pixel ? PIXEL_GAP * size : 0);
    const anchor = options.position === 'top' ? area.y : options.position === 'middle' ? area.y + (area.height - height) / 2 : area.y + area.height - height;
    const top = Math.round(anchor + options.offsetY);
    const placed: PlacedWord[] = [];
    let left = Infinity;
    let right = -Infinity;
    lines.forEach((line, l) => {
      const widths = line.map((i) => setter.wordWidth(texts[i]));
      const total = widths.reduce((sum, w) => sum + w, 0) + setter.spaceWidth * (line.length - 1);
      let x = pixel ? Math.round(cx - total / 2) : cx - total / 2;
      left = Math.min(left, x);
      right = Math.max(right, x + total);
      line.forEach((i, n) => {
        const lineTop = top + l * setter.lineHeight;
        const faced = 'face' in setter ? layoutText(setter.face as never, texts[i], { size, lineHeight: LINE_HEIGHT }) : null;
        placed.push({
          word: words[i],
          text: texts[i],
          x,
          width: widths[n],
          top: lineTop,
          baseline: lineTop + (faced?.lines[0]?.baseline ?? 0),
          height: pixel ? GLYPH_HEIGHT * size : setter.lineHeight,
          glyphs: faced?.lines[0]?.glyphs ?? [],
        });
        x += widths[n] + setter.spaceWidth;
      });
    });
    const first = words[indices[0]];
    const last = words[indices[indices.length - 1]];
    const next = all[p + 1] ? words[all[p + 1][0]].start : Infinity;
    return { start: first.start, end: Math.min(next, last.end + HOLD), words: placed, box: { x: left, y: top, width: right - left, height } };
  });
  return { pages, size, scale, pixel };
}
