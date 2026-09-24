/**
 * Runtime budget: src/engine, src/rigs, and src/audio ship in the single-file
 * embed, so they may import only each other (by relative path) and must stay
 * deterministic. See CLAUDE.md, "Runtime budget" and "Core principle".
 *
 * Sources are read with Vite's import.meta.glob (?raw), so this test needs no
 * Node typings and picks up new files automatically.
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

const RUNTIME_ROOTS = ['/src/engine/', '/src/rigs/', '/src/audio/'] as const;
const FORBIDDEN_TARGETS = ['/src/viewer/', '/src/export/', '/tools/'] as const;

/**
 * The only runtime dependencies: export encoders, used by browser code in
 * src/export (ticket 14). The single-file embed never ships them.
 */
const EXPORT_DEPENDENCIES = ['gifenc', 'mediabunny'];

// Every script extension Vite would bundle, so a .mts or .js file cannot slip past the scan.
const globbed = import.meta.glob(
  ['/src/{engine,rigs,audio}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '!**/*.test.*', '!**/*.d.{ts,mts,cts}'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
// All other app code, to check that only src/export reaches for the export libraries.
const appSources = import.meta.glob(
  ['/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '!/src/export/**', '!**/*.test.*', '!**/*.d.{ts,mts,cts}'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const isRuntimeSource = (f: string) => !/\.test\.[^/]+$/.test(f) && !/\.d\.[mc]?ts$/.test(f);
const sources = Object.fromEntries(Object.entries(globbed).filter(([f]) => isRuntimeSource(f)));

const CLOCK_FIX = 'use the seeded rng and the frame time instead';

/**
 * APIs that make output depend on the wall clock or on unseeded randomness,
 * plus Vite-only syntax the single-file embed cannot run. The scan is line
 * based and includes comments. It catches the common direct forms; aliasing
 * can still get past it.
 */
const BANNED: { name: string; re: RegExp; fix?: string }[] = [
  { name: 'Math.random', re: /\bMath\s*(?:\.\s*random\b|\[\s*['"`]random['"`]\s*\])/ },
  { name: 'Math.random (destructured)', re: /\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b/ },
  { name: 'Date.now', re: /\bDate\s*(?:\.\s*now\b|\[\s*['"`]now['"`]\s*\])/ },
  { name: 'new Date (current time)', re: /\bnew\s+Date\b/ },
  { name: 'Date() (current time as a string)', re: /(?<!\bnew\s+)\bDate\s*\(/ },
  // Needs a member name right after the dot, so "good for performance." in a comment passes.
  { name: 'performance.now or another performance timer', re: /\bperformance\s*(?:\??\.[A-Za-z_$]|\[)/ },
  { name: 'document.timeline', re: /\bdocument\s*\.\s*timeline\b/ },
  { name: 'requestAnimationFrame', re: /\brequestAnimationFrame\b/ },
  { name: 'crypto randomness', re: /\bcrypto\s*\.\s*(?:getRandomValues|randomUUID)\b/ },
  {
    name: 'import.meta.glob',
    re: /\bimport\s*\.\s*meta\s*\.\s*glob\b/,
    fix: 'it only works under Vite, and the single-file embed has no bundler; import each file by relative path',
  },
];

/** Resolve a relative specifier against a root-relative file path like /src/rigs/circle.ts. */
function resolveSpecifier(file: string, spec: string): string {
  const parts = file.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/') || '/';
}

interface Specifier {
  spec: string | null; // null: a dynamic import or require whose argument is not a string literal
  line: number;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Every module specifier in a source file: import/export ... from, side-effect imports, import(), require(). */
export function findSpecifiers(source: string): Specifier[] {
  const out: Specifier[] = [];
  const add = (spec: string | null, index: number) => out.push({ spec, line: lineOf(source, index) });

  // import/export clause (may span lines, never contains quotes or semicolons) then from '...'
  for (const m of source.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"\n]*)\1/g)) add(m[2], m.index ?? 0);
  for (const m of source.matchAll(/\bimport\s*(['"])([^'"\n]*)\1/g)) add(m[2], m.index ?? 0);
  for (const m of source.matchAll(/\b(?:import|require)\s*\(\s*([^)]*?)\s*[,)]/g)) {
    const arg = m[1];
    const literal = /^(['"])([^'"\n]*)\1$/.exec(arg) ?? /^`([^`$]*)`$/.exec(arg);
    add(literal ? literal[literal.length - 1] : null, m.index ?? 0);
  }
  return out;
}

/** Everything wrong with one runtime source file, as readable strings. */
export function findViolations(file: string, source: string): string[] {
  const problems: string[] = [];
  for (const { spec, line } of findSpecifiers(source)) {
    const where = `${file}:${line}`;
    if (spec === null) {
      problems.push(`${where}: dynamic import/require with a non-literal specifier; use a static relative import`);
      continue;
    }
    if (!(spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..')) {
      problems.push(`${where}: imports "${spec}", which is not a relative path; runtime code takes no packages`);
      continue;
    }
    const target = resolveSpecifier(file, spec);
    const inside = (root: string) => `${target}/`.startsWith(root) || target.startsWith(root);
    const forbidden = FORBIDDEN_TARGETS.find(inside);
    if (forbidden) {
      problems.push(`${where}: imports "${spec}", which resolves into ${forbidden}; runtime code must not depend on UI or tooling`);
    } else if (!RUNTIME_ROOTS.some(inside)) {
      problems.push(`${where}: imports "${spec}" (${target}), outside src/engine, src/rigs, src/audio`);
    } else if (file.startsWith('/src/engine/') && inside('/src/rigs/')) {
      problems.push(`${where}: the engine imports a rig ("${spec}"); rigs reach the engine through the registry`);
    }
  }
  source.split('\n').forEach((text, i) => {
    for (const { name, re, fix = CLOCK_FIX } of BANNED) {
      if (re.test(text)) problems.push(`${file}:${i + 1}: uses ${name}; ${fix}`);
    }
  });
  return problems;
}

describe('runtime budget', () => {
  const files = Object.keys(sources).sort();

  it('finds the engine sources (the scan is not vacuous)', () => {
    const engineFiles = files.filter((f) => f.startsWith('/src/engine/'));
    for (const f of ['/src/engine/index.ts', '/src/engine/render.ts', '/src/engine/rng.ts', '/src/engine/types.ts']) {
      expect(engineFiles).toContain(f);
    }
    expect(Object.keys(globbed).filter((f) => !isRuntimeSource(f))).toEqual([]); // the glob's own exclusions work
  });

  it('runtime code imports only runtime code, by relative path, and never uses wall-clock or unseeded randomness', () => {
    const problems = files.flatMap((f) => findViolations(f, sources[f]));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('package.json declares only the export libraries as runtime dependencies', () => {
    const deps = (pkg as { dependencies?: Record<string, string> }).dependencies ?? {};
    expect(Object.keys(deps).sort()).toEqual(EXPORT_DEPENDENCIES);
  });

  it('only src/export imports the export libraries', () => {
    expect(Object.keys(appSources)).toContain('/src/viewer/render-main.ts');
    const problems = Object.entries(appSources).flatMap(([file, source]) =>
      findSpecifiers(source)
        .filter(({ spec }) => spec !== null && EXPORT_DEPENDENCIES.some((dep) => spec === dep || spec.startsWith(`${dep}/`)))
        .map(({ spec, line }) => `${file}:${line}: imports "${spec}"; go through src/export instead`),
    );
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('runtime budget scanner (self-test)', () => {
  const file = '/src/rigs/fly.ts';
  const check = (source: string, f = file) => findViolations(f, source);

  it('accepts relative imports inside the runtime roots', () => {
    expect(
      check(`
        import { createRng } from '../engine/rng';
        import type { Rig } from "../engine/types";
        import * as parts from './parts/body';
        export { wing } from './parts/wing';
        export * from './parts';
        import './side-effect';
        const lazy = () => import('./lazy');
        const cycle = Math.sin(t) * Math.PI;
      `),
    ).toEqual([]);
  });

  it('allows the word "performance" in prose and AudioContext time', () => {
    expect(check(`// cached for performance\n// good for performance. Next sentence.\nconst t = audio.currentTime;`)).toEqual([]);
  });

  it.each([
    ['/src/engine/a.ts', true],
    ['/src/engine/a.mts', true],
    ['/src/engine/a.cts', true],
    ['/src/rigs/a.tsx', true],
    ['/src/rigs/a.js', true],
    ['/src/rigs/a.mjs', true],
    ['/src/audio/a.cjs', true],
    ['/src/audio/a.jsx', true],
    ['/src/engine/a.test.ts', false],
    ['/src/engine/a.test.mts', false],
    ['/src/rigs/a.test.js', false],
    ['/src/engine/a.d.ts', false],
    ['/src/engine/a.d.mts', false],
  ])('isRuntimeSource(%s) is %s', (file, expected) => {
    expect(isRuntimeSource(file)).toBe(expected);
  });

  it('ignores "from" inside ordinary strings', () => {
    expect(check(`const msg = 'expected { "from": frame, "to": frame }';`)).toEqual([]);
  });

  it('handles multi-line imports', () => {
    expect(check(`import {\n  a,\n  b,\n} from 'zod';`)).toHaveLength(1);
    expect(check(`import {\n  a,\n  b,\n} from '../engine';`)).toEqual([]);
  });

  it.each([
    [`import { z } from 'zod';`, /not a relative path/],
    [`import gsap from "gsap";`, /not a relative path/],
    [`import fs from 'node:fs';`, /not a relative path/],
    [`export { x } from 'lodash';`, /not a relative path/],
    [`import 'polyfill';`, /not a relative path/],
    [`const m = await import('three');`, /not a relative path/],
    [`const m = require('three');`, /not a relative path/],
    [`const m = await import(name);`, /non-literal/],
    [`import { ui } from '../viewer/ui';`, /src\/viewer/],
    [`import { exportMp4 } from '../export';`, /src\/export/],
    [`import { x } from '../../tools/render/x';`, /tools/],
    [`import data from '../../scenes/a.json';`, /outside/],
    [`const r = Math.random();`, /Math\.random/],
    [`const r = Math['random']();`, /Math\.random/],
    [`const t = Date.now();`, /Date\.now/],
    [`const t = performance.now();`, /performance\.now/],
    [`const t = globalThis.performance.now();`, /performance\.now/],
    [`const d = new Date();`, /new Date/],
    [`const d = new Date;`, /new Date/],
    [`const n = +new Date;`, /new Date/],
    [`export const stamp = Date();`, /Date\(\)/],
    [`const { random } = Math; random();`, /Math\.random/],
    [`const t0 = performance.timeOrigin;`, /performance/],
    [`const t = performance?.now();`, /performance/],
    [`const t = document.timeline.currentTime;`, /document\.timeline/],
    [`requestAnimationFrame(step);`, /requestAnimationFrame/],
    [`crypto.getRandomValues(buf);`, /crypto/],
    [`const rigs = import.meta.glob('./*.ts');`, /import\.meta\.glob/],
  ])('rejects %s', (source, message) => {
    const problems = check(source);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(message);
  });

  it('forbids the engine from importing rigs', () => {
    expect(check(`import { allRigs } from '../rigs';`, '/src/engine/render.ts').join('\n')).toMatch(/engine imports a rig/);
    expect(check(`import { x } from '../engine';`, '/src/rigs/index.ts')).toEqual([]);
  });

  it('reports the line number', () => {
    expect(check(`// fine\nconst a = 1;\nconst r = Math.random();`)[0]).toMatch(/^\/src\/rigs\/fly\.ts:3: /);
  });
});
