import { describe, expect, it } from 'vitest';
import { blockTop, characterCount, layoutText, traceText } from './layout';
import { glyphOf, kerningOf, traceGlyph, type Typeface } from './typeface';

// A made-up typeface in 1000 units per em: every letter a 500-wide square, a space 250, and A before V kerned by -100.
const square = 'M0 0L400 0L400 700L0 700Z';
const face: Typeface = {
  id: 'test',
  name: 'Test',
  license: 'Test only.',
  unitsPerEm: 1000,
  ascender: 800,
  descender: -200,
  capHeight: 700,
  xHeight: 500,
  missing: [600, 'M0 0L500 0L500 700L0 700Z'],
  glyphs: Object.fromEntries([...'AVBCDEFGHIJ-'].map((c) => [c, [500, square]]).concat([[' ', [250, '']]])),
  kerning: { left: ['A'], right: ['V'], pairs: [0, 0, -100] },
};

const chars = (line: { glyphs: { char: string }[] }) => line.glyphs.map((g) => g.char).join('');

describe('text layout', () => {
  it('adds advances and kerning, at size / unitsPerEm pixels per unit', () => {
    const layout = layoutText(face, 'AV', { size: 100 });
    expect(layout.scale).toBe(0.1);
    expect(layout.lines[0].glyphs.map((g) => g.x)).toEqual([0, 40]);
    expect(layout.lines[0].width).toBe(90);
    expect(kerningOf(face, 'V', 'A')).toBe(0);
  });

  it('adds tracking between characters, in thousandths of an em, but not after the last', () => {
    const layout = layoutText(face, 'BC', { size: 100, tracking: 200 });
    expect(layout.lines[0].glyphs.map((g) => g.x)).toEqual([0, 70]);
    expect(layout.lines[0].width).toBe(120);
  });

  it('breaks at newlines, and at spaces to fit a width, hanging the spaces', () => {
    expect(layoutText(face, 'AB\nCD', { size: 100 }).lines.map(chars)).toEqual(['AB', 'CD']);
    // "BC DE" is 225 px: it fits 225 exactly, and not 224.
    const wrapped = layoutText(face, 'BC DE FG', { size: 100, width: 225 });
    expect(wrapped.lines.map(chars)).toEqual(['BC DE ', 'FG']);
    // A space at the end of a line doesn't count against the width, or show in it.
    expect(wrapped.lines.map((l) => l.width)).toEqual([225, 100]);
    expect(layoutText(face, 'BC DE FG', { size: 100, width: 224 }).lines.map(chars)).toEqual(['BC ', 'DE ', 'FG']);
  });

  it('breaks after a hyphen, and inside a word wider than the line', () => {
    expect(layoutText(face, 'BC-DE', { size: 100, width: 160 }).lines.map(chars)).toEqual(['BC-', 'DE']);
    expect(layoutText(face, 'BCDEFG', { size: 100, width: 160 }).lines.map(chars)).toEqual(['BCD', 'EFG']);
  });

  it('aligns each line on the anchor', () => {
    const text = 'B\nBCD';
    expect(layoutText(face, text, { size: 100, align: 'left' }).lines.map((l) => l.x)).toEqual([0, 0]);
    expect(layoutText(face, text, { size: 100, align: 'center' }).lines.map((l) => l.x)).toEqual([-25, -75]);
    expect(layoutText(face, text, { size: 100, align: 'right' }).lines.map((l) => l.x)).toEqual([-50, -150]);
  });

  it('spaces lines by the line height, with the ascender and descender centred in each', () => {
    const layout = layoutText(face, 'A\nB\nC', { size: 100, lineHeight: 1.5 });
    // Content is 100 px (800 up, 200 down); a 150 px line leaves 25 above; the baseline sits 80 below that.
    expect(layout.lines.map((l) => l.baseline)).toEqual([105, 255, 405]);
    expect(layout.height).toBe(450);
    expect(blockTop(layout, 'top')).toBe(0);
    expect(blockTop(layout, 'middle')).toBe(-225);
    expect(blockTop(layout, 'bottom')).toBe(-450);
    expect(blockTop(layout, 'baseline')).toBe(-105);
  });

  it('draws the missing-glyph box for a character the typeface lacks', () => {
    const layout = layoutText(face, 'AzB', { size: 100 });
    expect(layout.lines[0].glyphs[1].glyph).toBe(face.missing);
    expect(glyphOf(face, 'z')).toBe(face.missing);
    expect(layout.lines[0].width).toBe(50 + 60 + 50);
  });

  it('types text on in reading order without moving it, skipping spaces and not counting newlines', () => {
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_, name) => (...args: number[]) => calls.push(`${String(name)} ${args.join(' ')}`) }) as never;
    const layout = layoutText(face, 'AB C\nD', { size: 100 });
    expect(characterCount('AB C\nD')).toBe(5);
    traceText(ctx, layout, 0, 0, 0, 4);
    // A, B and C: the space counts but draws nothing, and D, the fifth, is left out.
    expect(calls.filter((c) => c.startsWith('moveTo')).length).toBe(3);
    calls.length = 0;
    traceText(ctx, layout, 0, 0, 0);
    expect(calls.filter((c) => c.startsWith('moveTo')).length).toBe(4);
  });

  it('traces outlines flipped to the canvas, y down, at the glyph origin', () => {
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_, name) => (...args: number[]) => calls.push(`${String(name)} ${args.join(' ')}`) }) as never;
    traceGlyph(ctx, [500, 'M0 0L100 0Q200 300 100 700C0 700 0 600 0 500Z'], 10, 100, 0.1);
    expect(calls).toEqual(['moveTo 10 100', 'lineTo 20 100', 'quadraticCurveTo 30 70 20 30', 'bezierCurveTo 10 30 10 40 10 50', 'closePath ']);
  });
});
