// Frame Studio render tools.
//
//   npm run render -- --scene bear-test --frame 47
//   npm run export -- --scene bear-test --target mp4
//   npm run export -- --scene bear-test --target html
//   npm run contact-sheet -- --scene bear-test --every 6
//
// MP4 and HTML exports carry the scene's audio unless --silent; GIFs never do.
// Frames and range ends take a frame number or an MM:SS:FF timecode. Files go
// to out/<scene>/ in the studio folder unless --out says otherwise. The
// written path is printed on stdout; progress goes to stderr.
//
// Renders come from a render worker in Electron (ADR 0008): the worker of a
// studio server already running on the folder (the app, or npm run dev), or of
// a headless one this command starts and stops. --folder picks the studio
// folder; it defaults to the current one.

import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildEmbed } from '../bundle/embed.ts';
import { writeFileAtomic } from '../scene-files.ts';
import { connectStudio } from '../studio/connect.ts';
import { studioFolder } from '../studio/folder.ts';
import { openStudio, writeViaSink, type Studio } from './studio.ts';

const USAGE = `Usage:
  node tools/render/cli.ts frame --scene <id> --frame <n|MM:SS:FF> [--out file.png]
  node tools/render/cli.ts export --scene <id> --target mp4|gif [--from <n|tc>] [--to <n|tc>] [--silent] [--out file]
  node tools/render/cli.ts export --scene <id> --target html [--silent] [--out file.html]
  node tools/render/cli.ts contact-sheet --scene <id> [--from <n|tc>] [--to <n|tc>] [--every <n>] [--columns <n>] [--out file.png]
Every command takes --folder <studio folder>, the current folder by default.`;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    scene: { type: 'string' },
    frame: { type: 'string' },
    target: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    every: { type: 'string' },
    columns: { type: 'string' },
    out: { type: 'string' },
    folder: { type: 'string' },
    silent: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function positiveInt(name: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a whole number, 1 or more; got ${JSON.stringify(text)}`);
  return n;
}

// Flags are checked here, before Vite and Chromium start. Checks that need the
// scene (frame ranges, timecodes) happen in the page and throw.
if (values.help || !command) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (!['frame', 'export', 'contact-sheet'].includes(command)) fail(`Unknown command ${JSON.stringify(command)}.\n${USAGE}`);
if (!values.scene) fail(`${command} needs --scene <id>\n${USAGE}`);
if (command === 'frame' && values.frame === undefined) fail('frame needs --frame <n|MM:SS:FF>');
const target = values.target;
if (command === 'export' && target !== 'mp4' && target !== 'gif' && target !== 'html') fail('export needs --target mp4, gif or html');
if (command === 'export' && target === 'html') {
  const extra = ['from', 'to', 'every', 'columns'].filter((name) => values[name as keyof typeof values] !== undefined);
  if (extra.length > 0) fail(`--target html exports the whole scene; drop ${extra.map((name) => `--${name}`).join(', ')}`);
}
if (values.silent && (command !== 'export' || target === 'gif')) fail(`--silent applies to mp4 and html exports; ${target === 'gif' ? 'GIFs are always silent' : `${command} makes no sound`}`);
const every = positiveInt('every', values.every);
const columns = positiveInt('columns', values.columns);

const folder = studioFolder(resolve(values.folder ?? process.cwd()));
const pad = (n: number) => String(n).padStart(5, '0');
const outPath = (fallback: string) => (values.out !== undefined ? resolve(values.out) : resolve(folder.root, fallback));
const shown = (path: string) => relative(process.cwd(), path) || path;

/** One progress line on stderr, redrawn in place on a terminal. */
function progress(stage: string, done: number, total: number): void {
  const line = `${stage} ${done}/${total}`;
  if (process.stderr.isTTY) process.stderr.write(`\r${line}\x1b[K${done === total ? '\n' : ''}`);
  else if (done === total || done % Math.max(1, Math.round(total / 10)) === 0) process.stderr.write(`${line}\n`);
}

async function range(studio: Studio): Promise<{ from?: number; to?: number }> {
  return {
    from: values.from === undefined ? undefined : await studio.call('resolveFrame', values.from),
    to: values.to === undefined ? undefined : await studio.call('resolveFrame', values.to, true),
  };
}

async function run(studio: Studio): Promise<void> {
  const id = studio.scene.id;
  const dir = `out/${studio.scene.out}`;
  if (command === 'frame') {
    const frame = await studio.call('resolveFrame', values.frame ?? '');
    const path = outPath(`${dir}/frame-${pad(frame)}.png`);
    const bytes = await writeViaSink(studio, path, (sink) => studio.call('writePng', frame, sink));
    process.stderr.write(`${id} frame ${frame}: ${studio.scene.width}x${studio.scene.height}, ${bytes} bytes\n`);
    process.stdout.write(`${shown(path)}\n`);
    return;
  }
  if (command === 'export' && (target === 'mp4' || target === 'gif')) {
    const r = await range(studio);
    const suffix = r.from !== undefined || r.to !== undefined ? `-${pad(r.from ?? 0)}-${pad(r.to ?? studio.scene.frameCount)}` : '';
    const path = outPath(`${dir}/${id}${suffix}.${target}`);
    const result = await writeViaSink(studio, path, (sink) => studio.call('exportVideo', target, sink, { ...r, silent: values.silent }));
    const detail = result.codec ? `${result.codec}${result.audioCodec ? ` with ${result.audioCodec} audio` : ''}` : `${result.colours} colours`;
    process.stderr.write(
      `${id} ${target}: frames [${result.from}, ${result.to}), ${result.frames} frames, ${result.seconds} s at ${studio.scene.fps} fps, ${detail}, ${(result.ms / 1000).toFixed(1)} s to export\n`,
    );
    process.stdout.write(`${shown(path)}\n`);
    return;
  }
  if (command === 'contact-sheet') {
    const r = await range(studio);
    const suffix = r.from !== undefined || r.to !== undefined || every !== undefined ? `-${pad(r.from ?? 0)}-${pad(r.to ?? studio.scene.frameCount)}${every ? `-every${every}` : ''}` : '';
    const path = outPath(`${dir}/contact-sheet${suffix}.png`);
    const sheet = await writeViaSink(studio, path, (sink) => studio.call('contactSheet', sink, { ...r, every, columns }));
    process.stderr.write(`${id} contact sheet: ${sheet.frames.length} frames (${sheet.frames[0]} to ${sheet.frames.at(-1)}), ${sheet.width}x${sheet.height}\n`);
    process.stdout.write(`${shown(path)}\n`);
    return;
  }
}

/** The HTML embed is bundled in Node; it needs no browser. */
async function exportHtml(sceneKey: string): Promise<void> {
  const { CodeHost } = await import('../studio/code.ts');
  const embed = await buildEmbed(sceneKey, { folder, code: new CodeHost(folder), silent: values.silent });
  const path = outPath(`out/${embed.out}/${embed.scene.id}.html`);
  await writeFileAtomic(path, embed.html);
  const sound = embed.generators.length > 0 ? ` and generators ${embed.generators.join(', ')}` : '';
  process.stderr.write(`${embed.scene.id} html: ${(embed.bytes.total / 1024).toFixed(1)} KB with rigs ${embed.rigs.join(', ')}${sound}\n`);
  process.stdout.write(`${shown(path)}\n`);
}

// Errors set the exit code and let the process end on its own, so stdout is flushed first.
if (command === 'export' && target === 'html') {
  try {
    await exportHtml(values.scene ?? '');
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} else {
  const connected = await connectStudio(folder, { log: (line) => process.stderr.write(`${line}\n`) });
  let studio: Studio | undefined;
  try {
    studio = await openStudio(values.scene ?? '', { transport: connected.transport, onProgress: progress });
    await run(studio);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    await studio?.close();
    await connected.close();
  }
}
