import { describe, expect, it } from 'vitest';
import bearsJson from '../../scenes/bears.json';
import bearTestJson from '../../scenes/bear-test.json';
import { PASS_THROUGH, createRng, frameCount, onlyParts, render, resolveLayer, sceneLayers, validateScene, type Scene } from '../engine';
import { createRecordingContext, type LogEntry } from '../engine/testing/recording-context';
import type { Params } from '../engine/types';
import { BEAR_EXPRESSIONS, BEAR_POSES, bear } from './bear';
import { bearBandaged } from './bear-bandaged';
import { createDefaultRegistry } from './index';
import { drawRecorded, marksOf, partEntries, unmarked, withParts, withoutPart } from './testing/parts';

const registry = createDefaultRegistry();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadScene(json: unknown): Scene {
  const result = validateScene(json, registry);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.scene;
}

const logOf = (params: Params = {}, t = 0) => JSON.stringify(unmarked(drawRecorded(bear, { params, t }).log));

/** The parts whose marks differ between two draws. */
function changedParts(a: readonly LogEntry[], b: readonly LogEntry[]): string[] {
  return (bear.parts ?? []).filter((part) => marksOf(partEntries(a, part)) !== marksOf(partEntries(b, part)));
}

/**
 * The marks as the bear sees them in its own frame: transforms are dropped,
 * so a bear that only moved (x, y, breath) gives the same string.
 */
function localMarks(entries: readonly LogEntry[]): string {
  const out: unknown[] = [];
  for (const e of entries) {
    if (e.op !== 'call' || !e.paint) continue;
    out.push([e.name, e.args, e.paint.props, e.paint.path?.map((s) => [s.name, s.args]), e.paint.clips.map((c) => c.path.map((s) => [s.name, s.args]))]);
  }
  return JSON.stringify(out);
}

describe('bears.json, the look the user approved', () => {
  // Recorded before M2 changed the bear (2026-09-23): sha256 of JSON.stringify(log) for frame 0.
  const PINNED_FRAME = '2f5639aa4ffcf3d569c004f1c576217bc1ce1afd3954d237ba52d7a404d20363';
  const PINNED_LAYERS: Record<string, string> = {
    background: '5a5c6b4efb0f1ff684d0525fad39e9c16c8f09b534e6d720711101b8aa26b4ea',
    white: 'f2eccf11de178d816f1c9ce1d19246b0909529d9ba916a580f3ffedbcb2db5d6',
    red: '60825ec9145d05c9da96d99ed8a2dd8692d0d97d29ee5713047c1e4616020c45',
    blue: 'f0431acf48384564c9c182e684655aa19edb765899b411caf4cb3a5df7fe1a54',
    yellow: '4cb8ec67a983105cf3a00cf1cd186984b514680ae4105d38d32632bcee1e1bc5',
  };
  const scene = loadScene(bearsJson);

  it('each layer draws the recorded log on frame 0', async () => {
    const got: Record<string, string> = {};
    for (const layer of sceneLayers(scene)) {
      const { rig, params, t, id } = resolveLayer(layer, scene, 0, registry);
      const rec = createRecordingContext();
      rig.draw(rec.ctx, params, t, createRng(scene.seed, id), { width: scene.size[0], height: scene.size[1] }, PASS_THROUGH);
      got[id] = await sha256(JSON.stringify(rec.log));
    }
    expect(got).toEqual(PINNED_LAYERS);
  });

  it('frame 0 renders the recorded log', async () => {
    const rec = createRecordingContext();
    render(rec.ctx, scene, 0, registry);
    expect(await sha256(JSON.stringify(rec.log))).toBe(PINNED_FRAME);
  });
});

describe('parts', () => {
  it('declares the character parts', () => {
    expect(bear.parts).toEqual(['ears', 'body', 'paws', 'muzzle', 'nose', 'eyes', 'mouth']);
  });

  it('puts the cast shadow and body shading in the body part', () => {
    const plain = drawRecorded(bear, { params: { castLeft: 0, castRight: 0, patch: 0, bridge: 0, chin: 0 } }).log;
    const shaded = drawRecorded(bear, { params: { castLeft: 1, castRight: 1, patch: 1, bridge: 1, chin: 1 } }).log;
    expect(changedParts(plain, shaded)).toEqual(['body']);
    const multiplied = withParts(shaded).filter((x) => x.entry.op === 'call' && x.entry.paint?.props?.globalCompositeOperation === 'multiply');
    expect(new Set(multiplied.map((x) => x.part))).toEqual(new Set(['body']));
  });
});

describe('poses', () => {
  it('lists idle, wave, cheer and shy, with idle the default', () => {
    expect(BEAR_POSES).toEqual(['idle', 'wave', 'cheer', 'shy']);
    expect(bear.params.pose).toMatchObject({ type: 'enum', default: 'idle', options: BEAR_POSES });
  });

  it.each(BEAR_POSES.filter((p) => p !== 'idle'))('%s changes the paws and nothing else', (pose) => {
    const idle = drawRecorded(bear, { params: { pose: 'idle' }, t: 0.5 }).log;
    const posed = drawRecorded(bear, { params: { pose }, t: 0.5 }).log;
    expect(logOf({ pose }, 0.5)).not.toBe(logOf({}, 0.5));
    expect(changedParts(idle, posed)).toEqual(['paws']);
  });

  it('draws the paws in the body colour', () => {
    const paws = partEntries(drawRecorded(bear, { params: { body: '#123456' } }).log, 'paws');
    expect(paws.some((e) => e.op === 'call' && e.name === 'fill' && e.paint?.props?.fillStyle === '#123456')).toBe(true);
  });

  it('hides the paws at pawSize 0', () => {
    for (const pose of BEAR_POSES) {
      expect(partEntries(drawRecorded(bear, { params: { pose, pawSize: 0 } }).log, 'paws'), pose).toEqual([]);
    }
  });

  it('waves back and forth on a cycle, and holds still in the other poses', () => {
    const at = (pose: string, t: number) => marksOf(partEntries(drawRecorded(bear, { params: { pose, breath: 0 }, t }).log, 'paws'));
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((f) => at('wave', f / 12));
    expect(new Set(frames).size).toBeGreaterThan(4);
    for (const pose of ['idle', 'cheer', 'shy']) expect(at(pose, 0.25), pose).toBe(at(pose, 1.75));
  });

  it('waves the paw wavePaw names', () => {
    const left = drawRecorded(bear, { params: { pose: 'wave', wavePaw: 'left' } }).log;
    const right = drawRecorded(bear, { params: { pose: 'wave', wavePaw: 'right' } }).log;
    expect(marksOf(partEntries(left, 'paws'))).not.toBe(marksOf(partEntries(right, 'paws')));
  });

  it('seeds the wave phase from the layer', () => {
    const paws = (key: string) => marksOf(partEntries(drawRecorded(bear, { params: { pose: 'wave', breath: 0 }, t: 0.5, key }).log, 'paws'));
    expect(new Set(['a', 'b', 'c', 'd'].map(paws)).size).toBeGreaterThan(1);
  });
});

describe('expressions', () => {
  it('lists neutral, happy, sad and surprised, with neutral the default', () => {
    expect(BEAR_EXPRESSIONS).toEqual(['neutral', 'happy', 'sad', 'surprised']);
    expect(bear.params.expression).toMatchObject({ type: 'enum', default: 'neutral', options: BEAR_EXPRESSIONS });
  });

  it('neutral changes nothing', () => {
    expect(logOf({ expression: 'neutral', browTilt: 20, smileDepth: -0.02 })).toBe(logOf({ browTilt: 20, smileDepth: -0.02 }));
  });

  it.each(BEAR_EXPRESSIONS.filter((e) => e !== 'neutral'))('%s changes only the eyes and mouth', (expression) => {
    const neutral = drawRecorded(bear, { params: { expression: 'neutral' } }).log;
    const other = drawRecorded(bear, { params: { expression } }).log;
    expect(logOf({ expression })).not.toBe(logOf({}));
    expect(changedParts(neutral, other)).toEqual(['eyes', 'mouth']);
  });

  it('builds on the face params, so per-bear tuning still shows', () => {
    for (const expression of BEAR_EXPRESSIONS) {
      expect(logOf({ expression, browTilt: 0 }), expression).not.toBe(logOf({ expression, browTilt: 25 }));
      expect(logOf({ expression, eyeSize: 0.02 }), expression).not.toBe(logOf({ expression, eyeSize: 0.03 }));
    }
  });

  it('the four expressions all differ', () => {
    expect(new Set(BEAR_EXPRESSIONS.map((expression) => logOf({ expression }))).size).toBe(4);
  });
});

describe('blinks', () => {
  const FPS = 12;
  const FRAMES = 8 * FPS;
  /** The eyes' marks at time t; breath off so an open eye draws the same at any time. */
  const eyes = (t: number, params: Params = {}, key = 'layer') =>
    marksOf(partEntries(drawRecorded(bear, { params: { breath: 0, ...params }, t, key, only: ['eyes'] }).log, 'eyes'));
  const closedFrames = (params: Params = {}, key = 'layer') => {
    const open = eyes(0, params, key);
    const out: number[] = [];
    for (let f = 0; f < FRAMES; f++) if (eyes(f / FPS, params, key) !== open) out.push(f);
    return out;
  };

  it('the same t always gives the same eye state, in any order', () => {
    const times = [0.3, 1.7, 2.9, 4.4, 6.1, 7.95];
    const forward = times.map((t) => eyes(t));
    const backward = [...times].reverse().map((t) => eyes(t)).reverse();
    expect(backward).toEqual(forward);
  });

  it('at the default rate, closes the eyes on at least one frame and at most a fifth of frames in 8 s', () => {
    for (const key of ['layer', 'bruno', 'pip', 'a', 'b', 'c']) {
      const closed = closedFrames({}, key);
      expect(closed.length, key).toBeGreaterThanOrEqual(1);
      expect(closed.length, key).toBeLessThanOrEqual(FRAMES / 5);
    }
  });

  it('keeps the eyes open at t = 0, even at the fastest rate', () => {
    const max = (bear.params.blinkRate as { max: number }).max;
    for (const key of ['layer', 'bruno', 'pip', 'a', 'b', 'c', 'd', 'e']) expect(eyes(0, { blinkRate: max }, key), key).toBe(eyes(0, { blinkRate: 0 }, key));
  });

  it('never blinks at blinkRate 0', () => {
    expect(closedFrames({ blinkRate: 0 })).toEqual([]);
  });

  it('blinks more often at a higher rate', () => {
    expect(closedFrames({ blinkRate: 40 }).length).toBeGreaterThan(closedFrames({ blinkRate: 6 }).length);
  });

  it('draws a closed eye as an ink line: no eye white, no pupil dot', () => {
    const open = partEntries(drawRecorded(bear, { params: { blink: 0 } }).log, 'eyes');
    const shut = partEntries(drawRecorded(bear, { params: { blink: 1 } }).log, 'eyes');
    const fills = (entries: LogEntry[]) => entries.filter((e) => e.op === 'call' && e.name === 'fill').map((e) => e.op === 'call' && e.paint?.props?.fillStyle);
    expect(fills(open)).toContain('#fdfcf8');
    expect(fills(shut)).not.toContain('#fdfcf8');
    expect(shut.length).toBeGreaterThan(0);
  });

  it('blink closes the eyes by hand, part way or fully', () => {
    const states = [0, 0.4, 0.7, 1].map((blink) => eyes(0, { blink, blinkRate: 0 }));
    expect(new Set(states).size).toBe(4);
  });

  it('blinks change only the eyes', () => {
    const open = drawRecorded(bear, { params: { blink: 0 } }).log;
    const shut = drawRecorded(bear, { params: { blink: 1 } }).log;
    expect(changedParts(open, shut)).toEqual(['eyes']);
  });
});

describe('breath and placement', () => {
  it('breath bobs the bear over time with a seeded phase, and 0 holds it still', () => {
    expect(logOf({ breath: 0 }, 0.4)).toBe(logOf({ breath: 0 }, 1.9));
    expect(logOf({ breath: 1 }, 0.4)).not.toBe(logOf({ breath: 1 }, 1.9));
    const at = (key: string) => JSON.stringify(unmarked(drawRecorded(bear, { params: { breath: 1 }, t: 0, key }).log).slice(0, 4));
    expect(new Set(['a', 'b', 'c', 'd'].map(at)).size).toBeGreaterThan(1);
  });

  it('with bodyLength set, the paint stays on the body wherever the bear stands or breathes', () => {
    // A stage big enough that no mark falls off it, so nothing is culled.
    const stage = { width: 8000, height: 8000 };
    const local = (params: Params, t: number) =>
      localMarks(unmarked(drawRecorded(bear, { params: { bodyLength: 2.2, ...params }, t, stage }).log));
    const home = local({ x: 700, y: 300, breath: 0 }, 0);
    expect(local({ x: 1300, y: 340, breath: 0 }, 0)).toBe(home);
    expect(local({ x: 4000, y: 1000, breath: 0 }, 0)).toBe(home);
    expect(local({ x: 700, y: 300, breath: 2 }, 1.3)).toBe(home);
  });

  it('with bodyLength set, a bear at the stage edge drops only marks that are off stage', () => {
    // Culling never reorders the rest: every mark the edge bear paints is painted, in order, by the same bear on a big stage.
    const draw = (x: number, stage: { width: number; height: number }) =>
      unmarked(drawRecorded(bear, { params: { bodyLength: 2.2, x, y: 300, breath: 0 }, stage }).log);
    const edge = draw(60, { width: 1920, height: 1080 });
    const whole = draw(60, { width: 1920, height: 8000 });
    const strokes = (log: LogEntry[]) =>
      log.flatMap((e) => (e.op === 'call' && e.name === 'stroke' && e.paint?.props ? [`${e.paint.props.strokeStyle}|${e.paint.props.globalAlpha}|${e.paint.props.lineWidth}`] : []));
    const inEdge = strokes(edge);
    const inWhole = strokes(whole);
    expect(inEdge.length).toBeLessThan(inWhole.length);
    // inEdge is a subsequence of inWhole.
    let j = 0;
    for (const s of inWhole) if (j < inEdge.length && s === inEdge[j]) j++;
    expect(j).toBe(inEdge.length);
  });
});

describe('bear.bandaged', () => {
  it('takes every bear param with the same schema, plus plaster params', () => {
    for (const [name, spec] of Object.entries(bear.params)) expect(bearBandaged.params[name], name).toEqual(spec);
    const extra = Object.keys(bearBandaged.params).filter((name) => !(name in bear.params));
    expect(extra.length).toBeGreaterThanOrEqual(3);
    expect(extra.every((name) => name.startsWith('plaster'))).toBe(true);
    expect(bearBandaged.parts).toEqual([...(bear.parts ?? []), 'plaster']);
  });

  const cases: [string, Params, number][] = [
    ['defaults', {}, 0],
    ['wave, happy', { pose: 'wave', expression: 'happy' }, 0.7],
    ['cheer, surprised, blinking', { pose: 'cheer', expression: 'surprised', blinkRate: 40 }, 2.5],
    ['shy, sad, long body', { pose: 'shy', expression: 'sad', bodyLength: 2, breath: 2 }, 1.1],
    ['bears.json white bear', bearsJson.layers[0].params as unknown as Params, 0],
  ];

  it.each(cases)('draws exactly what bear draws, plus the plaster (%s)', (_name, params, t) => {
    const base = drawRecorded(bear, { params, t }).log;
    const bandaged = drawRecorded(bearBandaged, { params, t }).log;
    expect(JSON.stringify(withoutPart(bandaged, 'plaster'))).toBe(JSON.stringify(unmarked(base)));
    expect(partEntries(bandaged, 'plaster').some((e) => e.op === 'call' && e.name === 'fill')).toBe(true);
  });

  it('moves and colours the plaster with its params', () => {
    const plaster = (params: Params) => marksOf(partEntries(drawRecorded(bearBandaged, { params }).log, 'plaster'));
    const home = plaster({});
    expect(plaster({ plasterX: 0.1 })).not.toBe(home);
    expect(plaster({ plasterAngle: 40 })).not.toBe(home);
    expect(plaster({ plasterColor: '#ffeecc' })).not.toBe(home);
  });
});

describe('scenes/bear-test.json', () => {
  const scene = loadScene(bearTestJson);
  const stage = { width: scene.size[0], height: scene.size[1] };
  const FIXED = ['ears', 'body', 'muzzle', 'nose'];

  /**
   * One layer's marks in its own frame for the parts that no pose, expression
   * or blink touches. Drawn moved onto a huge stage, so no mark is culled at
   * the stage edge (culling only drops marks that are off stage anyway).
   */
  function fixedMarks(layerId: string, frame: number): string {
    const layer = sceneLayers(scene).find((l) => l.id === layerId)!;
    const { rig, params, t, id } = resolveLayer(layer, scene, frame, registry);
    const moved = { ...params, x: (params.x as number) + 5000, y: (params.y as number) + 5000 };
    const rec = createRecordingContext();
    rig.draw(rec.ctx, moved, t, createRng(scene.seed, id), { width: 20000, height: 20000 }, onlyParts(FIXED));
    return localMarks(rec.log);
  }

  it('is 1920x1080 at 12 fps for 8 s, with bruno and pip on an orange paper ground', () => {
    expect(scene.size).toEqual([1920, 1080]);
    expect(scene.fps).toBe(12);
    expect(frameCount(scene)).toBe(96);
    expect(scene.background?.rig).toBe('paper');
    expect(scene.background?.params?.tone).toBe(bearsJson.background.params.tone);
    expect(scene.layers.map((l) => l.id)).toEqual(['bruno', 'pip']);
  });

  it.each(['bruno', 'pip'])('%s keeps the same head, ears, body and muzzle on every frame, override included', (layerId) => {
    const first = fixedMarks(layerId, 0);
    // Every fifth frame, plus the override and pose boundaries.
    const frames = [...Array.from({ length: 19 }, (_, i) => 5 + i * 5), 23, 24, 47, 48, 59, 60, 71, 72, 83, 84, 95];
    const differ = frames.filter((f) => fixedMarks(layerId, f) !== first);
    expect(differ).toEqual([]);
  });

  it('swaps bruno to bear.bandaged on frames [48, 72) only', () => {
    const bruno = scene.layers.find((l) => l.id === 'bruno')!;
    const rigAt = (f: number) => resolveLayer(bruno, scene, f, registry).rig.id;
    expect([47, 48, 71, 72].map(rigAt)).toEqual(['bear', 'bear.bandaged', 'bear.bandaged', 'bear']);
  });

  it('bruno is mid-motion on the early frames', () => {
    const bruno = scene.layers.find((l) => l.id === 'bruno')!;
    const x = (f: number) => resolveLayer(bruno, scene, f, registry).params.x as number;
    expect(x(3)).not.toBe(x(0));
    expect(x(12)).not.toBe(x(3));
    expect(x(24)).toBe(x(30));
  });

  it.each(['bruno', 'pip'])('%s blinks at least once', (layerId) => {
    const layer = scene.layers.find((l) => l.id === layerId)!;
    const eyes = (f: number, extra: Params) => {
      const { rig, params, t, id } = resolveLayer(layer, scene, f, registry);
      const rec = createRecordingContext();
      rig.draw(rec.ctx, { ...params, ...extra }, t, createRng(scene.seed, id), stage, onlyParts(['eyes']));
      return localMarks(rec.log);
    };
    // A frame is a blink when its eyes differ from the same frame with blinks off.
    const closed = Array.from({ length: frameCount(scene) }, (_, f) => f).filter((f) => eyes(f, {}) !== eyes(f, { blinkRate: 0 }));
    expect(closed.length).toBeGreaterThan(0);
  });
});

