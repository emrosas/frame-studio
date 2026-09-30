// Cuts typefaces down to what a scene draws, for the HTML embed (ADR 0010):
// the typefaces a scene names, plus the default, each with only the glyphs
// and kerning of the characters in the scene's strings. Node only.

import type { Typeface } from '../../src/rigs/type/typeface.ts';

/** Every string anywhere in `value`, however deep. */
export function collectStrings(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** The characters of `strings`, with their capitals and lower case too, since the text rig can change case. */
export function charactersOf(strings: Iterable<string>): Set<string> {
  const chars = new Set<string>();
  for (const s of strings) for (const variant of [s, s.toUpperCase(), s.toLowerCase()]) for (const c of variant) chars.add(c);
  return chars;
}

/** `face` with only the glyphs, and the kerning classes, of `chars`. */
export function subsetTypeface(face: Typeface, chars: ReadonlySet<string>): Typeface {
  const glyphs = Object.fromEntries(Object.entries(face.glyphs).filter(([c]) => chars.has(c)));
  const keep = (classes: readonly string[]) => {
    const index = new Map<number, number>();
    const kept: string[] = [];
    classes.forEach((cls, i) => {
      const left = [...cls].filter((c) => chars.has(c)).join('');
      if (!left) return;
      index.set(i, kept.length);
      kept.push(left);
    });
    return { kept, index };
  };
  const left = keep(face.kerning.left);
  const right = keep(face.kerning.right);
  const pairs: number[] = [];
  const p = face.kerning.pairs;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const l = left.index.get(p[i]);
    const r = right.index.get(p[i + 1]);
    if (l !== undefined && r !== undefined) pairs.push(l, r, p[i + 2]);
  }
  return { ...face, glyphs, kerning: { left: left.kept, right: right.kept, pairs } };
}

/**
 * The typefaces an embed needs: those whose id is one of `strings`, and the
 * first (the text rig's default), each cut to the characters of `strings`.
 */
export function typefacesFor(all: readonly Typeface[], strings: ReadonlySet<string>): Typeface[] {
  const chars = charactersOf(strings);
  return all.filter((face, i) => i === 0 || strings.has(face.id)).map((face) => subsetTypeface(face, chars));
}
