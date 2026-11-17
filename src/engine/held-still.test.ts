import { describe, expect, it } from 'vitest';
import { validateComposition } from './composition';
import { sceneLayerSpan, shotFrame } from './scene-layer';
import type { Scene } from './types';

const still: Scene = { id: 'card', fps: 1, duration: 1, size: [1080, 1350], seed: 1, layers: [] };
const moving: Scene = { id: 'shot', fps: 30, duration: 2, size: [1080, 1350], seed: 1, layers: [] };
const video: Scene = { id: 'v', fps: 30, duration: 10, size: [1080, 1350], seed: 1, layers: [] };

describe('a still held as a clip (ADR 0020)', () => {
  it('shows its one frame for out - in seconds, at the video\'s fps', () => {
    const span = sceneLayerSpan({ id: 'c', scene: 'card', start: 2, out: 4 }, video, still);
    expect(span).toEqual({ from: 60, to: 180, in: 0, hold: true });
    expect(shotFrame(span, 59)).toBeNull();
    expect(shotFrame(span, 60)).toBe(0);
    expect(shotFrame(span, 179)).toBe(0);
    expect(shotFrame(span, 180)).toBeNull();
    // A split's second half keeps its in, and still shows frame 0 for what is left.
    expect(sceneLayerSpan({ id: 'c', scene: 'card', start: 4, in: 2, out: 4 }, video, still)).toEqual({ from: 120, to: 180, in: 60, hold: true });
  });

  it('runs to the end of the video without an out, and stops there with a long one', () => {
    expect(sceneLayerSpan({ id: 'c', scene: 'card', start: 1 }, video, still)).toMatchObject({ from: 30, to: 300 });
    expect(sceneLayerSpan({ id: 'c', scene: 'card', out: 60 }, video, still)).toMatchObject({ from: 0, to: 300 });
  });

  it('leaves a scene with more frames as it was', () => {
    const span = sceneLayerSpan({ id: 'c', scene: 'shot', start: 1 }, video, moving);
    expect(span).toEqual({ from: 30, to: 90, in: 0 });
    expect(shotFrame(span, 45)).toBe(15);
  });

  const check = (clip: Record<string, unknown>) => {
    const scenes = new Map([
      ['card', { duration: 1, fps: 1 }],
      ['shot', { duration: 2, fps: 30 }],
      ['slow', { duration: 2, fps: 12 }],
    ]);
    const r = validateComposition({ id: 'v', fps: 30, duration: 10, size: [1080, 1350], tracks: [{ id: 'V1', clips: [clip] }] }, undefined, undefined, { id: 'folder', cast: {}, scenes });
    return r.ok ? [] : r.errors;
  };

  it('is valid at another fps and far past its own second, and needs an out', () => {
    expect(check({ id: 'c', scene: 'card', start: 1, out: 6 })).toEqual([]);
    expect(check({ id: 'c', scene: 'card', in: 2, out: 5 })).toEqual([]);
    expect(check({ id: 'c', scene: 'card' }).join()).toMatch(/"card" is a still, which has no length of its own; give out/);
    expect(check({ id: 'c', scene: 'card', in: 3, out: 2 }).join()).toMatch(/must be after in/);
  });

  it('keeps the rules for scenes that move', () => {
    expect(check({ id: 'c', scene: 'shot' })).toEqual([]);
    expect(check({ id: 'c', scene: 'shot', out: 5 }).join()).toMatch(/within the shot's duration/);
    expect(check({ id: 'c', scene: 'slow' }).join()).toMatch(/runs at 12 fps/);
  });
});
