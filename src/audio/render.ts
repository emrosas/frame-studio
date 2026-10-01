import { cueVolume } from '../engine/cue';
import { createRng } from '../engine/rng';
import { MAX_SCENE_DEPTH, sceneLayerSpan, scenePlacement } from '../engine/scene-layer';
import { timeToFrame } from '../engine/time';
import type { AudioCue, Layer, Scene, World } from '../engine/types';
import { readParams } from '../rigs/parts/params';
import { cutFile, isFileCue, type MediaBuffers } from './media';
import { mix } from './mix';
import { cueTimes, paramTime, SAMPLE_RATE, samplesPerFrame, sceneSamples, sourceTime } from './timing';
import type { AudioGenerator, GeneratorRegistry } from './types';

export const AUDIO_CHANNELS = 2;

type AudioScene = Pick<Scene, 'audio'> & Partial<Pick<Scene, 'layers'>>;

/** The scenes its scene layers place, found in `world`. */
function placedShots(scene: AudioScene, world: World): { layer: Layer; shot: Scene }[] {
  return (scene.layers ?? []).flatMap((layer) => {
    const shot = layer.scene !== undefined ? world.scenes?.get(layer.scene) : undefined;
    return shot ? [{ layer, shot }] : [];
  });
}

/** True when the scene has cues of its own, or places a shot that has sound (ADR 0007). */
export function hasAudio(scene: AudioScene, world: World = {}, depth = 0): boolean {
  if ((scene.audio?.length ?? 0) > 0) return true;
  return depth < MAX_SCENE_DEPTH && placedShots(scene, world).some(({ shot }) => hasAudio(shot, world, depth + 1));
}

/**
 * Makes `param` follow value(frame) over frames [from, to): set on the first
 * frame, then ramped linearly from one frame start to the next wherever it
 * changes. A value that never changes is one event.
 */
function automate(param: AudioParam, from: number, to: number, fps: number, value: (frame: number) => number): void {
  const spf = samplesPerFrame(fps);
  let prev = value(from);
  param.setValueAtTime(prev, paramTime(from * spf));
  let next = from + 1 < to ? value(from + 1) : prev;
  for (let f = from + 1; f < to; f++) {
    const v = next;
    next = f + 1 < to ? value(f + 1) : v;
    // A point where the value arrives or leaves; points in a steady stretch add nothing.
    if (v !== prev || next !== v) param.linearRampToValueAtTime(v, paramTime(f * spf));
    prev = v;
  }
}

function cueOut(ctx: BaseAudioContext, scene: Pick<Scene, 'fps' | 'seed'>, cue: AudioCue, generators: GeneratorRegistry, media: MediaBuffers): AudioNode | null {
  if (isFileCue(cue)) return fileOut(ctx, scene, cue, media);
  const generator = generators.get(cue.generator ?? '');
  if (!generator) throw new Error(`audio cue "${cue.id}" uses unknown generator "${cue.generator}"`);
  const out = new GainNode(ctx, { gain: 1 });
  const params = readParams(generator.params, cue.params ?? {});
  const times = cueTimes(cue, scene.fps);
  generator.schedule(ctx, out, times, params, createRng(scene.seed, `audio:${cue.id}`));
  if (cue.tracks?.length) {
    const first = timeToFrame(cue.start, scene.fps);
    automate(out.gain, first, first + (times.endSample - times.startSample) / samplesPerFrame(scene.fps), scene.fps, (f) => cueVolume(cue, scene.fps, f));
  }
  return out;
}

/**
 * A sound file's cue (ADR 0012): the file's samples from `in`, cut to the cue's frames and faded, through a
 * gain that follows its volume keys. Null when the host has no such file, which plays as silence; the viewer
 * reports the missing file.
 */
function fileOut(ctx: BaseAudioContext, scene: Pick<Scene, 'fps'>, cue: AudioCue & { file: string }, media: MediaBuffers): AudioNode | null {
  const buffer = media.get(cue.file);
  if (!buffer) return null;
  if (buffer.sampleRate !== SAMPLE_RATE) throw new Error(`sound file "${cue.file}" was decoded at ${buffer.sampleRate} Hz, not ${SAMPLE_RATE}`);
  const times = cueTimes(cue, scene.fps);
  const length = times.endSample - times.startSample;
  const channels = cutFile(buffer, cue, length);
  const clip = ctx.createBuffer(channels.length, length, SAMPLE_RATE);
  channels.forEach((samples, c) => clip.getChannelData(c).set(samples));
  const source = new AudioBufferSourceNode(ctx, { buffer: clip });
  const gain = new GainNode(ctx, { gain: 1 });
  source.connect(gain);
  if (cue.tracks?.length) {
    const first = timeToFrame(cue.start, scene.fps);
    automate(gain.gain, first, first + length / samplesPerFrame(scene.fps), scene.fps, (f) => cueVolume(cue, scene.fps, f));
  }
  source.start(times.start);
  return gain;
}

/**
 * A scene layer's sound: its shot's rendered audio, cut to the trim, starting
 * where the layer starts, through a gain that follows its volume and mute.
 * Null when it plays nothing. The cut is copied sample for sample, so the shot
 * sounds exactly as it does alone.
 */
function shotOut(ctx: BaseAudioContext, scene: Scene, layer: Layer, shot: Scene, buffer: AudioBuffer): AudioNode | null {
  const span = sceneLayerSpan(layer, scene, shot);
  if (span.to <= span.from) return null;
  const volume = (f: number) => {
    const p = scenePlacement(layer, scene, f);
    return p.mute ? 0 : p.volume;
  };
  let audible = false;
  for (let f = span.from; f < span.to && !audible; f++) audible = volume(f) > 0;
  if (!audible) return null;
  const spf = samplesPerFrame(scene.fps);
  const length = (span.to - span.from) * spf;
  const clip = ctx.createBuffer(buffer.numberOfChannels, length, SAMPLE_RATE);
  for (let c = 0; c < buffer.numberOfChannels; c++) clip.getChannelData(c).set(buffer.getChannelData(c).subarray(span.in * spf, span.in * spf + length));
  const source = new AudioBufferSourceNode(ctx, { buffer: clip });
  const gain = new GainNode(ctx, { gain: 1 });
  source.connect(gain);
  automate(gain.gain, span.from, span.to, scene.fps, volume);
  source.start(sourceTime(span.from * spf));
  return gain;
}

/** A placed scene's sound, rendered: what a scene layer plays. */
export interface ShotAudio {
  scene: Scene;
  buffer: AudioBuffer;
}

/**
 * Schedules every cue of the scene into `dest`, then its scene layers' sound
 * from `shots` (each placed scene's rendered audio, by scene id). Each cue
 * gets its own gain as `out`, and everything is summed with mix(), cues first
 * and then layers, in scene order. A cue's rng is seeded from the scene seed
 * and "audio:<cue id>".
 */
export function scheduleScene(
  ctx: BaseAudioContext,
  scene: Scene,
  generators: GeneratorRegistry,
  dest: AudioNode,
  shots: ReadonlyMap<string, ShotAudio> = new Map(),
  media: MediaBuffers = new Map(),
): void {
  const outs = (scene.audio ?? []).flatMap((cue) => cueOut(ctx, scene, cue, generators, media) ?? []);
  for (const layer of scene.layers) {
    const shot = layer.scene !== undefined ? shots.get(layer.scene) : undefined;
    const out = shot ? shotOut(ctx, scene, layer, shot.scene, shot.buffer) : null;
    if (out) outs.push(out);
  }
  mix(ctx, outs, dest);
}

/**
 * The whole scene's audio: 48 kHz stereo, exactly as long as its frames.
 * The viewer, the embed and every export play or encode this one buffer,
 * slicing it for a range. Placed scenes with sound render first, each once,
 * and their buffers are cut into this one. Async, so a generator that throws
 * while scheduling rejects the promise instead of throwing at the caller.
 */
export function renderSceneAudio(scene: Scene, generators: GeneratorRegistry, world: World = {}, media: MediaBuffers = new Map()): Promise<AudioBuffer> {
  return renderAt(scene, generators, world, media, 0, new Map());
}

async function renderAt(
  scene: Scene,
  generators: GeneratorRegistry,
  world: World,
  media: MediaBuffers,
  depth: number,
  rendered: Map<string, Promise<AudioBuffer>>,
): Promise<AudioBuffer> {
  const shots = new Map<string, ShotAudio>();
  for (const { layer, shot } of placedShots(scene, world)) {
    if (shots.has(layer.scene!) || !hasAudio(shot, world)) continue;
    if (depth >= MAX_SCENE_DEPTH) throw new Error(`scene "${scene.id}" places scenes more than ${MAX_SCENE_DEPTH} deep`);
    let buffer = rendered.get(layer.scene!);
    if (!buffer) rendered.set(layer.scene!, (buffer = renderAt(shot, generators, world, media, depth + 1, rendered)));
    shots.set(layer.scene!, { scene: shot, buffer: await buffer });
  }
  const ctx = new OfflineAudioContext({ numberOfChannels: AUDIO_CHANNELS, length: sceneSamples(scene), sampleRate: SAMPLE_RATE });
  scheduleScene(ctx, scene, generators, ctx.destination, shots, media);
  return ctx.startRendering();
}

/** What the rendered audio depends on besides generator code, for caching a render: placed scenes' sound included. */
export function audioKey(scene: Scene, world: World = {}, depth = 0): string {
  const shots = depth < MAX_SCENE_DEPTH ? placedShots(scene, world).filter(({ shot }) => hasAudio(shot, world)) : [];
  return JSON.stringify([
    scene.seed,
    scene.fps,
    scene.duration,
    scene.audio ?? [],
    shots.map(({ layer, shot }) => [layer, audioKey(shot, world, depth + 1)]),
  ]);
}

/**
 * The generators a scene's cues use, and its placed scenes' cues, in order, for
 * caching a render. A generator module that hot-reloads is a new object, so
 * comparing these with sameGenerators tells a generator edit from any other
 * library reload.
 */
export function generatorsUsed(scene: AudioScene, generators: GeneratorRegistry, world: World = {}, depth = 0): (AudioGenerator | undefined)[] {
  const own = (scene.audio ?? []).filter((cue) => !isFileCue(cue)).map((cue) => generators.get(cue.generator ?? ''));
  if (depth >= MAX_SCENE_DEPTH) return own;
  return [...own, ...placedShots(scene, world).flatMap(({ shot }) => generatorsUsed(shot, generators, world, depth + 1))];
}

/** Ids of the generators the scene's sound needs, its placed scenes' included, sorted: what an embed bundles. */
export function generatorIdsUsed(scene: AudioScene, world: World = {}, depth = 0): string[] {
  const ids = new Set((scene.audio ?? []).flatMap((cue) => (isFileCue(cue) || cue.generator === undefined ? [] : [cue.generator])));
  if (depth < MAX_SCENE_DEPTH) for (const { shot } of placedShots(scene, world)) for (const id of generatorIdsUsed(shot, world, depth + 1)) ids.add(id);
  return [...ids].sort();
}

export function sameGenerators(a: readonly (AudioGenerator | undefined)[], b: readonly (AudioGenerator | undefined)[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}
