import { describe, expect, it } from 'vitest';
import { ACCENT_HEIGHT, GLYPH_HEIGHT, glyph, hasAccent, lineWidth, paintLine } from './font';

describe('the pixel font in Spanish', () => {
  const unknown = glyph('\u{1F600}');

  it.each([...'ÁÉÍÓÚÑÜ¿¡'])('draws %s as itself', (c) => {
    expect(glyph(c)).not.toEqual(unknown);
  });

  it.each([...'áéíóúñü'])('draws %s as its capital', (c) => {
    expect(glyph(c)).toEqual(glyph(c.toUpperCase()));
  });

  it('keeps an accented capital as wide as its letter', () => {
    expect(lineWidth('AÑO')).toBe(lineWidth('ANO'));
  });

  it('sets the accent clear of its letter, on the baseline the line stands on', () => {
    const paint = (text: string) => {
      const rows = new Set<number>();
      paintLine((_x, y) => rows.add(y), text, 0, 10, 1);
      return rows;
    };
    const plain = paint('A');
    const accented = paint('Á');
    expect(Math.min(...plain)).toBe(10);
    expect(Math.min(...accented)).toBe(10 - ACCENT_HEIGHT);
    expect(accented.has(10)).toBe(false);
    expect(Math.max(...accented)).toBe(Math.max(...plain));
    expect(Math.max(...accented)).toBe(10 + GLYPH_HEIGHT - 1);
  });

  it('opens the gap between lines only where an accent needs it', () => {
    expect(hasAccent('ANO')).toBe(false);
    expect(hasAccent('año')).toBe(true);
  });
});
