// Sound files (ADR 0012): recorded voiceover and music, mixed into a scene's
// one audio buffer like any cue. The hosts (the viewer, the render worker and
// the HTML player) fetch or unpack the files a scene plays, decode them here
// at the studio's 48 kHz, and pass them to renderSceneAudio by path. Decoding
// gives the same samples every time on one browser build.

import { MAX_SCENE_DEPTH } from '../engine/scene-layer';
import type { AudioCue, Scene, World } from '../engine/types';
import { SAMPLE_RATE } from './timing';

/** Decoded sound files by their path in the scene, e.g. "media/voice.mp3", at 48 kHz. */
export type MediaBuffers = ReadonlyMap<string, AudioBuffer>;

/** True for a cue that plays a sound file rather than a generator. */
export function isFileCue(cue: AudioCue): cue is AudioCue & { file: string } {
  return typeof cue.file === 'string';
}

/** Decodes a sound file's bytes (MP3, WAV, M4A, FLAC, Ogg… whatever Chromium reads), resampled to 48 kHz. */
export function decodeMedia(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: SAMPLE_RATE });
  return ctx.decodeAudioData(bytes);
}

/** Every sound file the scene plays, its placed scenes' included, sorted. */
export function mediaUsed(scene: Pick<Scene, 'audio'> & Partial<Pick<Scene, 'layers'>>, world: World = {}, depth = 0): string[] {
  const files = new Set((scene.audio ?? []).filter(isFileCue).map((cue) => cue.file));
  if (depth < MAX_SCENE_DEPTH) {
    for (const layer of scene.layers ?? []) {
      const shot = layer.scene !== undefined ? world.scenes?.get(layer.scene) : undefined;
      if (shot) for (const file of mediaUsed(shot, world, depth + 1)) files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * The samples a file cue plays, `length` long: the file from `in` seconds, silence after it ends, with linear
 * fades in and out. Pure array work, so it is exact and the same every time.
 */
export function cutFile(buffer: AudioBuffer, cue: Pick<AudioCue, 'in' | 'fadeIn' | 'fadeOut'>, length: number): Float32Array[] {
  const from = Math.max(0, Math.round((cue.in ?? 0) * SAMPLE_RATE));
  const fadeIn = Math.min(length, Math.round((cue.fadeIn ?? 0) * SAMPLE_RATE));
  const fadeOut = Math.min(length, Math.round((cue.fadeOut ?? 0) * SAMPLE_RATE));
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const samples = new Float32Array(length);
    samples.set(buffer.getChannelData(c).subarray(from, from + length));
    for (let i = 0; i < fadeIn; i++) samples[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) samples[length - 1 - i] *= i / fadeOut;
    out.push(samples);
  }
  return out;
}
