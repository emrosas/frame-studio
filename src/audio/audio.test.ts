import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateScene } from '../engine/validate';
import type { AudioCue, Scene } from '../engine/types';
import { createDefaultRegistry } from '../rigs';
import { allGenerators, createDefaultGenerators, createGeneratorRegistry, type AudioGenerator } from './index';
import { mix } from './mix';
import { audioKey, generatorIdsUsed, generatorsUsed, hasAudio, scheduleScene } from './render';
import { installFakeAudio, reaches, type AutomationEvent, type FakeAudio, type FakeNode } from './testing/fake-audio';
import { cueTimes, frameSample, paramTime, SAMPLE_RATE, samplesPerFrame, sceneSamples, sourceTime } from './timing';
import { readParams } from '../rigs/parts/params';
import { createRng } from '../engine/rng';

describe('timing', () => {
  it('puts every frame on a whole sample at the fps rates audio allows', () => {
    for (const fps of [12, 24, 25, 30, 48, 60]) {
      expect(Number.isInteger(samplesPerFrame(fps)), `fps ${fps}`).toBe(true);
    }
  });

  it('makes the scene exactly as long as its frames', () => {
    expect(sceneSamples({ fps: 30, duration: 2 })).toBe(96000);
    // A partial last frame counts, as it does for video.
    expect(sceneSamples({ fps: 24, duration: 1.01 })).toBe(25 * 2000);
  });

  it('snaps a cue to the frames its start and end fall on', () => {
    expect(cueTimes({ start: 1.01, end: 2.99 }, 30)).toEqual({
      startSample: 30 * 1600,
      endSample: 89 * 1600,
      start: 1,
      end: (89 * 1600) / SAMPLE_RATE,
      fps: 30,
    });
  });

  it('gives a cue shorter than a frame one whole frame', () => {
    const t = cueTimes({ start: 1, end: 1.001 }, 24);
    expect(t.endSample - t.startSample).toBe(2000);
  });

  it('agrees with the engine on awkward times', () => {
    // 1.16 * 25 is 28.999999999999996 in floats; the engine calls it frame 29.
    expect(frameSample(1.16, 25)).toBe(29 * 1920);
  });

  it('times automation half a sample early and starts sources on the sample', () => {
    expect(sourceTime(48000)).toBe(1);
    expect(paramTime(48000)).toBeCloseTo((48000 - 0.5) / 48000, 12);
    expect(paramTime(0)).toBe(0);
  });
});

describe('with a fake audio graph', () => {
  let audio: FakeAudio;
  beforeEach(() => {
    audio = installFakeAudio();
  });
  afterEach(() => audio.restore());

  describe('mix', () => {
    it.each([1, 2, 3, 4, 5, 7, 8, 9, 16])('sums %i sources with no input over two connections', (count) => {
      const sources = Array.from({ length: count }, () => new GainNode(audio.ctx)) as unknown as FakeNode[];
      mix(audio.ctx, sources as unknown as AudioNode[], audio.destination as unknown as AudioNode);
      expect(audio.fanInProblems()).toEqual([]);
      for (const s of sources) expect(reaches(audio, s, audio.destination)).toBe(true);
    });

    it('does nothing for no sources', () => {
      mix(audio.ctx, [], audio.destination as unknown as AudioNode);
      expect(audio.connections).toEqual([]);
    });
  });

  function schedule(generator: AudioGenerator, cue: Partial<AudioCue> = {}, fps = 30, seed = 1) {
    const out = new GainNode(audio.ctx) as unknown as FakeNode;
    const times = cueTimes({ start: cue.start ?? 1, end: cue.end ?? 3 }, fps);
    generator.schedule(audio.ctx, out as unknown as AudioNode, times, readParams(generator.params, cue.params ?? {}), createRng(seed, 'audio:x'));
    return { out, times };
  }

  /** Every automation event, flattened with its param, for comparing two schedules. */
  function automation(): string[] {
    return audio.nodes.flatMap((n, i) =>
      Object.values(n.params).flatMap((p) => p.events.map((e) => `${i}.${p.name}:${e.method}(${show(e)})`)),
    );
  }
  function show(e: AutomationEvent): string {
    return `${e.value instanceof Float32Array ? [...e.value].join(',') : e.value},${e.time},${e.duration ?? ''}`;
  }

  describe.each(allGenerators.map((g) => [g.id, g] as const))('generator %s', (_id, generator) => {
    it('keeps every input to two connections or fewer', () => {
      schedule(generator);
      expect(audio.fanInProblems()).toEqual([]);
    });

    it('plays only inside its cue, and every source reaches the output', () => {
      const { out, times } = schedule(generator);
      for (const s of audio.sources()) {
        expect(s.startTime).toBe(times.start);
        expect(s.stopTime).toBe(times.end);
      }
      const audible = audio.sources().filter((s) => reaches(audio, s, out));
      expect(audible.length).toBeGreaterThan(0);
    });

    it('schedules automation in time order', () => {
      schedule(generator);
      for (const node of audio.nodes) {
        for (const param of Object.values(node.params)) {
          const times = param.events.map((e) => e.time);
          expect(times, `${node.kind}.${param.name}`).toEqual([...times].sort((a, b) => a - b));
        }
      }
    });

    it('declares a default inside min and max for every number param', () => {
      for (const [name, spec] of Object.entries(generator.params)) {
        if (spec.type !== 'number') continue;
        expect(spec.default, name).toBeGreaterThanOrEqual(spec.min ?? -Infinity);
        expect(spec.default, name).toBeLessThanOrEqual(spec.max ?? Infinity);
        expect(spec.description, name).toBeTruthy();
      }
    });

    it('schedules the same graph for the same seed', () => {
      schedule(generator, {}, 30, 7);
      const first = automation();
      audio.restore();
      audio = installFakeAudio();
      schedule(generator, {}, 30, 7);
      expect(automation()).toEqual(first);
    });
  });

  describe('blip', () => {
    const blip = allGenerators.find((g) => g.id === 'blip')!;
    const onsets = () =>
      audio.nodes
        .filter((n) => n.kind === 'GainNode')
        .flatMap((n) => n.params.gain.events)
        .filter((e) => e.method === 'setValueAtTime')
        .map((e) => Math.ceil(e.time * SAMPLE_RATE)); // paramTime(n) is n - 0.5 samples, or 0

    it('starts each blip on a frame boundary', () => {
      schedule(blip, { start: 1, end: 3, params: { every: 0.5 } }, 30);
      expect(onsets()).toEqual([1, 1.5, 2, 2.5].map((t) => t * 48000));
    });

    it('snaps repeats that fall between frames onto their frame', () => {
      schedule(blip, { start: 0, end: 1, params: { every: 0.3 } }, 24);
      expect(onsets()).toEqual([0, 0.3, 0.6, 0.9].map((t) => Math.floor(t * 24 + 1e-9) * 2000));
    });

    it('never repeats faster than once a frame', () => {
      schedule(blip, { start: 0, end: 0.5, params: { every: 0.001 } }, 12);
      expect(onsets()).toEqual([0, 1, 2, 3, 4, 5].map((f) => f * 4000));
    });

    it('plays once when every is 0', () => {
      schedule(blip, { start: 2, end: 4 }, 25);
      expect(onsets()).toEqual([96000]);
    });
  });

  describe('buzz', () => {
    it('wanders differently for different seeds', () => {
      const buzz = allGenerators.find((g) => g.id === 'buzz')!;
      schedule(buzz, {}, 30, 1);
      const a = automation();
      audio.restore();
      audio = installFakeAudio();
      schedule(buzz, {}, 30, 2);
      expect(automation()).not.toEqual(a);
    });
  });

  describe('scheduleScene', () => {
    const scene = (audioCues: AudioCue[]): Scene => ({
      id: 's',
      fps: 30,
      duration: 4,
      size: [100, 100],
      seed: 3,
      layers: [],
      audio: audioCues,
    });

    it('mixes every cue into the destination, two connections at most per input', () => {
      const cues = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, generator: 'blip', start: i * 0.5, end: i * 0.5 + 0.5 }));
      scheduleScene(audio.ctx, scene(cues), createDefaultGenerators(), audio.destination as unknown as AudioNode);
      expect(audio.fanInProblems()).toEqual([]);
      for (const s of audio.sources()) expect(reaches(audio, s, audio.destination)).toBe(true);
      expect(audio.sources()).toHaveLength(5);
    });

    it('seeds each cue from the scene seed and its own id', () => {
      const seen: string[] = [];
      const probe: AudioGenerator = {
        id: 'probe',
        params: {},
        schedule: (_ctx, _out, _times, _p, rng) => void seen.push(rng.next().toFixed(12)),
      };
      const s = scene([
        { id: 'one', generator: 'probe', start: 0, end: 1 },
        { id: 'two', generator: 'probe', start: 0, end: 1 },
      ]);
      scheduleScene(audio.ctx, s, createGeneratorRegistry([probe]), audio.destination as unknown as AudioNode);
      expect(seen).toEqual([createRng(3, 'audio:one').next().toFixed(12), createRng(3, 'audio:two').next().toFixed(12)]);
    });

    it('names the cue when its generator is missing', () => {
      expect(() =>
        scheduleScene(audio.ctx, scene([{ id: 'x', generator: 'nope', start: 0, end: 1 }]), createDefaultGenerators(), audio.destination as unknown as AudioNode),
      ).toThrow(/audio cue "x" uses unknown generator "nope"/);
    });

    /** Gain automation as [method, value, sample], the sample being the one paramTime aims at (it clamps at 0). */
    const gainEvents = (node: FakeNode) =>
      node.params.gain.events.map((e) => [e.method, Math.round((e.value as number) * 1e6) / 1e6, e.time === 0 ? 0 : Math.round(e.time * SAMPLE_RATE + 0.5)]);

    it('follows volume keys on a cue, a ramp between frame starts where it changes, and leaves a cue without them alone', () => {
      const probe: AudioGenerator = { id: 'probe', params: {}, schedule: () => {} };
      const cues: AudioCue[] = [
        { id: 'bed', generator: 'probe', start: 0, end: 1, tracks: [{ param: 'volume', keys: [{ t: 0.4, v: 1 }, { t: 0.6, v: 0.5 }] }] },
        { id: 'flat', generator: 'probe', start: 0, end: 1 },
      ];
      scheduleScene(audio.ctx, { ...scene(cues), fps: 10 }, createGeneratorRegistry([probe]), audio.destination as unknown as AudioNode);
      const [bed, flat] = audio.nodes.filter((n) => n.kind === 'GainNode');
      const spf = samplesPerFrame(10);
      // Frames 0 to 3 hold 1, 4 to 6 ramp down to 0.5, then it holds.
      expect(gainEvents(bed)).toEqual([
        ['setValueAtTime', 1, 0],
        ['linearRampToValueAtTime', 1, 4 * spf],
        ['linearRampToValueAtTime', 0.75, 5 * spf],
        ['linearRampToValueAtTime', 0.5, 6 * spf],
      ]);
      expect(gainEvents(flat)).toEqual([]);
    });

    const shotScene: Scene = { id: 'shot', fps: 12, duration: 3, size: [100, 100], seed: 1, layers: [] };
    const shotBuffer = () => {
      const buffer = audio.ctx.createBuffer(2, sceneSamples(shotScene), SAMPLE_RATE);
      for (let c = 0; c < 2; c++) buffer.getChannelData(c).forEach((_, i, data) => (data[i] = c + i / 1e6));
      return buffer;
    };
    const parent = (layer: Scene['layers'][number]): Scene => ({ id: 'film', fps: 12, duration: 4, size: [100, 100], seed: 2, layers: [layer] });

    it("plays a scene layer's shot cut to its trim, from its start, sample for sample, through its volume", () => {
      const film = parent({
        id: 'take',
        scene: 'shot',
        start: 1,
        in: 0.5,
        out: 1.5,
        tracks: [{ param: 'volume', keys: [{ t: 1, v: 0 }, { t: 1.25, v: 1 }] }],
      });
      const buffer = shotBuffer();
      scheduleScene(audio.ctx, film, createDefaultGenerators(), audio.destination as unknown as AudioNode, new Map([['shot', { scene: shotScene, buffer }]]));
      const [source] = audio.sources();
      const spf = samplesPerFrame(12);
      expect(source.kind).toBe('AudioBufferSourceNode');
      expect(Math.round(source.startTime! * SAMPLE_RATE)).toBe(12 * spf);
      expect(source.startOffset).toBeUndefined();
      const clip = source.options.buffer as AudioBuffer;
      expect(clip.length).toBe(12 * spf);
      for (let c = 0; c < 2; c++) expect(clip.getChannelData(c)).toEqual(buffer.getChannelData(c).slice(6 * spf, 18 * spf));
      const gain = audio.nodes.find((n) => n.kind === 'GainNode')!;
      expect(reaches(audio, source, audio.destination)).toBe(true);
      expect(gainEvents(gain).slice(0, 2)).toEqual([
        ['setValueAtTime', 0, 12 * spf],
        ['linearRampToValueAtTime', 0.333333, 13 * spf],
      ]);
      expect(gainEvents(gain).at(-1)).toEqual(['linearRampToValueAtTime', 1, 15 * spf]);
    });

    it('leaves out a shot that is muted or silent all through, and one that never shows', () => {
      const shots = new Map([['shot', { scene: shotScene, buffer: shotBuffer() }]]);
      const layers: Scene['layers'] = [
        { id: 'a', scene: 'shot', params: { mute: true } },
        { id: 'b', scene: 'shot', params: { volume: 0 } },
        { id: 'c', scene: 'shot', start: 1, in: 1, out: 1 },
      ];
      for (const layer of layers) {
        scheduleScene(audio.ctx, parent(layer), createDefaultGenerators(), audio.destination as unknown as AudioNode, shots);
      }
      expect(audio.sources()).toEqual([]);
    });
  });
});

describe('generator registry', () => {
  it('rejects duplicate ids', () => {
    expect(() => createGeneratorRegistry([allGenerators[0], allGenerators[0]])).toThrow(/duplicate generator id/);
  });

  it('lets the validator check cue params against generator schemas', () => {
    const result = validateScene(
      {
        id: 's',
        fps: 30,
        duration: 2,
        size: [10, 10],
        seed: 1,
        layers: [],
        audio: [{ id: 'b', generator: 'blip', start: 0, end: 1, params: { pitch: 'high', volume: 1 } }],
      },
      createDefaultRegistry(),
      createDefaultGenerators(),
    );
    expect(result.ok ? [] : result.errors).toEqual([
      'audio[0].params.pitch: generator "blip" param "pitch" expects a number, got string "high"',
      'audio[0].params.volume: unknown param "volume" for generator "blip"; known params: pitch, wave, length, every, gain',
    ]);
  });
});

describe('sound through scene layers (ADR 0007)', () => {
  const blip: AudioCue = { id: 'b', generator: 'blip', start: 0, end: 0.5 };
  const shot: Scene = { id: 'shot', fps: 12, duration: 2, size: [10, 10], seed: 1, layers: [], audio: [blip] };
  const quiet: Scene = { id: 'quiet', fps: 12, duration: 2, size: [10, 10], seed: 1, layers: [] };
  const middle: Scene = { ...quiet, id: 'middle', layers: [{ id: 's', scene: 'shot' }] };
  const film: Scene = { ...quiet, id: 'film', layers: [{ id: 'm', scene: 'middle' }, { id: 'q', scene: 'quiet' }], audio: [{ id: 'bed', generator: 'pad', start: 0, end: 2 }] };
  const world = { scenes: new Map([['shot', shot], ['quiet', quiet], ['middle', middle], ['film', film]]) };

  it("counts the placed scenes' sound, however deep", () => {
    expect(hasAudio(middle, world)).toBe(true);
    expect(hasAudio(middle)).toBe(false);
    expect(hasAudio({ ...quiet, layers: [{ id: 'q', scene: 'quiet' }] }, world)).toBe(false);
    expect(generatorIdsUsed(film, world)).toEqual(['blip', 'pad']);
    const generators = createDefaultGenerators();
    expect(generatorsUsed(film, generators, world)).toEqual([generators.get('pad'), generators.get('blip')]);
  });

  it('renders again when a placed scene\'s sound or placement changes', () => {
    const key = audioKey(film, world);
    const louder = { scenes: new Map([...world.scenes, ['shot', { ...shot, audio: [{ ...blip, params: { gain: 1 } }] }]]) };
    expect(audioKey(film, louder)).not.toBe(key);
    const moved = { ...film, layers: [{ id: 'm', scene: 'middle', start: 0.5 }, film.layers[1]] };
    expect(audioKey(moved, world)).not.toBe(key);
    // A silent shot's placement doesn't change the sound.
    const silentMoved = { ...film, layers: [film.layers[0], { id: 'q', scene: 'quiet', start: 1 }] };
    expect(audioKey(silentMoved, world)).toBe(key);
  });

  it('lets cue tracks animate only volume, within 0 to 4', () => {
    const check = (tracks: unknown) =>
      validateScene({ ...quiet, audio: [{ ...blip, tracks }] }, createDefaultRegistry(), createDefaultGenerators());
    expect(check([{ param: 'volume', keys: [{ t: 0, v: 1 }, { t: 1, v: 0.2 }] }]).ok).toBe(true);
    const pitch = check([{ param: 'pitch', keys: [{ t: 0, v: 440 }] }]);
    expect(pitch.ok ? [] : pitch.errors.join('\n')).toMatch(/unknown param "pitch" for an audio cue's tracks.*known params: volume/);
  });
});
