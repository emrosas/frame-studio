import { describe, expect, it } from 'vitest';
import { text } from '../text';
import { traceGlyph } from '../typeface';
import { typefaces } from './index';

const ascii = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));

describe('the built-in typefaces', () => {
  it('have unique ids, Inter first as the default, and the text rig offers them all', () => {
    const ids = typefaces.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('inter');
    expect(text.params.font).toMatchObject({ type: 'enum', default: 'inter', options: ids });
  });

  it.each(typefaces.map((f) => [f.id, f] as const))('%s: has every ASCII character, sane metrics and its license', (_, face) => {
    for (const c of ascii) expect(face.glyphs[c], `"${c}"`).toBeDefined();
    expect(face.unitsPerEm).toBeGreaterThan(0);
    expect(face.ascender).toBeGreaterThan(face.capHeight);
    expect(face.capHeight).toBeGreaterThan(face.xHeight);
    expect(face.xHeight).toBeGreaterThan(0);
    expect(face.descender).toBeLessThan(0);
    expect(face.license).toMatch(/Copyright .* SIL Open Font License 1\.1/);
  });

  it.each(typefaces.map((f) => [f.id, f] as const))('%s: every outline traces to finite points, and the kerning classes are well formed', (_, face) => {
    let bad = 0;
    const ctx = new Proxy({}, { get: () => (...args: number[]) => { if (!args.every(Number.isFinite)) bad++; } }) as never;
    for (const glyph of [...Object.values(face.glyphs), face.missing]) {
      expect(Number.isFinite(glyph[0])).toBe(true);
      traceGlyph(ctx, glyph, 0, 0, 0.05);
    }
    expect(bad).toBe(0);
    const { left, right, pairs } = face.kerning;
    expect(pairs.length % 3).toBe(0);
    for (let i = 0; i < pairs.length; i += 3) {
      expect(pairs[i]).toBeLessThan(left.length);
      expect(pairs[i + 1]).toBeLessThan(right.length);
    }
    for (const classes of [left, right]) {
      const all = classes.join('');
      expect(new Set(all).size, 'a character in two classes').toBe([...all].length);
    }
  });
});
