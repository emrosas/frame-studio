/**
 * Every file in scenes/ must parse, validate against the shipped rigs with zero
 * errors, and render every frame. Rendering goes through the engine's recording
 * context, so no browser is needed; a paint call's log entry carries the state
 * that decides its pixels, so equal logs mean equal images.
 *
 * Scenes are read as raw text and parsed here, so a malformed file fails its
 * own test with the parse error instead of breaking the whole file.
 */
import { describe, expect, it } from 'vitest';
import { BACKGROUND_ID, frameCount, render, resolveLayer, sceneLayers, timeToFrame, validateScene, type Layer, type Scene } from '../src/engine';
import { createRecordingContext, splitLayerLogs, type LogEntry } from '../src/engine/testing/recording-context';
import { createDefaultRegistry } from '../src/rigs';

const files = import.meta.glob<string>('/scenes/*.json', { eager: true, query: '?raw', import: 'default' });
const registry = createDefaultRegistry();
const paths = Object.keys(files).sort();

function loadScene(path: string): Scene {
  const result = validateScene(JSON.parse(files[path]), registry);
  if (!result.ok) throw new Error(`${path.slice(1)} is invalid:\n${result.errors.join('\n')}`);
  return result.scene;
}

/**
 * A recording context whose ctx.canvas throws. The viewer's backing store is
 * not the scene size, so rigs must size themselves from the stage argument.
 */
function recorder() {
  const rec = createRecordingContext();
  const ctx = new Proxy(rec.ctx, {
    get(target, prop, receiver) {
      if (prop === 'canvas') throw new Error('rigs must not read ctx.canvas; use the stage argument');
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...rec, ctx };
}

/**
 * A context that draws nothing and records nothing, for the quick
 * every-frame pass on heavy scenes. It still counts save and restore, and
 * reading ctx.canvas throws. Every method returns a stub that also works as a
 * gradient or pattern.
 */
function stubContext() {
  let depth = 0;
  const stub = { addColorStop() {}, setTransform() {} };
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get(target, prop) {
      if (prop === 'canvas') throw new Error('rigs must not read ctx.canvas; use the stage argument');
      if (prop === 'save') return () => void depth++;
      if (prop === 'restore') return () => void (depth = Math.max(0, depth - 1));
      if (prop in target) return target[prop];
      return () => stub;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, saveDepth: () => depth };
}

/** Renders one frame and checks the save stack is back to zero. */
function renderChecked(rec: ReturnType<typeof recorder>, scene: Scene, frame: number): void {
  rec.clearLog();
  try {
    render(rec.ctx, scene, frame, registry);
  } catch (error) {
    throw new Error(`frame ${frame} failed to render: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  expect(rec.saveDepth(), `save stack after frame ${frame}`).toBe(0);
}

/** Draw log of one frame, as a string, so frames can be compared without holding every log. */
function frameLog(rec: ReturnType<typeof recorder>, scene: Scene, frame: number): string {
  renderChecked(rec, scene, frame);
  return JSON.stringify(rec.log);
}

/**
 * Above this many characters of draw log over the whole scene (frame 0's log
 * length times the frame count), the determinism test checks the frames from
 * checkedFrames instead of every frame. Serialising the log is most of the
 * cost: shapes-test is about 70 million characters, bear-test about 3 billion.
 */
const FULL_CHECK_BUDGET = 300_000_000;

/**
 * The frames where a scene is most likely to go wrong, sorted: the first four
 * and last two, the frame before and at every track key (where values, poses
 * and held steps change), a frame midway between consecutive keys (mid-motion),
 * and both sides of each override's from and to.
 */
function checkedFrames(scene: Scene): number[] {
  const count = frameCount(scene);
  const out = new Set<number>([0, 1, 2, 3, count - 2, count - 1]);
  const add = (f: number) => {
    if (f >= 0 && f < count) out.add(f);
  };
  for (const layer of sceneLayers(scene)) {
    for (const track of layer.tracks ?? []) {
      const keys = track.keys.map((k) => timeToFrame(k.t, scene.fps));
      keys.forEach((f, i) => {
        add(f - 1);
        add(f);
        if (i > 0) add(Math.floor((keys[i - 1] + f) / 2));
      });
    }
    for (const o of layer.overrides ?? []) [o.from - 1, o.from, o.to - 1, o.to].forEach(add);
  }
  return [...out].sort((a, b) => a - b);
}

describe('scenes/*.json', () => {
  it('includes the M1 scenes', () => {
    expect(paths).toEqual(expect.arrayContaining(['/scenes/shapes-test.json', '/scenes/hello.json']));
  });

  it.each(paths)('%s validates against createDefaultRegistry() with zero errors', (path) => {
    const json: unknown = JSON.parse(files[path]);
    const result = validateScene(json, registry);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it.each(paths)('%s is named after its scene id', (path) => {
    const json = JSON.parse(files[path]) as { id?: unknown };
    expect(path).toBe(`/scenes/${String(json.id)}.json`);
  });

  // Acceptance: scrubbing to any frame shows the same image as playing to it.
  // Light scenes check every frame. A heavy scene (a big draw log times many
  // frames) renders every frame once, then checks the spread of frames from
  // checkedFrames: its start and end, both sides of every key, held step and
  // override boundary, and a mid-motion frame between keys. Played, seeked and
  // scrubbed backwards still go through the same frames in those orders, so
  // state leaking from one frame to the next, or from a later frame back to an
  // earlier one, still shows.
  it.each(paths)('%s renders every frame, the same whether played, seeked, or scrubbed backwards', (path) => {
    const scene = loadScene(path);
    const count = frameCount(scene);
    const first = frameLog(recorder(), scene, 0);
    let frames = Array.from({ length: count }, (_, f) => f);
    if (first.length * count > FULL_CHECK_BUDGET) {
      const quick = stubContext();
      for (const frame of frames) {
        try {
          render(quick.ctx, scene, frame, registry);
        } catch (error) {
          throw new Error(`frame ${frame} failed to render: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        expect(quick.saveDepth(), `save stack after frame ${frame}`).toBe(0);
      }
      frames = checkedFrames(scene);
    }
    const played = recorder();
    const playedLogs = new Map<number, string>();
    for (const frame of frames) {
      let log: string;
      try {
        log = frameLog(played, scene, frame);
      } catch (error) {
        throw new Error(`frame ${frame} failed to render: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      expect(log, `frame ${frame}: played vs fresh`).toBe(frame === 0 ? first : frameLog(recorder(), scene, frame));
      playedLogs.set(frame, log);
    }
    const scrubbed = recorder();
    for (const frame of [...frames].reverse()) {
      expect(frameLog(scrubbed, scene, frame), `frame ${frame}: scrubbed backwards vs played`).toBe(playedLogs.get(frame));
    }
  }, 30_000);

  it('checks a spread of frames on a heavy scene: ends, key, step and override boundaries, and mid-motion', () => {
    const scene = loadScene('/scenes/bear-test.json');
    const frames = checkedFrames(scene);
    // Start (bruno mid-entrance), both sides of the 2 s, 4 s, 5 s and 7 s keys, the override edges, and the end.
    expect(frames).toEqual(expect.arrayContaining([0, 1, 2, 3, 12, 23, 24, 47, 48, 59, 60, 71, 72, 83, 84, 94, 95]));
    expect(frames).toEqual([...new Set(frames)].sort((a, b) => a - b));
    expect(frames.length).toBeLessThan(frameCount(scene) / 2);
  });
});

describe('shapes-test', () => {
  const path = '/scenes/shapes-test.json';
  const scene = loadScene(path);
  const count = frameCount(scene);
  const layer = (id: string): Layer => {
    const found = scene.layers.find((l) => l.id === id);
    if (!found) throw new Error(`shapes-test has no layer "${id}"`);
    return found;
  };
  const param = (id: string, frame: number, name: string) => resolveLayer(layer(id), scene, frame, registry).params[name];

  /** Per-layer draw logs for one frame, keyed by layer id. */
  function layerLogs(frame: number): Map<string, LogEntry[]> {
    const rec = recorder();
    render(rec.ctx, scene, frame, registry);
    const ids = sceneLayers(scene).map((l) => l.id);
    const chunks = splitLayerLogs(rec.log);
    expect(chunks).toHaveLength(ids.length);
    return new Map(ids.map((id, i) => [id, chunks[i]]));
  }
  const fills = (log: LogEntry[]) =>
    log.flatMap((e) => (e.op === 'call' && e.name === 'fill' && e.paint?.props ? [e.paint.props.fillStyle] : []));

  it('is 12 fps with a background and a stepFps 6 layer next to a 12 fps one', () => {
    expect(scene.fps).toBe(12);
    expect(scene.background?.rig).toBe('paper');
    expect(layer('onOnes').stepFps ?? scene.fps).toBe(12);
    expect(layer('onTwos').stepFps).toBe(6);
  });

  it('holds onTwos for pairs of frames while onOnes moves every frame, on the same path', () => {
    for (let frame = 0; frame + 1 < count; frame += 2) {
      expect(param('onTwos', frame + 1, 'x')).toBe(param('onTwos', frame, 'x'));
      expect(param('onOnes', frame + 1, 'x')).not.toBe(param('onOnes', frame, 'x'));
      expect(param('onTwos', frame, 'x')).toBe(param('onOnes', frame, 'x'));
    }
  });

  it('draws held frames identically on the canvas, wobble included', () => {
    for (let frame = 0; frame + 1 < count; frame += 2) {
      const a = layerLogs(frame);
      const b = layerLogs(frame + 1);
      expect(b.get('onTwos'), `onTwos frames ${frame}, ${frame + 1}`).toEqual(a.get('onTwos'));
      expect(b.get('onOnes'), `onOnes frames ${frame}, ${frame + 1}`).not.toEqual(a.get('onOnes'));
    }
  });

  it('keeps the paper background still on every frame', () => {
    const background = (frame: number) => layerLogs(frame).get(BACKGROUND_ID) ?? [];
    expect(background(0).length).toBeGreaterThan(0);
    // Compared as JSON: the paper log is large and toEqual on it is slow.
    const first = JSON.stringify(background(0));
    for (let frame = 1; frame < count; frame++) expect(JSON.stringify(background(frame)), `frame ${frame}`).toBe(first);
  });

  it('overrides the moving block over frames [36, 48) only', () => {
    expect(param('block', 35, 'fill')).toBe('#7fb069');
    expect(param('block', 36, 'fill')).toBe('#e0457b');
    expect(param('block', 36, 'wobble')).toBe(10);
    expect(param('block', 47, 'fill')).toBe('#e0457b');
    expect(param('block', 48, 'fill')).toBe('#7fb069');
    expect(param('block', 48, 'wobble')).toBe(0);
    expect(param('block', 47, 'x')).not.toBe(param('block', 36, 'x'));
  });

  it('paints the override colour on the canvas for frames [36, 48) and nowhere else', () => {
    for (let frame = 0; frame < count; frame++) {
      const inside = frame >= 36 && frame < 48;
      expect(fills(layerLogs(frame).get('block') ?? []), `frame ${frame}`).toEqual([inside ? '#e0457b' : '#7fb069']);
    }
  });

  it('steps the star fill instead of blending it', () => {
    expect(param('star', 17, 'fill')).toBe('#f2b134');
    expect(param('star', 18, 'fill')).toBe('#ef7d57');
  });
});
