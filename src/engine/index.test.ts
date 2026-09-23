import { describe, expect, it } from 'vitest';
import * as engine from './index';

describe('engine index', () => {
  it('re-exports the public API', () => {
    const functions = [
      'frameToTime', 'timeToFrame', 'frameCount', 'quantizeTime',
      'formatTimecode', 'parseTimecode',
      'ease',
      'createRng',
      'evaluateTrack', 'evaluateTracks',
      'activeOverride',
      'createRegistry', 'defaultParams', 'baseRigId', 'variantsOf',
      'sceneLayers', 'resolveLayer',
      'render', 'drawLayer', 'assertFrame', 'resetContextState',
      'onlyParts',
      'hitTest',
      'validateScene',
    ];
    for (const name of functions) {
      expect(typeof (engine as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(typeof engine.PASS_THROUGH.part).toBe('function');
    expect(engine.BACKGROUND_ID).toBe('background');
    expect(engine.EASING_NAMES).toContain('inOutCubic');
    expect(typeof engine.easings.linear).toBe('function');
  });

  it('does not ship the test-only recording context', () => {
    expect(Object.keys(engine)).not.toContain('createRecordingContext');
  });

  it('works end to end: validate, then render every frame', () => {
    const registry = engine.createRegistry([
      { id: 'box', params: { x: { type: 'number', default: 0 } }, draw: (ctx, p) => ctx.fillRect(Number(p.x), 0, 1, 1) },
    ]);
    const result = engine.validateScene(
      {
        id: 'e2e',
        fps: 12,
        duration: 1,
        size: [10, 10],
        seed: 1,
        layers: [{ id: 'b', rig: 'box', tracks: [{ param: 'x', keys: [{ t: 0, v: 0 }, { t: 1, v: 9 }] }] }],
      },
      registry,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const xs: number[] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get: (_t, prop) =>
        prop === 'fillRect' ? (x: number) => xs.push(x) : prop === 'getLineDash' ? () => [] : () => undefined,
      set: () => true,
    });
    for (let f = 0; f < engine.frameCount(result.scene); f++) engine.render(ctx, result.scene, f, registry);
    expect(xs).toHaveLength(12);
    expect(xs[0]).toBe(0);
    expect(xs[6]).toBe(4.5);
  });
});
