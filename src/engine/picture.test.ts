import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { compositionToScene, validateComposition } from './composition';
import { picturesAt, picturesUsed, pictureTime } from './picture';
import { createRegistry } from './registry';
import { render } from './render';
import type { Ctx2D, Scene } from './types';
import { validateScene } from './validate';

const registry = createRegistry([]);
const context = { id: 'p', cast: {}, scenes: new Map() };
const composition = (clips: unknown[], extra = {}) => ({ id: 'c', fps: 10, duration: 10, size: [40, 20], tracks: [{ id: 'V1', clips }], ...extra });
const errors = (clips: unknown[]) => {
  const r = validateComposition(composition(clips), registry, undefined, context);
  return r.ok ? [] : r.errors;
};

describe('picture clips', () => {
  const video = { id: 'v', file: 'media/a.mp4', start: 1, in: 2, out: 4 };

  it('validates in a composition and is refused in a scene', () => {
    expect(errors([video])).toEqual([]);
    const scene = { id: 's', fps: 10, duration: 1, size: [40, 20], seed: 0, layers: [{ id: 'v', file: 'media/a.mp4', out: 1 }] };
    const result = validateScene(scene, registry);
    expect(result.ok ? [] : result.errors[0]).toContain('place images and videos as clips in a composition');
  });

  it('needs out, a real media path, and a picture type', () => {
    expect(errors([{ id: 'v', file: 'media/a.mp4' }])[0]).toContain('needs an out');
    expect(errors([{ ...video, file: '../secret.mp4' }])[0]).toContain("media/");
    expect(errors([{ ...video, file: 'media/a.mp3' }])[0]).toContain('image or video');
    expect(errors([{ ...video, in: 5 }])[0]).toContain('after in');
  });

  it('maps frames to file seconds', () => {
    const layer = { ...video };
    const scene = { fps: 10, duration: 10 };
    expect(pictureTime(layer, scene, 9)).toBeNull();
    expect(pictureTime(layer, scene, 10)).toBe(2);
    expect(pictureTime(layer, scene, 15)).toBe(2.5);
    expect(pictureTime(layer, scene, 29)).toBeCloseTo(3.9);
    expect(pictureTime(layer, scene, 30)).toBeNull();
    expect(pictureTime({ id: 'i', file: 'media/a.png', start: 0, out: 2 }, scene, 7)).toBe(0);
  });

  it('turns sound: true into a cue and leaves other clips silent', () => {
    const c = compositionToScene(composition([{ ...video, sound: true }, { id: 'q', file: 'media/b.mp4', out: 1 }]) as never);
    expect(c.audio).toEqual([{ id: 'v:sound', file: 'media/a.mp4', start: 1, end: 3, in: 2 }]);
    expect(c.layers[0]).not.toHaveProperty('sound');
  });

  it("gives a clip's cue its volume, leaves a muted clip out, clamps to the end, and refuses sound on an image", () => {
    const cues = (clip: object) => compositionToScene(composition([{ ...video, sound: true, ...clip }]) as never).audio;
    expect(cues({ params: { volume: 0.5 } })?.[0].tracks).toEqual([{ param: 'volume', keys: [{ t: 0, v: 0.5 }] }]);
    expect(cues({ params: { mute: true } })).toBeUndefined();
    expect(cues({ start: 9 })?.[0].end).toBe(10);
    expect(errors([{ ...video, sound: true, start: 9 }])).toEqual([]);
    expect(errors([{ id: 'i', file: 'media/a.png', out: 1, sound: true }])[0]).toContain('only a video clip');
  });

  it('answers a malformed clip with errors, not a crash', () => {
    expect(errors([{ ...video, sound: true, tracks: { param: 'volume' } }]).length).toBeGreaterThan(0);
  });

  it('refuses mute keys and sound overrides on a clip with sound, which would reach only the picture', () => {
    expect(errors([{ ...video, sound: true, tracks: [{ param: 'mute', keys: [{ t: 0, v: true }] }] }])[0]).toContain('not mute');
    expect(errors([{ ...video, sound: true, overrides: [{ from: 10, to: 12, params: { volume: 0 } }] }])[0]).toContain('not overrides');
    expect(errors([{ ...video, overrides: [{ from: 10, to: 12, params: { opacity: 0 } }] }])).toEqual([]);
  });

  it('finds pictures through nested compositions', () => {
    const inner = compositionToScene(composition([{ id: 'v', file: 'media/a.mp4', out: 5 }]) as never);
    const outer: Scene = { id: 'o', fps: 10, duration: 10, size: [40, 20], seed: 0, layers: [{ id: 'i', scene: 'c', start: 2 }] };
    const world = { scenes: new Map([['c', inner]]) };
    expect(picturesUsed(outer, world)).toEqual(['media/a.mp4']);
    expect(picturesAt(outer, 25, world)).toEqual([{ file: 'media/a.mp4', t: 0.5 }]);
    expect(picturesAt(outer, 5, world)).toEqual([]);
  });

  it('draws cover by default, contain on request, and nothing when the host has no frame', () => {
    const source = createCanvas(4, 4);
    const sctx = source.getContext('2d');
    sctx.fillStyle = '#ff0000';
    sctx.fillRect(0, 0, 4, 4);
    const pictures = { at: () => ({ image: source as unknown as CanvasImageSource, width: 4, height: 4 }) };
    const draw = (fit: 'cover' | 'contain', world = { pictures }) => {
      const ctx = createCanvas(40, 20).getContext('2d') as unknown as Ctx2D;
      const scene = compositionToScene(composition([{ id: 'v', file: 'media/a.png', out: 10, fit }]) as never);
      render(ctx, scene, 0, registry, world as never);
      return [...ctx.getImageData(1, 10, 1, 1).data];
    };
    expect(draw('cover')).toEqual([255, 0, 0, 255]);
    expect(draw('contain')).toEqual([0, 0, 0, 0]);
    expect(draw('cover', { pictures: { at: () => null } } as never)).toEqual([0, 0, 0, 0]);
  });
});
