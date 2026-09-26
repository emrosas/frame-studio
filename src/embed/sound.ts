// Sound for the single-file embed. Only embeds of scenes with audio import
// this, so silent embeds carry no audio code. The scene's audio renders once
// when the embed loads; it plays through LivePlayback, the same player the
// viewer uses, once the person turns sound on (browsers allow sound only
// after a click or key press).

import { LivePlayback, type Playhead } from '../audio/live';
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

export function embedSound(generators: readonly AudioGenerator[]): EmbedSoundFactory {
  return (scene, onChange, world = {}) => {
    const live = new LivePlayback(() => new AudioContext({ latencyHint: 'interactive' }));
    live.setMuted(true); // until the person turns it on
    let ready = false;
    let error: string | undefined;
    renderSceneAudio(scene, new Map(generators.map((g) => [g.id, g])), world).then(
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
