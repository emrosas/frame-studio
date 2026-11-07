// Kokoro, the voice that needs no key (ADR 0017). sherpa-onnx-node 1.13.8 and
// the Kokoro v1.0 model download on first use into ~/.frame-studio/models/, each
// archive checked against a pinned sha256 before anything unpacks it. Pinned at
// 1.13.8 because 2.x dropped espeak-ng, and Spanish needs it. espeak-ng is GPL,
// which is why none of this ships in the app. Speech runs in a child process
// (kokoro-child.cjs). The studio server and the MCP tool use this; it never
// touches a key. Node only.

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { KokoroStatus } from '../../src/studio/protocol.ts';
import { agentEnv } from '../studio/agents/exec.ts';

const SHERPA = '1.13.8';
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2';

export interface KokoroArchive {
  url: string;
  sha256: string;
  bytes: number;
  /** Where it unpacks, inside the install. */
  into: string;
}

export interface KokoroManifest {
  /** Names the install's folder, so a new pin downloads anew. */
  version: string;
  archives: KokoroArchive[];
}

const ADDONS: Record<string, { sha256: string; bytes: number }> = {
  'darwin-arm64': { sha256: 'e1abc1d9676478996574de922e55714d80b4500b860bc4e7349aa01cd0ea4929', bytes: 10047754 },
  'darwin-x64': { sha256: '3e583d3423160cb8a0f9316008e293ad9a6b66c63e1966ad399a88300390fbaa', bytes: 11191481 },
  'linux-arm64': { sha256: 'e1671ad6e94e51947229a5736d06022780f3fba967da8d917173cd9765902ee8', bytes: 13910679 },
  'linux-x64': { sha256: '13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c', bytes: 11089653 },
};

const npm = (name: string) => `https://registry.npmjs.org/${name}/-/${name}-${SHERPA}.tgz`;

/** What to download on this machine, or null where sherpa-onnx has no build we pin. */
export function kokoroManifest(platform = `${process.platform}-${process.arch}`): KokoroManifest | null {
  const addon = ADDONS[platform];
  if (!addon) return null;
  return {
    version: `kokoro-v1_0-sherpa-${SHERPA}`,
    archives: [
      { url: npm('sherpa-onnx-node'), sha256: 'db2a7b8b18d950b6e9ca5c1c919afec33fd3dd2bfef1aade0bea5a9fe7a1f0f1', bytes: 11954, into: 'runtime/sherpa-onnx-node' },
      { url: npm(`sherpa-onnx-${platform}`), ...addon, into: `runtime/sherpa-onnx-${platform}` },
      { url: MODEL_URL, sha256: '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4', bytes: 349886476, into: 'model' },
    ],
  };
}

export interface KokoroVoice {
  id: string;
  label: string;
  langs: readonly string[];
  detail: string;
  /** The speaker's number in the model's voices.bin. */
  sid: number;
}

/** The English and Spanish speakers, with the numbers the model's own metadata gives them. */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
  { id: 'af_heart', label: 'Heart', langs: ['en'], detail: 'American, warm', sid: 3 },
  { id: 'af_bella', label: 'Bella', langs: ['en'], detail: 'American, bright', sid: 2 },
  { id: 'af_nicole', label: 'Nicole', langs: ['en'], detail: 'American, close', sid: 6 },
  { id: 'am_michael', label: 'Michael', langs: ['en'], detail: 'American, steady', sid: 16 },
  { id: 'am_onyx', label: 'Onyx', langs: ['en'], detail: 'American, deep', sid: 17 },
  { id: 'bf_emma', label: 'Emma', langs: ['en'], detail: 'British', sid: 21 },
  { id: 'bm_george', label: 'George', langs: ['en'], detail: 'British', sid: 26 },
  { id: 'ef_dora', label: 'Dora', langs: ['es'], detail: 'Spanish', sid: 28 },
  { id: 'em_alex', label: 'Alex', langs: ['es'], detail: 'Spanish', sid: 29 },
  { id: 'em_santa', label: 'Santa', langs: ['es'], detail: 'Spanish', sid: 53 },
];

/** The longest text one generation takes. */
export const MAX_VOICE_TEXT = 5000;

export const modelsDir = (): string => process.env.FRAME_STUDIO_MODELS ?? join(homedir(), '.frame-studio/models');

/** Fetches one archive to `path` and checks it against its pin. */
async function download(archive: KokoroArchive, path: string, progress: (bytes: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(archive.url, { ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) throw new Error(`Downloading ${archive.url} answered ${res.status}.`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    progress(chunk.length);
  });
  await pipeline(body, createWriteStream(path));
  if (hash.digest('hex') !== archive.sha256) throw new Error(`${archive.url} doesn't match its pinned checksum, so nothing was unpacked.`);
}

function unpack(archive: string, into: string): Promise<void> {
  return new Promise((done, fail) => {
    execFile('tar', ['-xf', archive, '-C', into, '--strip-components=1'], { timeout: 600_000 }, (err) => (err ? fail(new Error(`Could not unpack ${archive}: ${err.message}`)) : done()));
  });
}

/** A quiet tone for tests: FRAME_STUDIO_FAKE_KOKORO=1 skips the download and the model. */
function fakeWav(text: string): Uint8Array {
  const rate = 24000;
  const samples = Math.round(rate * Math.min(5, 0.5 + text.length / 40));
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 3000), 44 + i * 2);
  return out;
}

export class Kokoro {
  private readonly manifest: KokoroManifest | null;
  private readonly home: () => string;
  private installing: Promise<void> | null = null;
  private done = 0;
  private failure: string | null = null;
  private fakeReady = false;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(manifest: KokoroManifest | null = kokoroManifest(), home: () => string = modelsDir) {
    this.manifest = manifest;
    this.home = home;
  }

  private get fake(): boolean {
    return process.env.FRAME_STUDIO_FAKE_KOKORO === '1';
  }

  private get dir(): string | null {
    return this.manifest ? join(this.home(), this.manifest.version) : null;
  }

  private get total(): number {
    return (this.manifest?.archives ?? []).reduce((sum, a) => sum + a.bytes, 0);
  }

  private installed(): boolean {
    if (this.fake) return this.fakeReady;
    return this.dir !== null && existsSync(join(this.dir, 'installed.json'));
  }

  status(): KokoroStatus {
    const voices = KOKORO_VOICES.map(({ id, label, langs, detail }) => ({ id, label, langs, detail }));
    const base = { voices, bytes: this.total };
    if (!this.manifest) return { ...base, state: 'unsupported' };
    if (this.installed()) return { ...base, state: 'ready' };
    if (this.installing) return { ...base, state: 'installing', done: this.done };
    return { ...base, state: 'missing', ...(this.failure ? { error: this.failure } : {}) };
  }

  /** Downloads and unpacks into a fresh folder, then renames it into place, so two studio servers can't half-install. */
  install(onProgress: (done: number, total: number) => void = () => {}): Promise<void> {
    if (this.installing) return this.installing;
    if (this.installed()) return Promise.resolve();
    if (!this.manifest || !this.dir) return Promise.reject(new Error('Kokoro has no build for this computer.'));
    this.done = 0;
    this.failure = null;
    const run = this.installNow(this.manifest, this.dir, onProgress)
      .catch((err: unknown) => {
        this.failure = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        this.installing = null;
      });
    this.installing = run;
    return run;
  }

  private async installNow(manifest: KokoroManifest, dir: string, onProgress: (done: number, total: number) => void): Promise<void> {
    if (this.fake) {
      for (let done = 0; done <= 4; done++) {
        this.done = (this.total * done) / 4;
        onProgress(this.done, this.total);
        await new Promise((tick) => setTimeout(tick, 20));
      }
      this.fakeReady = true;
      return;
    }
    const stage = join(this.home(), `.partial-${randomBytes(6).toString('hex')}`);
    await mkdir(stage, { recursive: true });
    try {
      for (const [i, archive] of manifest.archives.entries()) {
        const file = join(stage, `archive-${i}`);
        await download(archive, file, (bytes) => {
          this.done += bytes;
          onProgress(this.done, this.total);
        });
        const into = join(stage, archive.into);
        await mkdir(into, { recursive: true });
        await unpack(file, into);
        await rm(file, { force: true });
      }
      await writeFile(join(stage, 'installed.json'), `${JSON.stringify({ version: manifest.version, sha256: manifest.archives.map((a) => a.sha256) }, null, 2)}\n`);
      await rename(stage, dir).catch(async (err: unknown) => {
        // Another server finished first; its copy is the same bytes.
        if (!existsSync(join(dir, 'installed.json'))) throw err;
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /** Speaks `text`, one job at a time, and returns the WAV's bytes. */
  speak(text: string, lang: string, voice?: string): Promise<Uint8Array> {
    const chosen = voice === undefined ? KOKORO_VOICES.find((v) => v.langs.includes(lang)) : KOKORO_VOICES.find((v) => v.id === voice);
    if (!chosen) throw new Error(voice === undefined ? `Kokoro has no voice for "${lang}"; it speaks English (en) and Spanish (es) here.` : `Kokoro has no voice "${voice}". Voices: ${KOKORO_VOICES.map((v) => v.id).join(', ')}.`);
    if (!chosen.langs.includes(lang)) throw new Error(`Kokoro's ${chosen.id} doesn't speak "${lang}". For it, use ${KOKORO_VOICES.filter((v) => v.langs.includes(lang)).map((v) => v.id).join(', ') || 'no voice here'}.`);
    if (text.trim() === '') throw new Error('There is no text to speak.');
    if (text.length > MAX_VOICE_TEXT) throw new Error(`That's ${text.length} characters; one generation takes ${MAX_VOICE_TEXT}.`);
    if (!this.installed()) throw new Error('Kokoro isn\'t downloaded yet. It offers itself in the Generate Voice sheet, in the viewer, with its size and licences; the user starts it there.');
    const run = this.turn.then(() => this.speakNow(text, lang, chosen));
    this.turn = run.catch(() => {});
    return run;
  }

  private async speakNow(text: string, lang: string, voice: KokoroVoice): Promise<Uint8Array> {
    if (this.fake) return fakeWav(text);
    const dir = this.dir!;
    const out = join(this.home(), `.speech-${randomBytes(6).toString('hex')}.wav`);
    const runtime = join(dir, 'runtime');
    const addon = this.manifest!.archives[1].into;
    const libraries = join(dir, addon);
    const env = agentEnv({
      DYLD_LIBRARY_PATH: libraries,
      LD_LIBRARY_PATH: libraries,
      // The app's Node is Electron; this makes it plain Node for the child.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    });
    try {
      await new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, [join(import.meta.dirname, 'kokoro-child.cjs')], { env, stdio: ['pipe', 'ignore', 'pipe'], timeout: 600_000 });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-2000);
        });
        child.on('error', fail);
        child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`Kokoro stopped (exit ${code}): ${/^\w*Error: .*$/m.exec(stderr)?.[0] ?? stderr.trim().split('\n').pop() ?? ''}`))));
        child.stdin.end(JSON.stringify({ runtime, model: join(dir, 'model'), lang, lexicon: lang === 'en' ? (voice.id.startsWith('b') ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt') : null, sid: voice.sid, text, out }));
      });
      const info = await stat(out);
      if (info.size <= 44) throw new Error('Kokoro made no sound.');
      return await readFile(out);
    } finally {
      await rm(out, { force: true });
    }
  }
}

/** This process's Kokoro: the viewer's routes and the MCP tool share it, and so its one-at-a-time queue. */
export const kokoro = new Kokoro();
