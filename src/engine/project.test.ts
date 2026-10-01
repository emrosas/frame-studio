import { describe, expect, it } from 'vitest';
import { createRegistry, rigIdsUsed } from './registry';
import { render } from './render';
import { resolveLayer } from './resolve';
import { sceneGraphErrors, validateProject } from './project';
import { sceneLayerSpan, scenePlacement, shotFrame } from './scene-layer';
import { createRecordingContext, type LogEntry } from './testing/recording-context';
import type { Ctx2D, Layer, Rig, Scene, Surfaces, World } from './types';
import { validateScene, type ProjectContext } from './validate';

const box: Rig = {
  id: 'box',
  params: {
    x: { type: 'number', default: 0, min: -1000, max: 1000 },
    size: { type: 'number', default: 10, min: 0, max: 1000 },
    fill: { type: 'color', default: '#ff0000' },
  },
  draw(ctx, p) {
    ctx.fillStyle = String(p.fill);
    ctx.fillRect(Number(p.x), 0, Number(p.size), Number(p.size));
  },
};
const boxWide: Rig = { ...box, id: 'box.wide' };
const dot: Rig = {
  id: 'dot',
  params: { r: { type: 'number', default: 5, min: 0, max: 1000 } },
  draw(ctx, p) {
    ctx.beginPath();
    ctx.arc(50, 50, Number(p.r), 0, Math.PI * 2);
    ctx.fill();
  },
};
const registry = createRegistry([box, boxWide, dot]);

const scene = (id: string, layers: Layer[], extra: Partial<Scene> = {}): Scene => ({ id, fps: 12, duration: 2, size: [100, 100], seed: 7, layers, ...extra });

/** The paint calls of a log, with the state that decides their pixels; render's clearRect aside. */
const paints = (log: readonly LogEntry[]) => log.filter((e) => e.op === 'call' && e.paint && e.name !== 'clearRect');

/** Surfaces that are recording contexts, keeping every one made, so tests can look inside. */
function recordingSurfaces(): Surfaces & { made: ReturnType<typeof createRecordingContext>[] } {
  const made: ReturnType<typeof createRecordingContext>[] = [];
  return {
    made,
    create(like: Ctx2D) {
      const rec = createRecordingContext(like.canvas.width, like.canvas.height);
      const m = like.getTransform();
      rec.ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      rec.clearLog();
      made.push(rec);
      return rec.ctx as unknown as Ctx2D;
    },
    release() {},
  };
}

describe('cast', () => {
  const world: World = { cast: { bruno: { rig: 'box', params: { fill: '#ffffff', size: 40 } } } };

  it("draws a cast member's rig with its params, under the layer's own, tracks and overrides", () => {
    const layer: Layer = { id: 'b', cast: 'bruno', params: { x: 5 }, overrides: [{ from: 6, to: 12, params: { size: 20 } }] };
    const s = scene('s', [layer]);
    expect(resolveLayer(layer, s, 0, registry, world)).toMatchObject({ rig: box, params: { fill: '#ffffff', size: 40, x: 5 } });
    expect(resolveLayer(layer, s, 6, registry, world).params.size).toBe(20);
    expect(resolveLayer({ ...layer, overrides: [{ from: 0, to: 24, rig: 'box.wide' }] }, s, 0, registry, world).rig).toBe(boxWide);
  });

  it('names the cast when a member is missing', () => {
    const layer: Layer = { id: 'b', cast: 'pip' };
    expect(() => resolveLayer(layer, scene('s', [layer]), 0, registry, world)).toThrow(/no cast member "pip"; the cast is bruno/);
  });
});

describe('scene layers', () => {
  const shot = scene('shot', [{ id: 'a', rig: 'box', tracks: [{ param: 'x', keys: [{ t: 0, v: 0 }, { t: 2, v: 48 }] }] }]);
  const world = (surfaces?: Surfaces): World => ({ scenes: new Map([['shot', shot]]), ...(surfaces ? { surfaces } : {}) });

  it('maps parent frames to shot frames through start and trim, and stops at the trim', () => {
    const span = sceneLayerSpan({ id: 'l', scene: 'shot', start: 0.5, in: 0.25, out: 1 }, scene('main', []), shot);
    expect(span).toEqual({ from: 6, to: 15, in: 3 });
    expect([5, 6, 14, 15].map((f) => shotFrame(span, f))).toEqual([null, 3, 11, null]);
    // No out: the shot's own end, and never past the parent's.
    expect(sceneLayerSpan({ id: 'l', scene: 'shot', start: 1 }, scene('main', []), shot)).toEqual({ from: 12, to: 24, in: 0 });
  });

  it('draws the shot exactly as it draws alone, at the matching frame', () => {
    const main = scene('main', [{ id: 'cut', scene: 'shot', start: 0.5, in: 0.25 }]);
    const inMain = createRecordingContext();
    render(inMain.ctx, main, 10, registry, world());
    const alone = createRecordingContext();
    render(alone.ctx, shot, 10 - 6 + 3, registry);
    expect(paints(inMain.log)).toEqual(paints(alone.log));
    expect(paints(inMain.log)).not.toHaveLength(0);
    const before = createRecordingContext();
    render(before.ctx, main, 5, registry, world());
    expect(paints(before.log)).toEqual([]);
  });

  it('places the shot with offsets, scale and rotation about the centre', () => {
    const main = scene('main', [{ id: 'pip', scene: 'shot', params: { x: 10, y: -5, scale: 0.5 } }]);
    const rec = createRecordingContext();
    render(rec.ctx, main, 0, registry, world());
    const [paint] = paints(rec.log);
    // translate(60, 45) scale(0.5) translate(-50, -50): x' = 0.5x + 35, y' = 0.5y + 20.
    expect(paint.op === 'call' && paint.paint?.transform).toEqual([0.5, 0, 0, 0.5, 35, 20]);
    // Clipped to the shot's own stage, so what it draws off its edge stays hidden, as it does alone.
    expect(paint.op === 'call' && paint.paint?.clips.map((c) => [c.transform, c.path])).toEqual([
      [[0.5, 0, 0, 0.5, 35, 20], [expect.objectContaining({ name: 'rect', args: [0, 0, 100, 100] })]],
    ]);
    // In place, nothing clips it: its pixels are the shot's own.
    const inPlace = createRecordingContext();
    render(inPlace.ctx, scene('main', [{ id: 'pip', scene: 'shot' }]), 0, registry, world());
    expect(paints(inPlace.log).every((p) => p.op === 'call' && p.paint?.clips.length === 0)).toBe(true);
  });

  it("keeps a shot's partial last frame when out is its end", () => {
    const odd = { ...shot, duration: 1.55 };
    const span = (out?: number) => sceneLayerSpan({ id: 'l', scene: 'shot', ...(out !== undefined ? { out } : {}) }, scene('main', []), odd);
    expect(span(1.55)).toEqual(span());
    expect(span().to).toBe(19);
  });

  it('fades through a surface, at the placement opacity', () => {
    const surfaces = recordingSurfaces();
    const main = scene('main', [{ id: 'fade', scene: 'shot', tracks: [{ param: 'opacity', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }] }]);
    const rec = createRecordingContext();
    render(rec.ctx, main, 6, registry, world(surfaces));
    expect(surfaces.made).toHaveLength(1);
    expect(paints(surfaces.made[0].log)).toHaveLength(1); // the shot, drawn on the surface
    const put = paints(rec.log);
    expect(put).toHaveLength(1);
    expect(put[0].op === 'call' && put[0].name).toBe('drawImage');
    expect(put[0].op === 'call' && put[0].paint?.props?.globalAlpha).toBeCloseTo(0.5, 9);
    // Fully transparent draws nothing.
    const none = createRecordingContext();
    render(none.ctx, main, 0, registry, world(surfaces));
    expect(paints(none.log)).toEqual([]);
  });

  it('says when a renderer gives no surfaces, and when a loose scene places a scene', () => {
    const main = scene('main', [{ id: 'fade', scene: 'shot', params: { opacity: 0.5 } }]);
    expect(() => render(createRecordingContext().ctx, main, 0, registry, world())).toThrow(/needs compositing.*gave no surfaces/);
    expect(() => render(createRecordingContext().ctx, main, 0, registry)).toThrow(/a loose scene places no scenes/);
  });

  it('reads placement from params, tracks and overrides, clamped to the schema', () => {
    const layer: Layer = { id: 'l', scene: 'shot', params: { scale: 2, volume: 9 }, overrides: [{ from: 12, to: 24, params: { mute: true } }] };
    expect(scenePlacement(layer, scene('main', []), 0)).toMatchObject({ scale: 2, volume: 4, mute: false, opacity: 1 });
    expect(scenePlacement(layer, scene('main', []), 12).mute).toBe(true);
  });
});

describe('masks', () => {
  it("cuts the layer to what the mask rig draws, on surfaces, with the mask's own tracks", () => {
    const surfaces = recordingSurfaces();
    const s = scene('s', [{ id: 'l', rig: 'box', params: { size: 100 }, mask: { rig: 'dot', tracks: [{ param: 'r', keys: [{ t: 0, v: 0 }, { t: 1, v: 60 }] }] } }]);
    const rec = createRecordingContext();
    render(rec.ctx, s, 6, registry, { surfaces });
    const [layerSurface, maskSurface] = surfaces.made;
    expect(paints(layerSurface.log).map((e) => e.op === 'call' && e.name)).toEqual(['fillRect', 'drawImage']);
    const cut = paints(layerSurface.log)[1];
    expect(cut.op === 'call' && cut.paint?.props?.globalCompositeOperation).toBe('destination-in');
    const arc = maskSurface.log.find((e) => e.op === 'call' && e.name === 'arc');
    expect(arc?.op === 'call' && arc.args[2]).toBe(30);
    expect(paints(rec.log).map((e) => e.op === 'call' && e.name)).toEqual(['drawImage']);
  });
});

describe('rigIdsUsed', () => {
  it('counts cast rigs, masks and the rigs of the shots a scene places', () => {
    const shot = scene('shot', [{ id: 'a', cast: 'hero' }]);
    const main = scene('main', [{ id: 'cut', scene: 'shot', mask: { rig: 'dot' } }], { background: { rig: 'box.wide' } });
    expect(rigIdsUsed(main, { scenes: new Map([['shot', shot]]), cast: { hero: { rig: 'box' } } })).toEqual(['box', 'box.wide', 'dot']);
  });
});

describe('validating project scenes', () => {
  const project: ProjectContext = {
    id: 'story',
    fps: 12,
    size: [100, 100],
    cast: { bruno: { rig: 'box' } },
    scenes: new Map([
      ['main', { duration: 2 }],
      ['shot', { duration: 1 }],
    ]),
  };
  /** Null: a loose scene, with no project. */
  const errors = (layers: Layer[], extra: Partial<Scene> = {}, ctx: ProjectContext | null = project) => {
    const r = validateScene(scene('main', layers, extra), registry, undefined, ctx ?? undefined);
    return r.ok ? [] : r.errors;
  };

  it('accepts scene layers, cast members and masks', () => {
    expect(
      errors([
        { id: 'cut', scene: 'shot', start: 0, in: 0.25, out: 1, params: { opacity: 0.5 }, tracks: [{ param: 'x', keys: [{ t: 0, v: 0 }] }] },
        { id: 'b', cast: 'bruno', params: { x: 3 }, mask: { rig: 'dot', params: { r: 20 } } },
      ]),
    ).toEqual([]);
  });

  it('refuses a layer with no kind, or two', () => {
    expect(errors([{ id: 'x' } as Layer])).toEqual([expect.stringMatching(/^layers\[0\]: needs a "rig"/)]);
    expect(errors([{ id: 'x', rig: 'box', cast: 'bruno' }])).toEqual([expect.stringMatching(/names both "rig" and "cast"/)]);
  });

  it('checks what a scene layer places, and when', () => {
    expect(errors([{ id: 'c', scene: 'main' }])).toEqual(['layers[0].scene: a scene cannot place itself']);
    expect(errors([{ id: 'c', scene: 'nope' }])).toEqual([expect.stringMatching(/no scene "nope" in project "story"; its scenes are shot/)]);
    expect(errors([{ id: 'c', scene: 'shot', out: 1.5 }])).toEqual([expect.stringMatching(/out: must be within the shot's duration \(1 s\)/)]);
    expect(errors([{ id: 'c', scene: 'shot', in: 0.5, out: 0.5 }])).toEqual([expect.stringMatching(/out: must be after in/)]);
    expect(errors([{ id: 'c', scene: 'shot', start: 2 }])).toEqual([expect.stringMatching(/start: must be before this scene ends/)]);
    expect(errors([{ id: 'c', scene: 'shot', stepFps: 6 }])).toEqual([expect.stringMatching(/remove stepFps/)]);
    expect(errors([{ id: 'c', scene: 'shot', params: { size: 3 } }])).toEqual([expect.stringMatching(/unknown param "size" for a scene layer; known params: x, y, scale/)]);
    expect(errors([{ id: 'c', scene: 'shot', overrides: [{ from: 0, to: 2, rig: 'box' }] }])).toEqual([expect.stringMatching(/has no rig to swap/)]);
    expect(errors([{ id: 'c', rig: 'box', start: 1 }])).toEqual([expect.stringMatching(/only scene layers take start/)]);
    expect(errors([{ id: 'c', scene: 'shot' }], {}, null)).toEqual([expect.stringMatching(/a scene draws and places nothing; arrange scenes in a composition/)]);
  });

  it('checks cast members and masks', () => {
    expect(errors([{ id: 'b', cast: 'pip' }])).toEqual([expect.stringMatching(/no cast member "pip" in project "story"; the cast is bruno/)]);
    expect(errors([{ id: 'b', cast: 'bruno', params: { r: 1 } }])).toEqual([expect.stringMatching(/unknown param "r" for rig "box"/)]);
    expect(errors([{ id: 'b', cast: 'bruno' }], {}, null)).toEqual([expect.stringMatching(/only scenes in a project have a cast/)]);
    expect(errors([{ id: 'b', rig: 'box', mask: { rig: 'nope' } }])).toEqual([expect.stringMatching(/mask\.rig: unknown rig "nope"/)]);
    expect(errors([{ id: 'b', rig: 'box', mask: { rig: 'dot', params: { x: 1 } } }])).toEqual([expect.stringMatching(/mask\.params\.x: unknown param "x" for rig "dot"/)]);
  });

  it("holds every scene to the project's fps and size", () => {
    expect(errors([], { fps: 24 })).toEqual(["fps: must be the project's fps, 12 (project \"story\"), got 24"]);
    expect(errors([], { size: [200, 100] })).toEqual(["size: must be the project's size, [100, 100] (project \"story\"), got [200, 100]"]);
  });
});

describe('validateProject', () => {
  it('accepts a project file and checks its cast against the rigs', () => {
    expect(validateProject({ name: 'Story', fps: 12, size: [100, 100], main: 'main', cast: { bruno: { rig: 'box', params: { size: 3 } } } }, registry, ['main'])).toMatchObject({ ok: true });
    const bad = validateProject({ fps: 0, size: [1], main: 'film', cast: { bruno: { rig: 'bear' }, pip: { rig: 'box', params: { r: 1 } }, 'a/b': { rig: 'box' } }, mood: 1 }, registry, ['main']);
    expect(bad.ok ? [] : bad.errors).toEqual([
      'mood: unknown field "mood"; allowed fields: name, fps, size, main, cast',
      'fps: must be a positive integer, shared by every scene in the project, got 0',
      'size: must be [width, height] in scene pixels, shared by every scene in the project, got [1]',
      'main: no scene "film" in the project; its scenes are main',
      expect.stringMatching(/^cast\.bruno: rig: unknown rig "bear"/),
      expect.stringMatching(/^cast\.pip: params\.r: unknown param "r" for rig "box"/),
      'cast.a/b: cast names are short names without "/"',
    ]);
  });
});

describe('sceneGraphErrors', () => {
  const placing = (id: string, ...shots: string[]) => scene(id, shots.map((s, i) => ({ id: `l${i}`, scene: s })));

  it('finds scenes that place themselves through others', () => {
    const scenes = new Map([
      ['a', placing('a', 'b')],
      ['b', placing('b', 'c')],
      ['c', placing('c', 'a')],
      ['d', placing('d', 'a')],
    ]);
    const errs = sceneGraphErrors(scenes);
    expect([...errs.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(errs.get('a')![0]).toMatch(/in a loop: a → b → c → a/);
  });

  it('limits how deep scene layers nest', () => {
    // 18 scenes in a chain: the first places the rest 17 deep, past the limit of 16; the second, 16 deep, is fine.
    const ids = Array.from({ length: 18 }, (_, i) => `s${i}`);
    const chain = new Map(ids.map((id, i, all) => [id, i < all.length - 1 ? placing(id, all[i + 1]) : placing(id)]));
    const errs = sceneGraphErrors(chain);
    expect([...errs.keys()]).toEqual(['s0']);
    expect(errs.get('s0')![0]).toMatch(/places scenes 17 deep; nesting is limited to 16/);
  });
});
