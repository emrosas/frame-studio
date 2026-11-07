// A 5x7 bitmap alphabet for pixel stages, drawn for this project, with the
// accents English and Spanish need. Vector type goes soft at 180x320; these are
// whole pixels at any integer size.

const G: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.####|#....|#....|#....|#....|#....|.####', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|###..|#....|#....|#####', F: '#####|#....|#....|###..|#....|#....|#....',
  G: '.####|#....|#....|#.###|#...#|#...#|.###.', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.', J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|.#.#.|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '0': '.###.|#..##|#.#.#|#.#.#|#.#.#|##..#|.###.', '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####', '3': '####.|....#|....#|.###.|....#|....#|####.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '.###.|#....|#....|####.|#...#|#...#|.###.', '7': '#####|....#|...#.|..#..|..#..|..#..|..#..',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.', '9': '.###.|#...#|#...#|.####|....#|....#|.###.',
  '.': '.|.|.|.|.|.|#', ',': '..|..|..|..|..|.#|#.', '!': '#|#|#|#|#|.|#', '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  ':': '.|.|#|.|.|#|.', "'": '#|#|.|.|.|.|.', '-': '....|....|....|####|....|....|....', '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  '/': '....#|....#|...#.|..#..|.#...|#....|#....', '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##', '=': '....|....|####|....|####|....|....',
  '(': '.#|#.|#.|#.|#.|#.|.#', ')': '#.|.#|.#|.#|.#|.#|#.', '>': '#...|.#..|..#.|...#|..#.|.#..|#...', '<': '...#|..#.|.#..|#...|.#..|..#.|...#',
  '°': '.##.|#..#|#..#|.##.|....|....|....', ' ': '...|...|...|...|...|...|...',
  // Spanish. The ¿ and ¡ hang like their upright twins turned over.
  '¿': '..#..|.....|..#..|.#...|#....|#...#|.###.', '¡': '#|.|#|#|#|#|#',
};

/**
 * An accented capital is its letter, a row shorter so a clear row can sit under
 * the accent, with the accent in the two rows above. It stands on the same
 * baseline as the rest of the line, and a line of capitals keeps its height.
 */
const ACCENTS: Record<string, { base: string; marks: string }> = {
  Á: { base: 'A', marks: '...#.|..#..' },
  É: { base: 'E', marks: '...#.|..#..' },
  Í: { base: 'I', marks: '...#.|..#..' },
  Ó: { base: 'O', marks: '...#.|..#..' },
  Ú: { base: 'U', marks: '...#.|..#..' },
  Ñ: { base: 'N', marks: '.##.#|#..#.' },
  Ü: { base: 'U', marks: '.#.#.|.....' },
};

export const GLYPH_HEIGHT = 7;
/** How many rows an accent takes above the capitals. A line gap one bigger keeps it clear of the line above. */
export const ACCENT_HEIGHT = 2;

/** True when a line holds a letter that reaches above the capitals. */
export const hasAccent = (line: string): boolean => [...line].some((c) => glyph(c).length > GLYPH_HEIGHT);
const GLYPHS = new Map(Object.entries(G).map(([k, v]) => [k, v.split('|')]));
for (const [c, { base, marks }] of Object.entries(ACCENTS)) {
  const letter = GLYPHS.get(base) as string[];
  GLYPHS.set(c, [...marks.split('|'), '.'.repeat(letter[0].length), ...letter.filter((_, row) => row !== 2)]);
}
const missing = GLYPHS.get('?') as string[];

export const glyph = (c: string): string[] => GLYPHS.get(c.toUpperCase()) ?? missing;
export const lineWidth = (line: string): number => {
  let w = 0;
  for (const c of line) w += glyph(c)[0].length + 1;
  return Math.max(0, w - 1);
};

/** Paints a line of text with its top left at (x, y), `size` pixels to the font's pixel, up to `count` characters. */
export function paintLine(fill: (x: number, y: number, w: number, h: number) => void, line: string, x: number, y: number, size: number, count = Infinity): void {
  let pen = x;
  let n = 0;
  for (const c of line) {
    if (n++ >= count) return;
    const rows = glyph(c);
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') fill(pen + rx * size, y + (ry + GLYPH_HEIGHT - rows.length) * size, size, size);
    });
    pen += (rows[0].length + 1) * size;
  }
}
