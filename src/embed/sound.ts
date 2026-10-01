// Sound for the single-file embed. Only embeds of scenes with audio import
// this, so silent embeds carry no audio code. The scene's audio renders once
// when the embed loads; it plays through LivePlayback, the same player the
// viewer uses, once the person turns sound on (browsers allow sound only
// after a click or key press). An export asked to carry its sound files
// (ADR 0012) passes them here as base64, decoded before the render.

import { LivePlayback, type Playhead } from '../audio/live';
import { decodeMedia } from '../audio/media';
import { renderSceneAudio } from '../audio/render';
import type { AudioGenerator } from '../audio/types';
import type { Scene, World } from '../engine/types';

export interface EmbedSoundState {
  /** False until the scene's audio has rendered. */
  ready: boolean;
  muted: boolean;
  /** False until the browser lets the embed play sound. */
  unlocked: boolean;
  /** Scene time reaching the speakers, in seconds, or null while silent. */
  heard: number | null;
  /** Why the audio could not render, if it could not. */
  error?: string;
}

export interface EmbedSound {
  readonly state: EmbedSoundState;
  /** Keeps the sound on the playhead. The player calls it whenever play state or the frame changes. */
  update(head: Playhead): void;
  /** Sound on or off. Turning it on from a click or key handler also unlocks it. */
  setMuted(muted: boolean): Promise<void>;
}

/** What the generated embed entry passes to mountEmbed for a scene with audio. `world` holds the scenes it places. */
export type EmbedSoundFactory = (scene: Scene, onChange: () => void, world?: World) => EmbedSound;

/** A base64 string's bytes. */
function bytesOf(base64: string): ArrayBuffer {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

/** `media`: the sound files the export carries, as base64 by their path in the scene. */
export function embedSound(generators: readonly AudioGenerator[], media: Readonly<Record<string, string>> = {}): EmbedSoundFactory {
  return (scene, onChange, world = {}) => {
    const live = new LivePlayback(() => new AudioContext({ latencyHint: 'interactive' }));
    live.setMuted(true); // until the person turns it on
    let ready = false;
    let error: string | undefined;
    Promise.all(Object.entries(media).map(async ([file, base64]) => [file, await decodeMedia(bytesOf(base64))] as const))
      .then((decoded) => renderSceneAudio(scene, new Map(generators.map((g) => [g.id, g])), world, new Map(decoded)))
      .then(
      (buffer) => {
        live.setBuffer(buffer);
        ready = true;
        onChange();
      },
      (err: unknown) => {
        error = `The sound could not render: ${err instanceof Error ? err.message : String(err)}`;
        onChange();
      },
    );
    return {
      get state() {
        return { ready, muted: live.isMuted, unlocked: live.unlocked, heard: live.heardSeconds, ...(error ? { error } : {}) };
      },
      update: (head) => live.update(head),
      async setMuted(muted) {
        live.setMuted(muted);
        if (!muted) await live.unlock().catch(() => {});
        onChange();
      },
    };
  };
}
