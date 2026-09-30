// Text layout from a typeface module alone (ADR 0010): advances, kerning,
// tracking, line breaks, alignment and line height. It never measures with
// the canvas, so a line breaks in the same place on every machine. Rigs draw
// the result with traceText, or all in one go with drawText.

import type { Ctx2D } from '../../engine/types';
import { glyphOf, kerningOf, traceGlyph, type Glyph, type Typeface } from './typeface';

export type TextAlign = 'left' | 'center' | 'right';
export type TextVAlign = 'top' | 'middle' | 'baseline' | 'bottom';

export interface TextOptions {
  /** Font size: scene pixels per em. */
  size: number;
  /** Line height as a multiple of the size. Default 1.2. */
  lineHeight?: number;
  /** Letter spacing in thousandths of an em, added between characters. Default 0. */
  tracking?: number;
  /** Wrap lines at this width in scene pixels. 0 or leaving it out: only at newlines. */
  width?: number;
  /** Where each line sits against the anchor: starting at it, centred on it, or ending at it. Default left. */
  align?: TextAlign;
}

export interface PlacedGlyph {
  char: string;
  glyph: Glyph;
  /** From the line's start, in scene pixels. */
  x: number;
}

export interface TextLine {
  glyphs: PlacedGlyph[];
  /** Ink advance of the line without trailing spaces, in scene pixels. */
  width: number;
  /** The line's start relative to the anchor, from the alignment. */
  x: number;
  /** The baseline below the top of the block. */
  baseline: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** The widest line. */
  width: number;
  /** Lines times line height. */
  height: number;
  /** Scene pixels per font unit. */
  scale: number;
}

const isSpace = (c: string) => c === ' ' || c === ' ' || c === '\t';

/** The advance of `chars` set in a row: advances, kerning between neighbours, and tracking between them. */
function measure(face: Typeface, chars: readonly string[], scale: number, track: number): number {
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    width += glyphOf(face, chars[i])[0] * scale;
    if (i + 1 < chars.length) width += kerningOf(face, chars[i], chars[i + 1]) * scale + track;
  }
  return width;
}

/** Splits a paragraph into runs that may end a line: a word with the spaces after it, or a word up to a hyphen. */
function segments(chars: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    current.push(c);
    const next = chars[i + 1];
    const endsSpaces = isSpace(c) && (next === undefined || !isSpace(next));
    const endsHyphen = (c === '-' || c === '–' || c === '—') && next !== undefined && !isSpace(next);
    if (endsSpaces || endsHyphen) {
      out.push(current);
      current = [];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function trimEnd(chars: readonly string[]): string[] {
  let end = chars.length;
  while (end > 0 && isSpace(chars[end - 1])) end--;
  return chars.slice(0, end);
}

/** Breaks one paragraph into lines no wider than `width` where it can; a word wider than the line breaks between letters. */
function wrap(face: Typeface, chars: string[], width: number, scale: number, track: number): string[][] {
  if (!(width > 0)) return [chars];
  const lines: string[][] = [];
  let line: string[] = [];
  const fits = (candidate: string[]) => measure(face, trimEnd(candidate), scale, track) <= width + 1e-6;
  for (const segment of segments(chars)) {
    if (line.length > 0 && fits([...line, ...segment])) {
      line.push(...segment);
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = [];
    if (fits(segment)) {
      line = [...segment];
      continue;
    }
    // Wider than a line on its own: break it between letters.
    for (const c of segment) {
      if (line.length > 0 && !isSpace(c) && !fits([...line, c])) {
        lines.push(line);
        line = [];
      }
      line.push(c);
    }
  }
  lines.push(line);
  return lines;
}

/** Lays `text` out in `face`. Newlines always break; a width also wraps at spaces and hyphens. */
export function layoutText(face: Typeface, text: string, options: TextOptions): TextLayout {
  const size = Math.max(0, options.size);
  const scale = size / face.unitsPerEm;
  const track = ((options.tracking ?? 0) / 1000) * size;
  const lineHeight = (options.lineHeight ?? 1.2) * size;
  const align = options.align ?? 'left';
  // CSS-style half-leading: the ascender and descender centred in each line box.
  const content = (face.ascender - face.descender) * scale;
  const firstBaseline = (lineHeight - content) / 2 + face.ascender * scale;

  const lines: TextLine[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    for (const raw of wrap(face, [...paragraph], options.width ?? 0, scale, track)) {
      const glyphs: PlacedGlyph[] = [];
      let x = 0;
      raw.forEach((char, i) => {
        const glyph = glyphOf(face, char);
        glyphs.push({ char, glyph, x });
        x += glyph[0] * scale;
        if (i + 1 < raw.length) x += kerningOf(face, char, raw[i + 1]) * scale + track;
      });
      const width = measure(face, trimEnd(raw), scale, track);
      lines.push({ glyphs, width, x: align === 'center' ? -width / 2 : align === 'right' ? -width : 0, baseline: firstBaseline + lines.length * lineHeight });
    }
  }
  return { lines, width: Math.max(0, ...lines.map((l) => l.width)), height: lines.length * lineHeight, scale };
}

/** The offset from the anchor's y to the top of the block, for a vertical alignment. */
export function blockTop(layout: TextLayout, valign: TextVAlign): number {
  switch (valign) {
    case 'top':
      return 0;
    case 'middle':
      return -layout.height / 2;
    case 'bottom':
      return -layout.height;
    default:
      return -(layout.lines[0]?.baseline ?? 0);
  }
}

/**
 * Adds the outlines of a layout to the current path, anchored at (x, y) with
 * the block's top at y + top. `count` draws only the first so many characters,
 * newlines not counted, which types text on without moving it.
 */
export function traceText(ctx: Ctx2D, layout: TextLayout, x: number, y: number, top: number, count = Infinity): void {
  let drawn = 0;
  for (const line of layout.lines) {
    for (const g of line.glyphs) {
      if (drawn++ >= count) return;
      if (isSpace(g.char)) continue;
      traceGlyph(ctx, g.glyph, x + line.x + g.x, y + top + line.baseline, layout.scale);
    }
  }
}

/** Lays out and fills `text` in the current fill style. For rigs that draw a label or a title of their own. */
export function drawText(
  ctx: Ctx2D,
  face: Typeface,
  text: string,
  x: number,
  y: number,
  options: TextOptions & { valign?: TextVAlign },
): TextLayout {
  const layout = layoutText(face, text, options);
  ctx.beginPath();
  traceText(ctx, layout, x, y, blockTop(layout, options.valign ?? 'baseline'));
  ctx.fill();
  return layout;
}

/** How many characters `text` has for traceText's count: every character but newlines. */
export function characterCount(text: string): number {
  return [...text.replace(/\r\n?|\n/g, '')].length;
}
