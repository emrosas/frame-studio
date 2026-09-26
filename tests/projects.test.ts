/**
 * Every project in projects/ (ADR 0007) loads in the viewer's own library with
 * no errors, and the sample, projects/bears-story, shows what projects are for:
 * a main scene that places three shots with a cut, a crossfade and an iris
 * made by a project rig, and a cast its shots share. Rendering goes through
 * the engine's recording context, as in scenes.test.ts; the render page's
 * browser test checks the pixels.
 */
import { describe, expect, it } from 'vitest';
import {
  frameCount,
  render,
  resolveLayer,
  sceneLayerSpan,
  scenePlacement,
  timeToFrame,
  validateScene,
  type Ctx2D,
  type Scene,
  type Surfaces,
  type World,
} from '../src/engine';
import { createRecordingContext, type LogEntry } from '../src/engine/testing/recording-context';
import { createDefaultGenerators } from '../src/audio';
import { createDefaultRegistry } from '../src/rigs';
import { findEntry, type SceneEntry } from '../src/viewer/library';
import { loadLibrary } from '../src/viewer/scenes';

const library = loadLibrary();
const entry = (key: string): SceneEntry => {
  const found = findEntry(library, key);
  if (!found?.scene || !found.registry) throw new Error(`${key} is missing or invalid: ${found?.errors.join('\n')}`);
  return found;
};

/** Surfaces that are recording contexts, so masks and fades render without a browser. */
function recordingSurfaces(): Surfaces {
  return {
    create(like: Ctx2D) {
      const rec = createRecordingContext(like.canvas.width, like.canvas.height);
      const m = like.getTransform();
      rec.ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      return rec.ctx as unknown as Ctx2D;
    },
    release() {},
  };
}

/** The paint calls of a render, each with the state that decides its pixels; render's clearRect aside. */
function paints(e: SceneEntry, frame: number, world: World = e.world): LogEntry[] {
  const rec = createRecordingContext(e.scene!.size[0], e.scene!.size[1]);
  render(rec.ctx as unknown as Ctx2D, e.scene!, frame, e.registry!, { ...world, surfaces: recordingSurfaces() });
  expect(rec.saveDepth(), `save stack after frame ${frame} of ${e.key}`).toBe(0);
  return rec.log.filter((l) => l.op === 'call' && l.paint && l.name !== 'clearRect');
}

describe('projects', () => {
  it('load with no errors, their scenes too', () => {
    expect(library.projects.length).toBeGreaterThan(0);
    for (const project of library.projects) expect(project.errors, project.file).toEqual([]);
    for (const e of library.entries.filter((x) => x.project !== null)) expect(e.errors, e.file).toEqual([]);
  });
});

describe('projects/bears-story', () => {
  const film = entry('bears-story/film');
  const scene = film.scene!;
  const shots = scene.layers.flatMap((layer) => {
    const shot = layer.scene !== undefined ? film.world.scenes?.get(layer.scene) : undefined;
    return shot ? [{ layer, shot, span: sceneLayerSpan(layer, scene, shot) }] : [];
  });

  it('is the main scene, placing at least three shots', () => {
    expect(library.projects.find((p) => p.id === 'bears-story')?.main).toBe('bears-story/film');
    expect(new Set(shots.map((s) => s.shot.id)).size).toBeGreaterThanOrEqual(3);
  });

  it('cuts, crossfades and opens an iris between shots', () => {
    const opacity = (i: number, f: number) => scenePlacement(shots[i].layer, scene, f).opacity;
    const cut = shots.findIndex((a, i) => shots.some((b, j) => j !== i && b.span.from === a.span.to && opacity(j, b.span.from) === 1));
    expect(cut, 'a shot ending where another starts at full opacity').toBeGreaterThanOrEqual(0);
    const crossfade = shots.find(
      (a, i) => a.span.from > 0 && shots.some((b) => b !== a && b.span.from < a.span.from && b.span.to > a.span.from) && opacity(i, a.span.from) < 1,
    );
    expect(crossfade, 'a shot fading in over another').toBeDefined();
    const iris = shots.find((s) => s.layer.mask?.rig === 'iris');
    expect(iris, 'a shot revealed through the iris rig').toBeDefined();
  });

  it('draws a shot showing in full exactly as the shot draws alone, over the film background', () => {
    for (const [key, filmFrame] of [
      ['bears-story/meet', 24],
      ['bears-story/pip', 60],
      ['bears-story/together', 96],
    ] as const) {
      const alone = entry(key);
      const s = shots.find((x) => x.shot.id === alone.scene!.id && filmFrame >= x.span.from && filmFrame < x.span.to)!;
      const own = paints(alone, filmFrame - s.span.from + s.span.in);
      const inFilm = paints(film, filmFrame);
      expect(JSON.stringify(inFilm.slice(-own.length)), `${key} at film frame ${filmFrame}`).toBe(JSON.stringify(own));
    }
  });

  it('renders the transitions and the frames around them without throwing', () => {
    const frames = new Set([0, frameCount(scene) - 1]);
    for (const { span } of shots) for (const f of [span.from - 1, span.from, span.from + 6, span.to - 1, span.to]) frames.add(f);
    for (const f of [...frames].filter((f) => f >= 0 && f < frameCount(scene))) expect(paints(film, f).length, `frame ${f}`).toBeGreaterThan(0);
  });

  it('draws both bears from the cast, so one cast edit changes every shot, and a layer param still wins', () => {
    const bruno = (key: string, world: World) => {
      const e = entry(key);
      const layer = e.scene!.layers.find((l) => l.cast === 'bruno')!;
      return resolveLayer(layer, e.scene!, 0, e.registry!, world);
    };
    const castWorld = (body: string): World => ({
      ...film.world,
      cast: { ...film.world.cast, bruno: { ...film.world.cast!.bruno, params: { ...film.world.cast!.bruno.params, body } } },
    });
    for (const key of ['bears-story/meet', 'bears-story/together']) {
      expect(bruno(key, film.world).rig.id).toBe('bear');
      expect(bruno(key, castWorld('#aabbcc')).params.body, key).toBe('#aabbcc');
    }
    for (const key of ['bears-story/pip', 'bears-story/together']) {
      expect(entry(key).scene!.layers.some((l) => l.cast === 'pip'), key).toBe(true);
    }
    // The layer's own width beats the cast's, which has none, and so would its own body.
    const meet = entry('bears-story/meet');
    const layer = { ...meet.scene!.layers[0], params: { ...meet.scene!.layers[0].params, body: '#123456' } };
    expect(resolveLayer(layer, meet.scene!, 0, meet.registry!, castWorld('#aabbcc')).params.body).toBe('#123456');
    expect(resolveLayer(layer, meet.scene!, 0, meet.registry!, meet.world).params.width).toBe(520);
  });

  it("offers the iris rig to this project's scenes only", () => {
    expect(film.registry?.has('iris')).toBe(true);
    expect(findEntry(library, 'bear-test')?.registry?.has('iris')).toBe(false);
    const loose = validateScene(
      { id: 'x', fps: 12, duration: 1, size: [100, 100], seed: 1, layers: [{ id: 'i', rig: 'iris' }] },
      createDefaultRegistry(),
      createDefaultGenerators(),
    );
    expect(loose.ok ? [] : loose.errors.join('\n')).toMatch(/unknown rig "iris"/);
  });

  it("brings the shots' sound, and ducks the bed under the second shot", () => {
    for (const { shot } of shots) expect(shot.audio?.length, shot.id).toBeGreaterThan(0);
    const bed = scene.audio?.find((c) => c.id === 'bed');
    const volume = bed?.tracks?.find((t) => t.param === 'volume');
    const pip = shots.find((s) => s.shot.id === 'pip')!;
    const low = volume?.keys.filter((k) => timeToFrame(k.t, scene.fps) >= pip.span.from && timeToFrame(k.t, scene.fps) < pip.span.to).map((k) => k.v);
    expect(Math.min(...(low as number[]))).toBeLessThan(0.5);
  });
});
