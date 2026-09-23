/**
 * The engine reaches the DOM only through the 2D context it is handed. It
 * never constructs canvases or image data and never touches page globals, so
 * it runs unchanged in the viewer, a worker, the headless renderer and the
 * single-file embed. Comments are skipped, so docs may name these APIs.
 */
import { describe, expect, it } from 'vitest';

const globbed = import.meta.glob(['./**/*.ts', '!./**/*.test.ts', '!./**/*.d.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'constructs a DOM object', re: /\bnew\s+(?:ImageData|OffscreenCanvas|Path2D|DOMMatrix|Image|Blob|Worker|FontFace)\b/ },
  { name: 'calls a DOM factory', re: /\b(?:createImageBitmap|fetch|OffscreenCanvas|ImageData)\s*\(/ },
  { name: 'uses a page global', re: /\b(?:document|window|navigator|location|globalThis|self)\b/ },
];

/** Blank out comments, keeping line numbers. Good enough for this code base, which has no "//" inside strings. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

export function findDomUse(file: string, source: string): string[] {
  const problems: string[] = [];
  stripComments(source)
    .split('\n')
    .forEach((line, i) => {
      for (const { name, re } of FORBIDDEN) if (re.test(line)) problems.push(`${file}:${i + 1}: ${name}: ${line.trim()}`);
    });
  return problems;
}

describe('engine stays DOM-free', () => {
  it('scans the engine sources (the scan is not vacuous)', () => {
    expect(Object.keys(globbed)).toEqual(expect.arrayContaining(['./hit-test.ts', './render.ts', './index.ts', './testing/recording-context.ts']));
  });

  it('touches the DOM only through the context passed in', () => {
    const problems = Object.entries(globbed).flatMap(([file, source]) => findDomUse(file, source));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it.each([
    ['const d = new ImageData(1, 1);', /constructs/],
    ['const c = new OffscreenCanvas(1, 1);', /constructs/],
    ['const p = new Path2D();', /constructs/],
    ['const b = await createImageBitmap(x);', /factory/],
    ['const w = document.createElement("canvas");', /page global/],
    ['const r = window.devicePixelRatio;', /page global/],
    ['const g = globalThis.OffscreenCanvas;', /page global/],
  ])('flags %s', (line, message) => {
    expect(findDomUse('x.ts', line).join('\n')).toMatch(message);
  });

  it('ignores comments and methods on the passed context', () => {
    expect(findDomUse('x.ts', '/** new ImageData(1, 1) in a doc */\n// window.foo\nprobe.createImageData(1, 1);')).toEqual([]);
  });
});
