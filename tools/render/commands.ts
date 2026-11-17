// Frame Studio render tools.
//
//   npm run render -- --scene bear-test --frame 47
//   npm run render -- --scene launch-1 --format jpg --quality 85
//   npm run export -- --scene launch-1 --target png
//   npm run export -- --stills --target png
//   npm run export -- --scene bear-test --target mp4
//   npm run export -- --scene bear-test --target html
//   npm run contact-sheet -- --scene bear-test --every 6
//
// MP4 and HTML exports carry the scene's audio unless --silent; GIFs never do.
// A long MP4 splits across render workers, as many as the machine suits;
// --workers sets the number, and --workers 1 makes it in one page (ADR 0019).
// HTML leaves sound files out unless --media inlines them (ADR 0012).
// An image is one frame at the scene's exact size (ADR 0020): --frame says
// which, 0 when left out, and a JPG takes --quality from 1 to 100. --stills
// exports every one-frame scene in the folder, or the ones --scene names,
// separated by commas.
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
import { withheldNote } from '../studio/code.ts';
import { studioFolder, trustsCode } from '../studio/folder.ts';
import { imageName, isImageFormat, type ImageFormat, type RenderSceneInfo } from '../../src/viewer/render-api.ts';
import { openStudio, writeViaSink, type RenderTransport, type Studio } from './studio.ts';

const USAGE = `Usage:
  node tools/render/cli.ts frame --scene <id> [--frame <n|MM:SS:FF>] [--format png|jpg] [--quality <1-100>] [--out file]
  node tools/render/cli.ts export --scene <id> --target png|jpg [--frame <n|MM:SS:FF>] [--quality <1-100>] [--out file]
  node tools/render/cli.ts export --stills [--scene <id,id>] --target png|jpg [--quality <1-100>]
  node tools/render/cli.ts export --scene <id> --target mp4|gif [--from <n|tc>] [--to <n|tc>] [--silent] [--workers <n>] [--out file]
  node tools/render/cli.ts export --scene <id> --target html [--silent] [--media] [--out file.html]
  node tools/render/cli.ts contact-sheet --scene <id> [--from <n|tc>] [--to <n|tc>] [--every <n>] [--columns <n>] [--out file.png]
Every command takes --folder <studio folder>, the current folder by default.`;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    scene: { type: 'string' },
    frame: { type: 'string' },
    format: { type: 'string' },
    quality: { type: 'string' },
    stills: { type: 'boolean' },
    target: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    every: { type: 'string' },
    columns: { type: 'string' },
    out: { type: 'string' },
    folder: { type: 'string' },
    trust: { type: 'boolean' },
    silent: { type: 'boolean' },
    media: { type: 'boolean' },
    workers: { type: 'string' },
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
if (!values.scene && !values.stills) fail(`${command} needs --scene <id>\n${USAGE}`);
const target = values.target;
if (command === 'export' && target !== 'mp4' && target !== 'gif' && target !== 'html' && !isImageFormat(target)) fail('export needs --target mp4, gif, html, png or jpg');
if (values.format !== undefined && command !== 'frame') fail('--format is for the frame command; export takes --target');
if (values.format !== undefined && !isImageFormat(values.format)) fail(`--format must be png or jpg; got ${JSON.stringify(values.format)}`);
/** The image a frame command or an image export writes; undefined for every other command. */
const image: ImageFormat | undefined = command === 'frame' ? ((values.format as ImageFormat | undefined) ?? 'png') : command === 'export' && isImageFormat(target) ? target : undefined;
if (values.frame !== undefined && !image) fail('--frame is for an image: the frame command, or --target png or jpg');
if (values.quality !== undefined && image !== 'jpg') fail('--quality applies to jpg; a png is lossless');
if (values.stills && (command !== 'export' || !image)) fail('--stills goes with export --target png or jpg');
if (values.stills && (values.frame !== undefined || values.out !== undefined)) fail('--stills writes each still to out/<scene>/; drop --frame and --out');
if (image && command === 'export') {
  const extra = ['from', 'to', 'every', 'columns'].filter((name) => values[name as keyof typeof values] !== undefined);
  if (extra.length > 0) fail(`--target ${image} exports one frame; drop ${extra.map((name) => `--${name}`).join(', ')} and give --frame`);
}
const quality = positiveInt('quality', values.quality);
if (quality !== undefined && quality > 100) fail(`--quality must be from 1 to 100; got ${quality}`);
if (command === 'export' && target === 'html') {
  const extra = ['from', 'to', 'every', 'columns'].filter((name) => values[name as keyof typeof values] !== undefined);
  if (extra.length > 0) fail(`--target html exports the whole scene; drop ${extra.map((name) => `--${name}`).join(', ')}`);
}
if (values.media && (command !== 'export' || target !== 'html')) fail('--media applies to html exports; mp4 always carries sound files');
if (values.silent && (command !== 'export' || target === 'gif' || image)) fail(`--silent applies to mp4 and html exports; ${target === 'gif' ? 'GIFs are always silent' : image ? 'an image makes no sound' : `${command} makes no sound`}`);
if (values.workers !== undefined && (command !== 'export' || target === 'html' || image)) fail('--workers applies to mp4 and gif exports');
const every = positiveInt('every', values.every);
const workers = positiveInt('workers', values.workers);
const columns = positiveInt('columns', values.columns);

const root = resolve(values.folder ?? process.cwd());
// Built-ins only until told otherwise (ADR 0017): this may be a folder somebody sent.
const folder = studioFolder(root, { untrusted: !trustsCode(root, values.trust) });
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
  if (image) {
    const frame = values.frame === undefined ? 0 : await studio.call('resolveFrame', values.frame);
    // The frame command keeps its frame-00047 names; an export is named after the scene.
    const name = command === 'frame' ? `frame-${pad(frame)}.${image}` : imageName(id, image, frame, studio.scene.frameCount);
    const path = values.stills ? resolve(folder.root, `${dir}/${name}`) : outPath(`${dir}/${name}`);
    const result = await writeViaSink(studio, path, (sink) => studio.call('writeImage', frame, sink, { format: image, ...(quality !== undefined ? { quality } : {}) }));
    process.stderr.write(`${id} frame ${frame}: ${result.width}x${result.height} ${image}, ${result.bytes} bytes\n`);
    process.stdout.write(`${shown(path)}\n`);
    return;
  }
  if (command === 'export' && (target === 'mp4' || target === 'gif')) {
    const r = await range(studio);
    const suffix = r.from !== undefined || r.to !== undefined ? `-${pad(r.from ?? 0)}-${pad(r.to ?? studio.scene.frameCount)}` : '';
    const path = outPath(`${dir}/${id}${suffix}.${target}`);
    const result = await studio.exportFile(path, { target, ...r, silent: values.silent, ...(workers !== undefined ? { workers } : {}) });
    const detail = result.codec ? `${result.codec}${result.audioCodec ? ` with ${result.audioCodec} audio` : ''}` : `${result.colours} colours`;
    process.stderr.write(
      `${id} ${target}: frames [${result.from}, ${result.to}), ${result.frames} frames, ${result.seconds} s at ${studio.scene.fps} fps, ${detail}, ${(result.ms / 1000).toFixed(1)} s to export${(result.workers ?? 1) > 1 ? ` on ${result.workers} workers` : ''}\n`,
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

/** Every scene in the folder that renders and has one frame (ADR 0020). */
async function stillKeys(transport: RenderTransport): Promise<string[]> {
  type Info = { scene: RenderSceneInfo | null; errors: string[]; scenes: string[] };
  const { scenes } = (await transport.call('', 'info', [])) as Info;
  const stills: string[] = [];
  for (const key of scenes) {
    const info = (await transport.call(key, 'info', [])) as Info;
    if (info.scene?.frameCount === 1 && info.errors.length === 0) stills.push(key);
  }
  return stills;
}

/** The HTML embed is bundled in Node; it needs no browser. */
async function exportHtml(sceneKey: string): Promise<void> {
  const { CodeHost } = await import('../studio/code.ts');
  const embed = await buildEmbed(sceneKey, { folder, code: new CodeHost(folder), silent: values.silent, media: values.media });
  const path = outPath(`out/${embed.out}/${embed.scene.id}.html`);
  await writeFileAtomic(path, embed.html);
  const sound = embed.generators.length > 0 ? ` and generators ${embed.generators.join(', ')}` : '';
  process.stderr.write(`${embed.scene.id} html: ${(embed.bytes.total / 1024).toFixed(1)} KB with rigs ${embed.rigs.join(', ')}${sound}\n`);
  if (embed.media.length > 0) process.stderr.write(`  with sound files ${embed.media.join(', ')}\n`);
  if (embed.mediaLeftOut.length > 0) process.stderr.write(`  left out sound files ${embed.mediaLeftOut.join(', ')}; --media inlines them\n`);
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
    if (values.stills) {
      // Every one-frame scene, or the ones named. One that fails says why and the rest still export.
      const named = values.scene?.split(',').map((s) => s.trim()).filter(Boolean);
      const keys = named ?? (await stillKeys(connected.transport));
      if (keys.length === 0) throw new Error('There are no stills in this folder. A still is a scene with one frame.');
      for (const key of keys) {
        try {
          if (studio) await studio.load(key);
          else studio = await openStudio(key, { transport: connected.transport, onProgress: progress });
          await run(studio);
        } catch (err) {
          process.stderr.write(`${key}: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
        }
      }
    } else {
      studio = await openStudio(values.scene ?? '', { transport: connected.transport, onProgress: progress });
      await run(studio);
    }
  } catch (err) {
    const note = connected.untrusted ? await withheldNote(folder) : '';
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}${note}\n`);
    process.exitCode = 1;
  } finally {
    await studio?.close();
    await connected.close();
  }
}
