/**
 * Procedural audio. A generator is code plus a param schema, like a rig, and
 * a scene's audio cues name one each. The same scene always renders the same
 * samples on one browser build (ticket 04).
 */
import { blip } from './blip';
import { buzz } from './buzz';
import { pad } from './pad';
import type { AudioGenerator, GeneratorRegistry } from './types';

export * from './types';
export { SAMPLE_RATE, samplesPerFrame, sceneSamples, sourceTime, paramTime, cueTimes, frameSample, type CueTimes } from './timing';
export { mix } from './mix';
export { envelopeGain, noiseBuffer, toSamples, wanderCurve } from './parts';
export { AUDIO_CHANNELS, audioKey, generatorIdsUsed, generatorsUsed, hasAudio, renderSceneAudio, sameGenerators, scheduleScene, type ShotAudio } from './render';
export { DRIFT_TOLERANCE, LivePlayback, wrapInto, wrappedDifference, type Playhead } from './live';
export { blip, buzz, pad };

/** Every generator the studio ships. Add new generators here. */
export const allGenerators: readonly AudioGenerator[] = [pad, buzz, blip];

export function createGeneratorRegistry(generators: readonly AudioGenerator[]): GeneratorRegistry {
  const map = new Map<string, AudioGenerator>();
  for (const generator of generators) {
    if (map.has(generator.id)) throw new Error(`duplicate generator id "${generator.id}"`);
    map.set(generator.id, generator);
  }
  return map;
}

export function createDefaultGenerators(): GeneratorRegistry {
  return createGeneratorRegistry(allGenerators);
}
