// The timing job (ADR 0016): a sound cue goes in, its words come out. The render
// worker decodes the file to 16 kHz mono, since no shipped build has ffmpeg;
// whisper-cli hears it; a known script supplies the words. What Whisper said is
// kept as media/<file>.words.json, keyed by the file's sha256, so a second run
// needs no model. That's a cache: the words a scene uses live in the scene.
// Node only.

import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../scene-files.ts';
import { REPO } from '../studio/folder.ts';
import { ensureModel, fileSha256, findWhisper, modelReady, transcribe, WHISPER_MODEL, WHISPER_VERSION, type Transcript } from './whisper.ts';
import { alignScript, carryWordIds, type HeardWord } from './words.ts';
import type { SpokenWord } from '../../src/engine/types.ts';
import type { VoiceStatus } from '../../src/studio/protocol.ts';

export type VoiceStage = 'download' | 'decode' | 'listen' | 'write';

export interface VoiceProgress {
  stage: VoiceStage;
  /** Bytes for the download, percent for listening. */
  done: number;
  total: number;
}

export async function voiceStatus(builtins: string): Promise<VoiceStatus> {
  return { binary: (await findWhisper(builtins)) !== null, model: await modelReady(), modelBytes: WHISPER_MODEL.bytes, modelName: WHISPER_MODEL.name };
}

interface CacheFile {
  sha256: string;
  model: string;
  /** The language asked for, or null when it was detected. */
  asked: string | null;
  language: string | null;
  words: HeardWord[];
}

export const cachePath = (root: string, file: string): string => join(root, `${file}.words.json`);

/** What to do about a missing whisper-cli. The app ships its own, so there a missing one means a damaged app. */
export function missingWhisper(builtins: string): string {
  return resolve(builtins) === resolve(REPO, 'src')
    ? `whisper-cli ${WHISPER_VERSION} isn't installed. Run npm run voice:setup.`
    : "The app's speech timing tool is missing, so Frame Studio is damaged. Reinstall the app.";
}

export interface HearOptions {
  root: string;
  builtins: string;
  file: string;
  language: string | null;
  /** Writes the file as 16 kHz mono WAV at `path`. The render worker does it. */
  decode(path: string): Promise<void>;
  signal?: AbortSignal;
  onProgress?(progress: VoiceProgress): void;
}

/** What Whisper hears in a sound file: from the cache when the file hasn't changed, else from whisper-cli. */
export async function hear(options: HearOptions): Promise<Transcript> {
  const { root, file, language, signal, onProgress } = options;
  const path = join(root, file);
  const sha256 = await fileSha256(path);
  const cache = cachePath(root, file);
  const cached = await readFile(cache, 'utf8').then(
    (text) => JSON.parse(text) as CacheFile,
    () => null,
  );
  if (cached?.sha256 === sha256 && cached.model === WHISPER_MODEL.file && (cached.asked === language || cached.language === language)) {
    return { language: cached.language, words: cached.words };
  }
  const binary = await findWhisper(options.builtins);
  if (!binary) throw new Error(missingWhisper(options.builtins));
  await ensureModel({ signal, onProgress: (done, total) => onProgress?.({ stage: 'download', done, total }) });
  onProgress?.({ stage: 'decode', done: 0, total: 1 });
  const wav = join(tmpdir(), `frame-studio-voice-${process.pid}-${sha256.slice(0, 12)}.wav`);
  try {
    await options.decode(wav);
    onProgress?.({ stage: 'listen', done: 0, total: 100 });
    const heard = await transcribe(binary, wav, language, { signal, onProgress: (percent) => onProgress?.({ stage: 'listen', done: percent, total: 100 }) });
    const entry: CacheFile = { sha256, model: WHISPER_MODEL.file, asked: language, ...heard };
    await writeFileAtomic(cache, `${JSON.stringify(entry)}\n`);
    return heard;
  } finally {
    await rm(wav, { force: true });
  }
}

/** A cue's next words: the script's if there is one, Whisper's if not, keeping the ids of words the last take shared. */
export function nextWords(heard: readonly HeardWord[], script: string | undefined, old: readonly SpokenWord[]): SpokenWord[] {
  return carryWordIds(old, script?.trim() ? alignScript(script, heard) : [...heard]);
}
