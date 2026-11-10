// npm run bench:export: how fast MP4 export runs through the real render
// worker in Electron, by stage, and how a parallel export compares (ticket
// export-speed/01 and 02, ADR 0019).
//
//   npm run bench:export
//   npm run bench:export -- --cases short,long --workers 1,4,6 --minutes 10
//
// Cases: `heavy` is bear-test at 1080p; `short` is why-lakes-stay-liquid, a
// 9:16 short with sound; `long` is a composition of --minutes (default 5) at
// --fps (default 24) built from the repo's scenes in a temporary studio folder,
// which is deleted afterwards. Each case exports once per worker count. Stage
// times are summed over workers, so they read as CPU time per frame; "wall" is
// what a person waits. When ffmpeg is installed, every parallel file's decoded
// frames and audio are compared with the one-worker file's.
// Prints Markdown on stdout; progress goes to stderr. Node only.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from '../studio/folder.ts';
import { installLoader } from '../studio/loader.ts';

installLoader(join(REPO, 'src'));
const { startStudioServer } = await import('../studio/server.ts');
const { studioFolder } = await import('../studio/folder.ts');
const { newToken } = await import('../studio/pairing.ts');
const { exportVideoFile, exportWorkers } = await import('../studio/export-video.ts');

type Result = Awaited<ReturnType<typeof exportVideoFile>>;

const { values } = parseArgs({
  options: {
    cases: { type: 'string', default: 'heavy,short,long' },
    workers: { type: 'string' },
    minutes: { type: 'string', default: '5' },
    fps: { type: 'string', default: '24' },
    keep: { type: 'boolean' },
  },
});

const cases = values.cases.split(',').map((c) => c.trim());
const workerCounts = values.workers ? values.workers.split(',').map(Number) : [...new Set([1, exportWorkers()])];
if (workerCounts.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('--workers takes whole numbers, 1 or more, separated by commas');
const minutes = Number(values.minutes);
const longFps = Number(values.fps);
const log = (line: string) => process.stderr.write(`${line}\n`);

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const machine = {
  cpu: sh('sysctl', ['-n', 'machdep.cpu.brand_string']) || cpus()[0]?.model || 'unknown',
  cores: availableParallelism(),
  performanceCores: Number(sh('sysctl', ['-n', 'hw.perflevel0.physicalcpu'])) || undefined,
  efficiencyCores: Number(sh('sysctl', ['-n', 'hw.perflevel1.physicalcpu'])) || undefined,
  memoryGb: Math.round(totalmem() / 2 ** 30),
  os: sh('sw_vers', ['-productVersion']) || process.platform,
  node: process.version,
  electron: JSON.parse(readFileSync(join(REPO, 'node_modules/electron/package.json'), 'utf8')).version as string,
};
const hasFfmpeg = sh('ffmpeg', ['-version']) !== '';

interface BenchScene {
  fps: number;
  duration: number;
  background?: { overrides?: { from: number; to: number }[] };
  layers?: { overrides?: { from: number; to: number }[] }[];
}

/** A studio folder holding copies of the repo's scenes and one long composition that cycles through them. */
function longFolder(): { root: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), 'frame-studio-bench-'));
  mkdirSync(join(root, 'scenes'));
  mkdirSync(join(root, 'compositions'));
  const sources = ['bear-test', 'shapes-test', 'type-test', 'why-lakes-stay-liquid'];
  const durations: number[] = [];
  for (const id of sources) {
    const scene = JSON.parse(readFileSync(join(REPO, 'scenes', `${id}.json`), 'utf8')) as BenchScene;
    // Clips run at their composition's rate. Key times are in seconds, so motion keeps its pace; override ranges are frames, so they scale.
    const ratio = longFps / scene.fps;
    for (const layer of [scene.background, ...(scene.layers ?? [])]) {
      for (const o of layer?.overrides ?? []) {
        o.from = Math.round(o.from * ratio);
        o.to = Math.max(o.from + 1, Math.round(o.to * ratio));
      }
    }
    scene.fps = longFps;
    durations.push(scene.duration);
    writeFileSync(join(root, 'scenes', `${id}.json`), `${JSON.stringify(scene, null, 2)}\n`);
  }
  const total = minutes * 60;
  const clips: { id: string; scene: string; start: number; out?: number }[] = [];
  for (let at = 0, i = 0; at < total; i++) {
    const k = i % sources.length;
    const length = Math.min(durations[k], total - at);
    clips.push({ id: `clip-${i + 1}`, scene: sources[k], start: at, ...(length < durations[k] ? { out: length } : {}) });
    at += length;
  }
  const id = 'bench-long';
  const composition = { id, fps: longFps, duration: total, size: [1920, 1080], background: '#101014', tracks: [{ id: 'V1', clips }] };
  writeFileSync(join(root, 'compositions', `${id}.json`), `${JSON.stringify(composition, null, 2)}\n`);
  writeFileSync(join(root, 'project.json'), `${JSON.stringify({ name: 'Export benchmark', fps: longFps, size: [1920, 1080] }, null, 2)}\n`);
  return { root, id };
}

/** Per-frame MD5s of the decoded video, and one MD5 of the decoded audio. */
function decodedHashes(path: string): { video: string[]; audio: string } {
  const video = sh('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-'])
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').at(-1)!.trim());
  const audio = sh('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a?', '-f', 'md5', '-']);
  return { video, audio };
}

interface Row {
  label: string;
  frames: number;
  fps: number;
  size: string;
  /** Workers asked for. */
  workers: number;
  /** Workers that had a segment: no more than the segments. */
  used: number;
  segments: number;
  result: Result;
  wallMs: number;
  same?: string;
  /** One-minute load average when the export started and when it ended: other work on the machine skews the numbers. */
  load: [number, number];
}

const rows: Row[] = [];
const out = mkdtempSync(join(tmpdir(), 'frame-studio-bench-out-'));
const folders: string[] = [];

async function run(label: string, folderRoot: string, scene: string): Promise<void> {
  const server = await startStudioServer({
    folder: studioFolder(folderRoot),
    token: newToken(),
    port: 0,
    viewer: { kind: 'vite', hmr: false },
    agents: false,
    thumbs: false,
    worker: 'electron',
    log,
  });
  try {
    const info = (await server.pool.call(scene, 'info', [])) as { scene: { fps: number; frameCount: number; width: number; height: number } | null; errors: string[] };
    if (!info.scene) throw new Error(`${scene}: ${info.errors.join('; ')}`);
    // Warm up: load the library, the scene and the encoder once before timing.
    await exportVideoFile(server.pool, scene, join(out, `${label}-warm.mp4`), { target: 'mp4', from: 0, to: Math.min(info.scene.frameCount, info.scene.fps), workers: 1 });
    let reference: ReturnType<typeof decodedHashes> | null = null;
    for (const workers of workerCounts) {
      const path = join(out, `${label}-w${workers}.mp4`);
      let last = 0;
      const loadBefore = loadavg()[0];
      const start = performance.now();
      const result = await exportVideoFile(server.pool, scene, path, {
        target: 'mp4',
        workers,
        // Split even the short cases, to measure the per-frame cost; a real export under 10 s stays in one page.
        minParallelSeconds: 0,
        onProgress: (p) => {
          const now = performance.now();
          if (now - last < 2000 && p.done !== p.total) return;
          last = now;
          process.stderr.write(`\r${label} ${workers}w ${p.stage} ${p.done}/${p.total}\x1b[K`);
        },
      });
      const wallMs = performance.now() - start;
      const load: [number, number] = [loadBefore, loadavg()[0]];
      process.stderr.write(`\r${label} ${workers}w: ${(wallMs / 1000).toFixed(1)} s, ${(wallMs / result.frames).toFixed(1)} ms/frame\x1b[K\n`);
      let same: string | undefined;
      if (hasFfmpeg) {
        const hashes = decodedHashes(path);
        if (!reference) reference = hashes;
        else {
          const differ = hashes.video.filter((h, i) => h !== reference!.video[i]).length + Math.abs(hashes.video.length - reference.video.length);
          same = differ === 0 && hashes.audio === reference.audio ? 'identical' : `${differ} frames differ${hashes.audio === reference.audio ? '' : ', audio differs'}`;
        }
      }
      rows.push({
        label,
        frames: result.frames,
        fps: info.scene.fps,
        size: `${info.scene.width}x${info.scene.height}`,
        workers,
        used: result.workers ?? 1,
        segments: result.segments ?? 1,
        result,
        wallMs,
        load,
        ...(same ? { same } : {}),
      });
      if (!values.keep) rmSync(path, { force: true });
    }
  } finally {
    await server.close();
  }
}

try {
  if (cases.includes('heavy')) await run('heavy (bear-test)', REPO, 'bear-test');
  if (cases.includes('short')) await run('short (why-lakes-stay-liquid)', REPO, 'why-lakes-stay-liquid');
  if (cases.includes('long')) {
    const long = longFolder();
    folders.push(long.root);
    await run(`long (${minutes} min composition)`, long.root, long.id);
  }
} finally {
  if (!values.keep) {
    rmSync(out, { recursive: true, force: true });
    for (const f of folders) rmSync(f, { recursive: true, force: true });
  } else log(`kept ${out} and ${folders.join(', ')}`);
}

const ms = (n: number) => n.toFixed(1);
const lines: string[] = [];
lines.push(`Machine: ${machine.cpu}, ${machine.cores} cores${machine.performanceCores ? ` (${machine.performanceCores} performance, ${machine.efficiencyCores} efficiency)` : ''}, ${machine.memoryGb} GB, macOS ${machine.os}, Node ${machine.node}, Electron ${machine.electron}.`);
lines.push('');
lines.push('Stage columns are ms per frame summed over workers (CPU time); wall is what you wait, per frame. Load is the one-minute load average at the start and end of each export.');
lines.push('');
lines.push('| Case | Size | fps | Frames | Workers (used) | Segments | Draw | Raster | Convert | Encode | Mux | Audio | Wall ms/frame | Wall s | Speedup | Parallel = serial | Load |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) {
  const s = row.result.stages!;
  const serial = rows.find((r) => r.label === row.label && r.workers === 1);
  const speedup = serial ? serial.wallMs / row.wallMs : NaN;
  const per = (n: number) => ms(n / row.frames);
  lines.push(
    `| ${row.label} | ${row.size} | ${row.fps} | ${row.frames} | ${row.workers}${row.used !== row.workers ? ` (${row.used})` : ''} | ${row.segments} | ${per(s.draw + s.prepare)} | ${per(s.raster)} | ${per(s.convert)} | ${per(s.encode)} | ${per(s.mux)} | ${per(s.audio)} | ${ms(row.wallMs / row.frames)} | ${(row.wallMs / 1000).toFixed(1)} | ${Number.isFinite(speedup) ? `${speedup.toFixed(2)}x` : ''} | ${row.workers === 1 ? '(reference)' : (row.same ?? 'not checked')} | ${row.load.map((l) => l.toFixed(1)).join(' to ')} |`,
  );
}
lines.push('');
lines.push('Projected wall time at the measured ms/frame:');
lines.push('');
lines.push('| Case | Workers | 10 min at 24 fps | 10 min at 30 fps | 15 min at 24 fps | 15 min at 30 fps |');
lines.push('| --- | --- | --- | --- | --- | --- |');
const clock = (seconds: number) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};
for (const row of rows) {
  const per = row.wallMs / row.frames / 1000;
  const cells = [10 * 60 * 24, 10 * 60 * 30, 15 * 60 * 24, 15 * 60 * 30].map((frames) => clock(frames * per));
  lines.push(`| ${row.label} | ${row.workers} | ${cells.join(' | ')} |`);
}
process.stdout.write(`${lines.join('\n')}\n`);
