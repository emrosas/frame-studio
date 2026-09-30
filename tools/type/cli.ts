// npm run typeface: turns a font file into a typeface module (ADR 0010).
//
//   npm run typeface -- <font file> --id brand --name "Brand Bold" --license "Copyright … SIL Open Font License 1.1" [--axis wght=700] [--out file.ts]
//   npm run typeface -- --builtins     (downloads and regenerates src/rigs/type/faces/)
//
// A new built-in also goes in src/rigs/type/faces/index.ts. Node only.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from '../studio/folder.ts';
import { BUILTINS, OFL_URL } from './builtins.ts';
import { convertFont, exportName, type ConvertOptions } from './convert.ts';

const FACES = join(REPO, 'src/rigs/type/faces');
const CACHE = join(REPO, 'build/type-cache');

function write(file: string, options: ConvertOptions, out: string): Promise<void> {
  const started = Date.now();
  const result = convertFont(file, options);
  process.stderr.write(
    `${options.id}: ${result.glyphs} glyphs, ${result.kerningPairs} kerning pairs, ${Math.round(result.code.length / 1024)} KB` +
      `${result.missing.length > 0 ? `, missing ${result.missing.length} (${result.missing.slice(0, 12).join('')}${result.missing.length > 12 ? '…' : ''})` : ''}` +
      ` in ${((Date.now() - started) / 1000).toFixed(1)} s\n`,
  );
  return writeFile(out, result.code);
}

async function download(url: string): Promise<string> {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, decodeURIComponent(basename(new URL(url).pathname)));
  if (existsSync(file)) return file;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** A member of a downloaded zip, extracted beside it once. Uses unzip, which macOS and Linux have. */
function extract(zip: string, member: string): string {
  const out = join(CACHE, basename(member));
  if (!existsSync(out)) execFileSync('unzip', ['-o', '-j', zip, member, '-d', CACHE]);
  return out;
}

async function builtins(): Promise<void> {
  await mkdir(FACES, { recursive: true });
  for (const face of BUILTINS) {
    const downloaded = await download(face.url);
    const file = face.member ? extract(downloaded, face.member) : downloaded;
    await write(file, { id: face.id, name: face.name, license: face.license, axes: face.axes, source: face.url }, join(FACES, `${face.id}.ts`));
  }
  // The license, with every built-in's copyright line above it.
  const ofl = await (await fetch(OFL_URL)).text();
  const body = ofl.slice(ofl.indexOf('This Font Software is licensed'));
  const copyrights = [...new Set(BUILTINS.map((f) => f.license.split('. SIL Open Font License')[0]))];
  await writeFile(join(FACES, 'OFL.txt'), `${copyrights.join('\n')}\n\n${body}`);
  process.stderr.write(`Wrote ${BUILTINS.length} typefaces and OFL.txt to ${FACES}. The index lists: ${BUILTINS.map((f) => exportName(f.id)).join(', ')}\n`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    builtins: { type: 'boolean' },
    id: { type: 'string' },
    name: { type: 'string' },
    license: { type: 'string' },
    axis: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
});

if (values.builtins) {
  await builtins();
} else {
  const [file] = positionals;
  if (!file || !values.id || !values.name || !values.license) {
    process.stderr.write('Usage: npm run typeface -- <font file> --id <id> --name "<name>" --license "<copyright and license>" [--axis wght=700] [--out file.ts]\n');
    process.exit(2);
  }
  const axes = Object.fromEntries((values.axis ?? []).map((a) => {
    const [k, v] = a.split('=');
    if (!k || !Number.isFinite(Number(v))) throw new Error(`--axis ${a}: use name=value, e.g. wght=700`);
    return [k, Number(v)];
  }));
  const out = values.out ?? join(FACES, `${values.id}.ts`);
  await readFile(file);
  await write(file, { id: values.id, name: values.name, license: values.license, axes, source: basename(file) }, out);
  process.stdout.write(`${out}\n`);
}
