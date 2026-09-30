// A typeface as code (ADR 0010): glyph outlines, advances, kerning and
// vertical metrics as plain data, generated from a font file by
// `npm run typeface` (tools/type/). Nothing here reads a font file, calls
// measureText or sets ctx.font, so text draws the same on every machine.

import type { Ctx2D } from '../../engine/types';

/** A glyph: its advance, and its outline as path commands in font units with y up, e.g. "M9 0L532 1490Q600 1500 640 1450Z". */
export type Glyph = readonly [advance: number, outline: string];

export interface Typeface {
  /** The id scenes name it by, e.g. "inter-bold". */
  id: string;
  /** The name to show, e.g. "Inter Bold". */
  name: string;
  /** Its copyright and license, which travel with it into every export. */
  license: string;
  unitsPerEm: number;
  /** Above the baseline, in font units. */
  ascender: number;
  /** Below the baseline, in font units: negative. */
  descender: number;
  capHeight: number;
  xHeight: number;
  /** Glyphs by the character they draw. */
  glyphs: Readonly<Record<string, Glyph>>;
  /** The missing-glyph box, drawn for a character the typeface doesn't have. */
  missing: Glyph;
  /**
   * Pair kerning in font units, as classes: characters in one string of
   * `left` kern the same against everything, likewise `right`. `pairs` is flat
   * triples of left class, right class and value; pairs that don't kern are left out.
   */
  kerning: { readonly left: readonly string[]; readonly right: readonly string[]; readonly pairs: readonly number[] };
}

/** The glyph for `char`, or the missing-glyph box. */
export function glyphOf(face: Typeface, char: string): Glyph {
  return face.glyphs[char] ?? face.missing;
}

// Kerning tables, built once per typeface from its classes. Pure, like the parsed outlines below.
const kerningTables = new WeakMap<Typeface, { left: Map<string, number>; right: Map<string, number>; values: Map<number, number>; width: number }>();

/** The kerning between `a` and `b`, in font units. */
export function kerningOf(face: Typeface, a: string, b: string): number {
  let table = kerningTables.get(face);
  if (!table) {
    const index = (classes: readonly string[]) => {
      const map = new Map<string, number>();
      classes.forEach((chars, i) => {
        for (const c of chars) map.set(c, i);
      });
      return map;
    };
    const width = face.kerning.right.length;
    const values = new Map<number, number>();
    const p = face.kerning.pairs;
    for (let i = 0; i + 2 < p.length; i += 3) values.set(p[i] * width + p[i + 1], p[i + 2]);
    table = { left: index(face.kerning.left), right: index(face.kerning.right), values, width };
    kerningTables.set(face, table);
  }
  const l = table.left.get(a);
  const r = table.right.get(b);
  return l === undefined || r === undefined ? 0 : (table.values.get(l * table.width + r) ?? 0);
}

// Parsed outlines, by their text. Parsing is pure, so keeping the result changes nothing a frame draws.
const parsed = new Map<string, Float64Array>();
const OPS: Record<string, number> = { M: 0, L: 1, Q: 2, C: 3, Z: 4 };
const ARGS = [2, 2, 4, 6, 0];

/** An outline as a flat list: an op code (M 0, L 1, Q 2, C 3, Z 4), then its numbers. */
function parse(outline: string): Float64Array {
  let out = parsed.get(outline);
  if (out) return out;
  const tokens = outline.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const values: number[] = [];
  let expect = 0;
  for (const token of tokens) {
    const op = OPS[token];
    if (op !== undefined) {
      if (expect !== 0) throw new Error(`glyph outline has a command with too few numbers: "${outline.slice(0, 40)}…"`);
      values.push(op);
      expect = ARGS[op];
    } else {
      if (expect === 0) throw new Error(`glyph outline has a number outside a command: "${outline.slice(0, 40)}…"`);
      values.push(Number(token));
      expect--;
    }
  }
  out = Float64Array.from(values);
  parsed.set(outline, out);
  return out;
}

/**
 * Adds a glyph's outline to the current path, with its origin (on the
 * baseline) at (x, y) and `scale` scene pixels per font unit. Font units have
 * y up; the canvas has y down.
 */
export function traceGlyph(ctx: Ctx2D, glyph: Glyph, x: number, y: number, scale: number): void {
  const ops = parse(glyph[1]);
  const px = (u: number) => x + u * scale;
  const py = (v: number) => y - v * scale;
  for (let i = 0; i < ops.length; ) {
    switch (ops[i]) {
      case 0:
        ctx.moveTo(px(ops[i + 1]), py(ops[i + 2]));
        i += 3;
        break;
      case 1:
        ctx.lineTo(px(ops[i + 1]), py(ops[i + 2]));
        i += 3;
        break;
      case 2:
        ctx.quadraticCurveTo(px(ops[i + 1]), py(ops[i + 2]), px(ops[i + 3]), py(ops[i + 4]));
        i += 5;
        break;
      case 3:
        ctx.bezierCurveTo(px(ops[i + 1]), py(ops[i + 2]), px(ops[i + 3]), py(ops[i + 4]), px(ops[i + 5]), py(ops[i + 6]));
        i += 7;
        break;
      default:
        ctx.closePath();
        i += 1;
    }
  }
}
