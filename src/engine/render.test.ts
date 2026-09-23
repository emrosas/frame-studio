import { describe, expect, it } from 'vitest';
import { onlyParts, PASS_THROUGH } from './kit';
import { createRegistry } from './registry';
import { drawLayer, render, resetContextState } from './render';
import { sceneLayers } from './resolve';
import { createRng } from './rng';
import { frameCount } from './time';
import { createRecordingContext, DEFAULT_PROPS, splitLayerLogs, type LogEntry } from './testing/recording-context';
import type { DrawKit, Params, Rig, Scene, Stage } from './types';

/** Sets a pile of state and never cleans up, leaves a clip and an open path whose coordinates depend on t. */
const leaky: Rig = {
  id: 'leaky',
  params: {},
  draw(ctx, _p, t) {
    ctx.fillStyle = '#ff0000';
    ctx.strokeStyle = '#00ff00';
    ctx.globalAlpha = 0.3;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'bevel';
    ctx.miterLimit = 2;
    ctx.setLineDash([4, 2]);
    ctx.lineDashOffset = 3;
    ctx.shadowBlur = 5;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.shadowColor = 'red';
    ctx.filter = 'blur(2px)';
    ctx.font = '40px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.imageSmoothingEnabled = false;
    ctx.translate(100, 50);
    ctx.rotate(t);
    ctx.scale(2, 2);
    ctx.rect(0, 0, 10, 10);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(t * 10, 0);
    ctx.lineTo(t * 20, 5); // left open on purpose
  },
};

/** Paints using whatever state it inherits, so the log shows any leak. Uses params, t, rng, and stage. */
const probe: Rig = {
  id: 'probe',
  params: {
    x: { type: 'number', default: 0 },
    label: { type: 'string', default: 'a' },
  },
  draw(ctx, p, t, rng, stage) {
    ctx.fill(); // no beginPath: uses whatever path is current
    ctx.fillRect(Number(p.x), rng.next() * stage.height, 10, 10);
    ctx.beginPath();
    ctx.arc(t * 10, rng.range(0, stage.width), 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(String(p.label), 0, 0);
  },
};

const registry = createRegistry([leaky, probe]);

const scene: Scene = {
  id: 'determinism',
  fps: 12,
  duration: 2,
  size: [320, 180],
  seed: 7,
  background: { rig: 'probe', params: { label: 'bg' } },
  layers: [
    {
      id: 'a',
      rig: 'probe',
      stepFps: 6,
      tracks: [{ param: 'x', keys: [{ t: 0, v: 0 }, { t: 2, v: 300, ease: 'inOutCubic' }] }],
      overrides: [{ from: 6, to: 10, params: { label: 'override' } }], // even bounds keep the 2k/2k+1 pairs together
    },
    { id: 'mess', rig: 'leaky' },
    { id: 'b', rig: 'probe', params: { label: 'b' } },
    { id: 'mess2', rig: 'leaky', overrides: [{ from: 10, to: 12, rig: 'probe' }] },
  ],
};

const N = frameCount(scene);

function renderLog(frame: number): LogEntry[] {
  const rec = createRecordingContext(320, 180);
  render(rec.ctx, scene, frame, registry);
  return rec.log;
}

describe('render determinism', () => {
  it('frame N rendered fresh equals frame N rendered after frames 0..N-1 on the same context', () => {
    const rec = createRecordingContext(320, 180);
    for (let f = 0; f < N; f++) {
      rec.clearLog();
      render(rec.ctx, scene, f, registry);
      expect(rec.log, `frame ${f}`).toEqual(renderLog(f));
    }
  });

  it('seeking in any order gives the same log as a fresh render', () => {
    const rec = createRecordingContext(320, 180);
    for (const f of [17, 3, 3, 23, 0, 11, 10, 5, 4, 22]) {
      rec.clearLog();
      render(rec.ctx, scene, f, registry);
      expect(rec.log, `frame ${f}`).toEqual(renderLog(f));
    }
  });

  it('actually animates: different frames produce different logs', () => {
    expect(renderLog(0)).not.toEqual(renderLog(2));
  });

  it('a stepFps 6 layer at fps 12 draws identically on frames 2k and 2k+1', () => {
    for (let k = 0; k < N / 2; k++) {
      const layerA0 = splitLayerLogs(renderLog(2 * k))[1];
      const layerA1 = splitLayerLogs(renderLog(2 * k + 1))[1];
      expect(layerA1, `frames ${2 * k} and ${2 * k + 1}`).toEqual(layerA0);
    }
  });

  it('a dirty context produces the same draw log as a clean one', () => {
    const clean = createRecordingContext(320, 180);
    const dirty = createRecordingContext(320, 180);
    dirty.ctx.fillStyle = '#123456';
    dirty.ctx.strokeStyle = '#abcdef';
    dirty.ctx.globalAlpha = 0.25;
    dirty.ctx.lineWidth = 17;
    dirty.ctx.filter = 'blur(4px)';
    dirty.ctx.globalCompositeOperation = 'xor';
    dirty.ctx.setLineDash([1, 1]);
    dirty.ctx.shadowBlur = 3;
    dirty.ctx.font = '99px monospace';
    dirty.ctx.moveTo(5, 5);
    dirty.ctx.lineTo(50, 50); // an open path left by the caller
    const before = dirty.state();

    for (const f of [0, 6, 11, 23]) {
      clean.clearLog();
      dirty.clearLog();
      render(clean.ctx, scene, f, registry);
      render(dirty.ctx, scene, f, registry);
      const cleanLayers = splitLayerLogs(clean.log);
      const dirtyLayers = splitLayerLogs(dirty.log);
      expect(dirtyLayers.length).toBe(5);
      expect(dirtyLayers).toEqual(cleanLayers);
      expect(dirty.log).toEqual(clean.log);
    }
    // render leaves the caller's state as it found it
    expect(dirty.state()).toEqual(before);
  });

  it('keeps the save stack balanced', () => {
    const rec = createRecordingContext();
    rec.ctx.save();
    render(rec.ctx, scene, 4, registry);
    expect(rec.saveDepth()).toBe(1);
  });
});

describe('drawLayer', () => {
  const layers = sceneLayers(scene);

  function layerLog(index: number, frame: number, ctx = createRecordingContext(320, 180)): LogEntry[] {
    ctx.clearLog();
    drawLayer(ctx.ctx, scene, layers[index], frame, registry);
    return ctx.log;
  }

  it('draws exactly the slice of the full render that belongs to the layer', () => {
    for (const f of [0, 5, 6, 10, 11, 23]) {
      const slices = splitLayerLogs(renderLog(f));
      expect(slices).toHaveLength(layers.length);
      layers.forEach((layer, i) => {
        const log = layerLog(i, f);
        expect(log[0], `${layer.id} @ ${f}`).toEqual({ op: 'call', name: 'save', args: [] });
        expect(log[log.length - 1], `${layer.id} @ ${f}`).toEqual({ op: 'call', name: 'restore', args: [] });
        expect(log.slice(1, -1), `${layer.id} @ ${f}`).toEqual(slices[i]);
      });
    }
  });

  it('honours stepFps and overrides: it resolves the layer the same way render does', () => {
    // layer "a" holds on twos, so frames 2 and 3 match; its override swaps the label on frames 6 to 9
    expect(layerLog(1, 3)).toEqual(layerLog(1, 2));
    expect(layerLog(1, 4)).not.toEqual(layerLog(1, 3));
    expect(JSON.stringify(layerLog(1, 6))).toContain('"override"');
    expect(JSON.stringify(layerLog(1, 10))).not.toContain('"override"');
    // mess2 swaps from leaky to probe on frames 10 and 11
    expect(layerLog(4, 10).slice(1, -1)).toEqual(splitLayerLogs(renderLog(10))[4]);
    expect(layerLog(4, 10)).not.toEqual(layerLog(4, 9));
  });

  it('gives the same log on a dirty context and leaves the caller state as it found it', () => {
    const dirty = createRecordingContext(320, 180);
    dirty.ctx.fillStyle = '#123456';
    dirty.ctx.globalAlpha = 0.2;
    dirty.ctx.globalCompositeOperation = 'destination-out';
    dirty.ctx.filter = 'blur(3px)';
    dirty.ctx.moveTo(1, 1);
    dirty.ctx.lineTo(9, 9);
    const before = dirty.state();
    for (let i = 0; i < layers.length; i++) {
      expect(layerLog(i, 7, dirty), layers[i].id).toEqual(layerLog(i, 7));
      expect(dirty.state(), layers[i].id).toEqual(before);
      expect(dirty.saveDepth()).toBe(0);
    }
  });

  it('a leaky layer does not change the layer drawn after it', () => {
    const rec = createRecordingContext(320, 180);
    layerLog(2, 5, rec); // mess, the leaky rig
    expect(layerLog(3, 5, rec)).toEqual(layerLog(3, 5));
  });

  it('keeps the caller transform as the base, so a translated probe sees the layer shifted', () => {
    const rec = createRecordingContext(320, 180);
    rec.ctx.setTransform(1, 0, 0, 1, -40, -25);
    const log = layerLog(3, 0, rec);
    const paint = log.find((e) => e.op === 'call' && e.name === 'fillRect');
    expect(paint?.op === 'call' && paint.paint?.transform).toEqual([1, 0, 0, 1, -40, -25]);
  });

  it('passes the kit through to the rig, PASS_THROUGH by default', () => {
    const seen: DrawKit[] = [];
    const spyKit: Rig = { id: 'spyKit', params: {}, draw: (_c, _p, _t, _r, _s, kit) => void seen.push(kit) };
    const reg = createRegistry([spyKit]);
    const s: Scene = { ...scene, background: undefined, layers: [{ id: 'k', rig: 'spyKit' }] };
    const custom = onlyParts(['x']);
    drawLayer(createRecordingContext().ctx, s, s.layers[0], 0, reg);
    drawLayer(createRecordingContext().ctx, s, s.layers[0], 0, reg, custom);
    render(createRecordingContext().ctx, s, 0, reg);
    expect(seen).toEqual([PASS_THROUGH, custom, PASS_THROUGH]);
    expect(seen[0]).toBe(PASS_THROUGH);
    expect(seen[1]).toBe(custom);
  });

  it('restores the context when the rig throws', () => {
    const boom: Rig = {
      id: 'boom',
      params: {},
      draw(ctx) {
        ctx.translate(3, 3);
        ctx.fillStyle = 'red';
        throw new Error('rig exploded');
      },
    };
    const s: Scene = { ...scene, background: undefined, layers: [{ id: 'x', rig: 'boom' }] };
    const rec = createRecordingContext();
    const before = rec.state();
    expect(() => drawLayer(rec.ctx, s, s.layers[0], 0, createRegistry([boom]))).toThrow('rig exploded');
    expect(rec.saveDepth()).toBe(0);
    expect(rec.state()).toEqual(before);
  });

  it.each([-1, 0.5, Number.NaN, Infinity, N, N + 5])('throws RangeError for frame %s and leaves the context alone', (frame) => {
    const rec = createRecordingContext();
    expect(() => drawLayer(rec.ctx, scene, layers[1], frame, registry)).toThrow(RangeError);
    expect(rec.log).toEqual([]);
  });

  it('accepts the first and last frame', () => {
    expect(() => drawLayer(createRecordingContext().ctx, scene, layers[1], 0, registry)).not.toThrow();
    expect(() => drawLayer(createRecordingContext().ctx, scene, layers[1], N - 1, registry)).not.toThrow();
  });
});

describe('render contract', () => {
  interface Call {
    id: string;
    params: Params;
    t: number;
    rand: number;
    stage: Stage;
    transform: number[];
  }
  const calls: Call[] = [];
  const spy: Rig = {
    id: 'spy',
    params: { n: { type: 'number', default: 1 } },
    draw(ctx, params, t, rng, stage) {
      const m = ctx.getTransform();
      calls.push({ id: String(params.name), params: { ...params }, t, rand: rng.next(), stage, transform: [m.a, m.b, m.c, m.d, m.e, m.f] });
    },
  };
  const boom: Rig = {
    id: 'boom',
    params: {},
    draw(ctx) {
      ctx.fillStyle = 'red';
      ctx.translate(5, 5);
      throw new Error('rig exploded');
    },
  };
  const reg = createRegistry([spy, boom]);
  const spyScene: Scene = {
    id: 'spy',
    fps: 12,
    duration: 1,
    size: [640, 360],
    seed: 42,
    background: { rig: 'spy', params: { name: 'bg' } },
    layers: [
      { id: 'one', rig: 'spy', params: { name: 'one' }, stepFps: 6 },
      { id: 'two', rig: 'spy', params: { name: 'two', n: 5 } },
    ],
  };

  it('clears the stage, then draws background then layers in order with resolved inputs', () => {
    calls.length = 0;
    const rec = createRecordingContext(640, 360);
    render(rec.ctx, spyScene, 3, reg);
    expect(rec.log[0]).toEqual({ op: 'call', name: 'save', args: [] });
    expect(rec.log[1]).toMatchObject({ op: 'call', name: 'clearRect', args: [0, 0, 640, 360] });
    expect(calls.map((c) => c.id)).toEqual(['bg', 'one', 'two']);
    expect(calls[0].t).toBe(3 / 12);
    expect(calls[1].t).toBe(2 / 12); // stepFps 6 holds frame 3 at frame 2's time
    expect(calls[2].params).toEqual({ n: 5, name: 'two' });
    for (const c of calls) expect(c.stage).toEqual({ width: 640, height: 360 });
  });

  it('seeds each layer with createRng(scene.seed, layer.id)', () => {
    calls.length = 0;
    render(createRecordingContext().ctx, spyScene, 0, reg);
    expect(calls[0].rand).toBe(createRng(42, 'background').next());
    expect(calls[1].rand).toBe(createRng(42, 'one').next());
    expect(calls[2].rand).toBe(createRng(42, 'two').next());
    expect(calls[1].rand).not.toBe(calls[2].rand);
  });

  it('leaves the base transform to the caller', () => {
    calls.length = 0;
    const rec = createRecordingContext(1280, 720);
    rec.ctx.setTransform(2, 0, 0, 2, 0, 0);
    render(rec.ctx, spyScene, 0, reg);
    for (const c of calls) expect(c.transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(rec.state().transform).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('propagates a rig error and still restores the context', () => {
    const rec = createRecordingContext();
    const before = rec.state();
    const bad: Scene = { ...spyScene, layers: [{ id: 'x', rig: 'boom' }] };
    expect(() => render(rec.ctx, bad, 0, reg)).toThrow('rig exploded');
    expect(rec.saveDepth()).toBe(0);
    expect(rec.state()).toEqual(before);
  });

  it('throws when a layer rig is missing from the registry', () => {
    const bad: Scene = { ...spyScene, layers: [{ id: 'ghostly', rig: 'ghost' }] };
    expect(() => render(createRecordingContext().ctx, bad, 0, reg)).toThrow(/"ghostly".*"ghost"/);
  });

  it.each([-1, 1.5, Number.NaN, Infinity, -Infinity, 12, 13, 1000])('throws RangeError for frame %s', (frame) => {
    expect(() => render(createRecordingContext().ctx, spyScene, frame, reg)).toThrow(RangeError);
  });

  it('accepts the first and last frame', () => {
    expect(() => render(createRecordingContext().ctx, spyScene, 0, reg)).not.toThrow();
    expect(() => render(createRecordingContext().ctx, spyScene, 11, reg)).not.toThrow();
  });

  it('does not touch the context when the frame is out of range', () => {
    const rec = createRecordingContext();
    expect(() => render(rec.ctx, spyScene, 12, reg)).toThrow(RangeError);
    expect(rec.log).toEqual([]);
  });
});

describe('resetContextState', () => {
  it('restores every listed property to its default and leaves the transform alone', () => {
    const rec = createRecordingContext();
    const { ctx } = rec;
    ctx.setTransform(3, 0, 0, 3, 7, 9);
    leaky.draw(ctx, {}, 0.5, createRng(1, 'x'), { width: 10, height: 10 }, PASS_THROUGH);
    const transform = rec.state().transform;
    resetContextState(ctx);
    const s = rec.state();
    expect(s.transform).toEqual(transform);
    expect(s.lineDash).toEqual([]);
    expect(s.props).toMatchObject({
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '#000000',
      strokeStyle: '#000000',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      miterLimit: 10,
      lineDashOffset: 0,
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowColor: 'rgba(0,0,0,0)',
      filter: 'none',
      font: '10px sans-serif',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      imageSmoothingEnabled: true,
    });
  });

  it('resets every drawing property the recording context tracks, newer text and smoothing ones included', () => {
    const dirty: Record<string, unknown> = {
      globalAlpha: 0.5,
      globalCompositeOperation: 'multiply',
      fillStyle: '#123456',
      strokeStyle: '#654321',
      lineWidth: 3,
      lineCap: 'round',
      lineJoin: 'bevel',
      miterLimit: 4,
      lineDashOffset: 2,
      shadowBlur: 3,
      shadowOffsetX: 1,
      shadowOffsetY: 1,
      shadowColor: 'red',
      filter: 'blur(1px)',
      font: '20px serif',
      textAlign: 'center',
      textBaseline: 'top',
      direction: 'rtl',
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'high',
      letterSpacing: '2px',
      wordSpacing: '3px',
      fontKerning: 'none',
      fontStretch: 'condensed',
      fontVariantCaps: 'small-caps',
      textRendering: 'optimizeSpeed',
    };
    // A property added to DEFAULT_PROPS needs a dirty value here too.
    expect(Object.keys(dirty).sort()).toEqual(Object.keys(DEFAULT_PROPS).sort());
    for (const [name, value] of Object.entries(dirty)) expect(value, name).not.toEqual(DEFAULT_PROPS[name]);

    const rec = createRecordingContext();
    Object.assign(rec.ctx, dirty);
    resetContextState(rec.ctx);
    // reset writes 'rgba(0,0,0,0)'; the spec default reads back as 'rgba(0, 0, 0, 0)'.
    const normalise = (props: Record<string, unknown>) => ({ ...props, shadowColor: String(props.shadowColor).replace(/\s/g, '') });
    expect(normalise(rec.state().props)).toEqual(normalise({ ...DEFAULT_PROPS }));
  });

  it('starts a fresh path so an open path from earlier drawing cannot leak', () => {
    const rec = createRecordingContext();
    rec.ctx.moveTo(1, 1);
    rec.ctx.lineTo(2, 2);
    resetContextState(rec.ctx);
    rec.ctx.fill();
    const last = rec.log[rec.log.length - 1];
    expect(last.op === 'call' && last.paint?.path).toEqual([]);
  });
});
