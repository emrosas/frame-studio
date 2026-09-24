import { createRng } from '../engine/rng';
import type { Scene } from '../engine/types';
import { readParams } from '../rigs/parts/params';
import { mix } from './mix';
import { cueTimes, SAMPLE_RATE, sceneSamples } from './timing';
import type { AudioGenerator, GeneratorRegistry } from './types';

export const AUDIO_CHANNELS = 2;

export function hasAudio(scene: Pick<Scene, 'audio'>): boolean {
  return (scene.audio?.length ?? 0) > 0;
}

/**
 * Schedules every cue of the scene into `dest`. Each cue gets its own unity
 * gain as `out`, and those are summed with mix(), in scene order. A cue's rng
 * is seeded from the scene seed and "audio:<cue id>".
 */
export function scheduleScene(ctx: BaseAudioContext, scene: Scene, generators: GeneratorRegistry, dest: AudioNode): void {
  const outs = (scene.audio ?? []).map((cue) => {
    const generator = generators.get(cue.generator);
    if (!generator) throw new Error(`audio cue "${cue.id}" uses unknown generator "${cue.generator}"`);
    const out = new GainNode(ctx, { gain: 1 });
    const params = readParams(generator.params, cue.params ?? {});
    generator.schedule(ctx, out, cueTimes(cue, scene.fps), params, createRng(scene.seed, `audio:${cue.id}`));
    return out;
  });
  mix(ctx, outs, dest);
}

/**
 * The whole scene's audio: 48 kHz stereo, exactly as long as its frames.
 * The viewer, the embed and every export play or encode this one buffer,
 * slicing it for a range. Async, so a generator that throws while scheduling
 * rejects the promise instead of throwing at the caller.
 */
export async function renderSceneAudio(scene: Scene, generators: GeneratorRegistry): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({ numberOfChannels: AUDIO_CHANNELS, length: sceneSamples(scene), sampleRate: SAMPLE_RATE });
  scheduleScene(ctx, scene, generators, ctx.destination);
  return ctx.startRendering();
}

/** What the rendered audio depends on besides generator code, for caching a render. */
export function audioKey(scene: Scene): string {
  return JSON.stringify([scene.seed, scene.fps, scene.duration, scene.audio ?? []]);
}

/**
 * The generators a scene's cues use, in cue order, for caching a render. A
 * generator module that hot-reloads is a new object, so comparing these with
 * sameGenerators tells a generator edit from any other library reload.
 */
export function generatorsUsed(scene: Pick<Scene, 'audio'>, generators: GeneratorRegistry): (AudioGenerator | undefined)[] {
  return (scene.audio ?? []).map((cue) => generators.get(cue.generator));
}

export function sameGenerators(a: readonly (AudioGenerator | undefined)[], b: readonly (AudioGenerator | undefined)[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}
