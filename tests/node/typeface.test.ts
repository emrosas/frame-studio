/**
 * M11 (ADR 0010): the typeface converter's pure parts, and the cut the HTML
 * embed makes of the typefaces.
 */
import { describe, expect, it } from 'vitest';
import { interBold } from '../../src/rigs/type/faces/inter-bold';
import { typefaces } from '../../src/rigs/type/faces/index';
import { kerningOf } from '../../src/rigs/type/typeface';
import { CHARSET, exportName, kerningClasses, outlineText } from '../../tools/type/convert';
import { charactersOf, collectStrings, subsetTypeface, typefacesFor } from '../../tools/type/subset';

describe('the typeface converter', () => {
  it('writes outlines as path text in whole font units', () => {
    expect(
      outlineText([
        { command: 'moveTo', args: [9.4, 0] },
        { command: 'lineTo', args: [532, -1490.6] },
        { command: 'quadraticCurveTo', args: [1, 2, 3, 4] },
        { command: 'bezierCurveTo', args: [1, 2, 3, 4, 5, 6] },
        { command: 'closePath', args: [] },
      ]),
    ).toBe('M9 0L532 -1491Q1 2 3 4C1 2 3 4 5 6Z');
    expect(exportName('instrument-serif-italic')).toBe('instrumentSerifItalic');
    expect(CHARSET).toContain('A');
    expect(CHARSET).toContain('é');
    expect(CHARSET).toContain('’');
  });

  it('stores kerning as classes without losing a pair', () => {
    const chars = [...'AVTo.'];
    const pairs = new Map([['AV', -80], ['AT', -60], ['To', -90], ['T.', -100], ['V.', -100], ['Vo', -40]]);
    const classes = kerningClasses(chars, pairs);
    const face = { ...interBold, kerning: classes };
    for (const a of chars) for (const b of chars) expect(kerningOf(face, a, b), a + b).toBe(pairs.get(a + b) ?? 0);
    // T and V kern alike before "." and differently before "o", so they stay apart; "." never starts a pair.
    expect(classes.left.join('')).not.toContain('.');
  });
});

describe('the typefaces an embed carries', () => {
  it('collects every string in the scene data, and each character in both cases', () => {
    expect([...collectStrings({ a: 'x', b: ['y', { c: 'z' }], d: 1 })]).toEqual(['x', 'y', 'z']);
    expect([...charactersOf(['Ab'])].sort()).toEqual(['A', 'B', 'a', 'b']);
  });

  it('keeps only the glyphs and kerning of the characters used', () => {
    const cut = subsetTypeface(interBold, new Set('AVo'));
    expect(Object.keys(cut.glyphs).sort()).toEqual(['A', 'V', 'o']);
    for (const a of 'AVo') for (const b of 'AVo') expect(kerningOf(cut, a, b), a + b).toBe(kerningOf(interBold, a, b));
    expect(kerningOf(interBold, 'A', 'V')).not.toBe(0);
    expect(cut.license).toBe(interBold.license);
    expect(JSON.stringify(cut).length).toBeLessThan(JSON.stringify(interBold).length / 20);
  });

  it('takes the typefaces the strings name, and always the default', () => {
    expect(typefacesFor(typefaces, new Set(['Hi', 'fraunces'])).map((f) => f.id)).toEqual(['inter', 'fraunces']);
    expect(typefacesFor(typefaces, new Set(['Hi'])).map((f) => f.id)).toEqual(['inter']);
  });
});
