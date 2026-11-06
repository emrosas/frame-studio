// Pixel stage and camera, on a real raster (@napi-rs/canvas, tests only).
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { hitTest } from './hit-test';
import { quantize, stageSize } from './pixel';
import { createRegistry } from './registry';
import { render } from './render';
import type { Ctx2D, Rig, Scene, Stage, Surfaces, World } from './types';
import { validateScene } from './validate';

const surfaces: Surfaces = {
  create(like, size) {
    const [w, h] = size ?? [like.canvas.width, like.canvas.height];
    const ctx = createCanvas(w, h).getContext('2d') as unknown as Ctx2D;
    if (!size) ctx.setTransform(like.getTransform());
    return ctx;
  },
  release() {},
};
const world: World = { surfaces };

let seen: Stage | null = null;
const box: Rig = {
  id: 'box',
  params: { x: { type: 'number', default: 0 }, c: { type: 'color', default: '#ff0000' } },
  draw(ctx, p, _t, _r, stage) {
    seen = stage;
    ctx.fillStyle = String(p.c);
    ctx.fillRect(Number(p.x), 0, 2, 2);
  },
};
const registry = createRegistry([box]);
const scene = (extra: Partial<Scene> = {}): Scene => ({
  id: 's',
  fps: 10,
  duration: 1,
  size: [40, 20],
  seed: 1,
  layers: [{ id: 'a', rig: 'box', params: { x: 1, c: '#fe0102' } }],
  ...extra,
});
const raster = (s: Scene, frame = 0) => {
  const ctx = createCanvas(s.size[0], s.size[1]).getContext('2d') as unknown as Ctx2D;
  render(ctx, s, frame, registry, world);
  return ctx.getImageData(0, 0, s.size[0], s.size[1]).data;
};
const at = (d: Uint8ClampedArray, x: number, y: number, w = 40) => [...d.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe('pixel stage', () => {
  it('draws on the small stage and blows it up with square pixels', () => {
    const data = raster(scene({ pixel: { scale: 4 } }));
    expect(seen).toEqual({ width: 10, height: 5 });
    expect(at(data, 3, 0)).toEqual([0, 0, 0, 0]);
    expect(at(data, 4, 0)).toEqual([254, 1, 2, 255]);
    expect(at(data, 11, 7)).toEqual([254, 1, 2, 255]);
    expect(at(data, 12, 7)).toEqual([0, 0, 0, 0]);
    expect(at(data, 4, 8)).toEqual([0, 0, 0, 0]);
  });

  it('snaps to the palette', () => {
    const data = raster(scene({ pixel: { scale: 2, palette: ['#ff0000', '#00ff00'] } }));
    expect(at(data, 2, 0)).toEqual([255, 0, 0, 255]);
  });

  it('quantize makes soft edges hard and dithers as a pure function of position', () => {
    const grey = () => new Uint8ClampedArray(Array.from({ length: 16 }, () => [128, 128, 128, 255]).flat());
    const a = grey();
    const b = grey();
    quantize(a, 4, 4, { palette: ['#000000', '#ffffff'], dither: 1 });
    quantize(b, 4, 4, { palette: ['#000000', '#ffffff'], dither: 1 });
    expect(a).toEqual(b);
    const values = new Set([...a].filter((_, i) => i % 4 === 0));
    expect(values).toEqual(new Set([0, 255]));
    const edge = new Uint8ClampedArray([200, 0, 0, 100, 200, 0, 0, 200]);
    quantize(edge, 2, 1, { palette: ['#000000', '#ff0000'] });
    expect([...edge]).toEqual([200, 0, 0, 0, 255, 0, 0, 255]);
  });

  it('hit tests in output pixels on the same drawing code', () => {
    const s = scene({ pixel: { scale: 4 } });
    const probe = createCanvas(1, 1).getContext('2d') as unknown as Ctx2D;
    expect(hitTest(probe, s, 0, 5, 5, registry, { world })?.layerId).toBe('a');
    expect(hitTest(probe, s, 0, 13, 5, registry, { world }).layerId).toBeNull();
  });

  it('frame N is the same drawn twice', () => {
    const s = scene({ pixel: { scale: 2, palette: ['#000000', '#ff0000'], dither: 0.5 } });
    expect(raster(s, 3)).toEqual(raster(s, 3));
  });

  it('gives the stage size', () => {
    expect(stageSize({ size: [1080, 1920], pixel: { scale: 6 } })).toEqual([180, 320]);
    expect(stageSize({ size: [1080, 1920] })).toEqual([1080, 1920]);
  });

  it('refuses a scale that does not divide the size, a bad palette and dither with no palette', () => {
    const errors = (pixel: unknown) => {
      const r = validateScene({ ...scene(), pixel }, registry);
      return r.ok ? [] : r.errors;
    };
    expect(errors({ scale: 3 })[0]).toContain('divide');
    expect(errors({ scale: 2, palette: ['red', '#000000'] })[0]).toContain('pixel.palette[0]');
    expect(errors({ scale: 2, dither: 0.5 })[0]).toContain('needs a palette');
    expect(errors({ scale: 2, palette: ['#000000', '#ffffff'], dither: 0.5 })).toEqual([]);
  });
});

describe('camera', () => {
  const track = (from: number, to: number) => [{ param: 'x', keys: [{ t: 0, v: from }, { t: 1, v: to }] }];
  it('moves layers by depth, leaves the background and depth 0 put, and follows tracks', () => {
    const s = scene({
      size: [40, 20],
      camera: { tracks: track(0, 10) },
      background: { rig: 'box', params: { x: 0, c: '#0000ff' } },
      layers: [
        { id: 'world', rig: 'box', params: { x: 20, c: '#ff0000' } },
        { id: 'far', rig: 'box', depth: 0.5, params: { x: 30, c: '#00ff00' } },
        { id: 'hud', rig: 'box', depth: 0, params: { x: 36, c: '#ffffff' } },
      ],
    });
    const data = raster(s, 5); // camera x = 5
    expect(at(data, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(at(data, 15, 0)).toEqual([255, 0, 0, 255]);
    expect(at(data, 27, 0)[1]).toBe(255); // 30 - 2.5
    expect(at(data, 36, 0)).toEqual([255, 255, 255, 255]);
  });

  it('moves a pixel stage by whole stage pixels', () => {
    const s = scene({ pixel: { scale: 4 }, camera: { x: 0.6 } });
    const data = raster(s);
    expect(at(data, 0, 0)).toEqual([254, 1, 2, 255]); // 1 - round(0.6)
  });

  it('hit tests where the layer shows', () => {
    const s = scene({ camera: { x: 1 } });
    const probe = createCanvas(1, 1).getContext('2d') as unknown as Ctx2D;
    expect(hitTest(probe, s, 0, 0, 0, registry, { world })?.layerId).toBe('a');
  });

  it('checks fields, tracks and depth', () => {
    const errors = (extra: unknown) => {
      const r = validateScene({ ...scene(), ...(extra as object) }, registry);
      return r.ok ? [] : r.errors;
    };
    expect(errors({ camera: { pan: 1 } })[0]).toContain('camera.pan');
    expect(errors({ camera: { tracks: [{ param: 'roll', keys: [{ t: 0, v: 1 }] }] } }).length).toBe(1);
    expect(errors({ layers: [{ id: 'a', rig: 'box', depth: -1 }] })[0]).toContain('depth');
    expect(errors({ markers: [{ t: 3, label: 'late' }] })[0]).toContain('past the end');
    expect(errors({ markers: [{ t: 0.5, label: 'hit' }] })).toEqual([]);
  });
});
