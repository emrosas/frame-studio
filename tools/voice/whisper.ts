// whisper.cpp behind the timing job (ADR 0016): where its binary and model live,
// fetching the model on first use, and running it. The model is sha256-pinned
// and stays on this machine, so timing works offline after the first run. Node only.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, constants, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { readWhisperJson, type HeardWord } from './words.ts';

export const WHISPER_VERSION = '1.9.5';
/** The source archive of that version, as GitHub serves it. */
export const WHISPER_SOURCE = {
  url: `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_VERSION}.tar.gz`,
  sha256: 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720',
};
/** The model: small, q5 quantized. Enough for word timing in English and Spanish, and light enough to download. */
export const WHISPER_MODEL = {
  name: 'small q5',
  file: 'ggml-small-q5_1.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  bytes: 190085487,
};

/** ~/.frame-studio. FRAME_STUDIO_HOME stands in for the home folder, as it does for the app. */
export const studioHome = (): string => join(process.env.FRAME_STUDIO_HOME ?? homedir(), '.frame-studio');
export const modelPath = (): string => join(studioHome(), 'models', WHISPER_MODEL.file);
/** Where npm run voice:setup leaves the binary for a run from the repo. */
export const devBinary = (): string => join(studioHome(), 'bin', `whisper-${WHISPER_VERSION}`, 'whisper-cli');

const exists = (path: string) =>
  access(path, constants.R_OK).then(
    () => true,
    () => false,
  );

/** whisper-cli: FRAME_STUDIO_WHISPER, the one the app ships beside its built-ins, or voice:setup's. Null if there's none. */
export async function findWhisper(builtins: string): Promise<string | null> {
  for (const path of [process.env.FRAME_STUDIO_WHISPER, join(builtins, '..', 'bin', 'whisper-cli'), devBinary()]) {
    if (path && (await exists(path))) return path;
  }
  return null;
}

export const modelReady = (): Promise<boolean> => exists(modelPath());

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Downloads `url` to `path` through a .part file, checks it, and only then puts it in place. */
export async function download(url: string, path: string, expected: { sha256: string; bytes: number }, options: { signal?: AbortSignal; onProgress?(done: number, total: number): void } = {}): Promise<void> {
  const part = `${path}.part`;
  const res = await fetch(url, { redirect: 'follow', signal: options.signal });
  if (!res.ok || !res.body) throw new Error(`Downloading ${url} answered ${res.status}.`);
  const total = Number(res.headers.get('content-length')) || expected.bytes;
  let done = 0;
  const hash = createHash('sha256');
  const counted = Readable.fromWeb(res.body as ReadableStream<Uint8Array>).map((chunk: Uint8Array) => {
    done += chunk.length;
    hash.update(chunk);
    options.onProgress?.(done, total);
    return chunk;
  });
  await mkdir(join(path, '..'), { recursive: true });
  try {
    await pipeline(counted, createWriteStream(part), { signal: options.signal });
    const got = hash.digest('hex');
    if (got !== expected.sha256) throw new Error(`The download of ${url} doesn't match its pinned sha256: got ${got}.`);
    await rename(part, path);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

let fetching: Promise<void> | null = null;

/** Gets the model if it isn't here yet. Two jobs at once share one download. */
export async function ensureModel(options: { signal?: AbortSignal; onProgress?(done: number, total: number): void } = {}): Promise<void> {
  if (await modelReady()) return;
  fetching ??= download(WHISPER_MODEL.url, modelPath(), WHISPER_MODEL, options).finally(() => {
    fetching = null;
  });
  await fetching;
}

export interface Transcript {
  language: string | null;
  words: HeardWord[];
}

/**
 * Runs whisper-cli on a 16 kHz mono WAV. -dtw gives each token its end, and needs flash attention off.
 * `language` is a code, or null to let it detect one.
 */
export async function transcribe(binary: string, wav: string, language: string | null, options: { signal?: AbortSignal; onProgress?(percent: number): void } = {}): Promise<Transcript> {
  const dir = await mkdtemp(join(tmpdir(), 'frame-studio-whisper-'));
  try {
    const out = join(dir, 'words');
    await chmod(binary, 0o755).catch(() => {});
    const args = ['-m', modelPath(), '-f', wav, '-l', language ?? 'auto', '-dtw', 'small', '-nfa', '-ojf', '-of', out, '-np', '-pp'];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], signal: options.signal });
      let tail = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => {
        tail = (tail + text).slice(-2000);
        for (const m of text.matchAll(/progress =\s*(\d+)%/g)) options.onProgress?.(Number(m[1]));
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper-cli stopped with code ${code}: ${tail.trim().split('\n').slice(-3).join(' ')}`))));
    });
    return readWhisperJson(await readFile(`${out}.json`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
