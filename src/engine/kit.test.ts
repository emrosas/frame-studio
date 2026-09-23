import { describe, expect, it } from 'vitest';
import { onlyParts, PASS_THROUGH } from './kit';
import { createRegistry } from './registry';
import { drawLayer } from './render';
import { sceneLayers } from './resolve';
import { createRecordingContext, type LogEntry } from './testing/recording-context';
import type { DrawKit, Rig, Scene } from './types';

function calls(kit: DrawKit, ids: string[]): string[] {
  const drawn: string[] = [];
  for (const id of ids) kit.part(id, () => drawn.push(id));
  return drawn;
}

describe('PASS_THROUGH', () => {
  it('draws every part once, synchronously, in order', () => {
    expect(calls(PASS_THROUGH, ['body', 'eye', 'body', 'unknown'])).toEqual(['body', 'eye', 'body', 'unknown']);
  });

  it('lets an error from the part escape', () => {
    expect(() =>
      PASS_THROUGH.part('body', () => {
        throw new Error('part broke');
      }),
    ).toThrow('part broke');
  });
});

describe('onlyParts', () => {
  it('draws only the named parts', () => {
    expect(calls(onlyParts(['eye']), ['body', 'eye', 'arm', 'eye'])).toEqual(['eye', 'eye']);
    expect(calls(onlyParts(['eye', 'arm']), ['body', 'eye', 'arm'])).toEqual(['eye', 'arm']);
  });

  it('draws nothing for an empty list, and ignores ids the rig never uses', () => {
    expect(calls(onlyParts([]), ['body', 'eye'])).toEqual([]);
    expect(calls(onlyParts(['tail']), ['body', 'eye'])).toEqual([]);
  });

  it('copies the id list, so later changes to the array do not leak in', () => {
    const ids = ['eye'];
    const kit = onlyParts(ids);
    ids.push('body');
    expect(calls(kit, ['body', 'eye'])).toEqual(['eye']);
  });
});

describe('kits through drawLayer', () => {
  /** body and eye inside parts, plus one mark outside any part. */
  const face: Rig = {
    id: 'face',
    params: {},
    parts: ['body', 'eye'],
    draw(ctx, _p, _t, _rng, _stage, kit) {
      kit.part('body', () => {
        ctx.fillStyle = '#884400';
        ctx.fillRect(0, 0, 20, 20);
      });
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 30, 5, 5); // outside any part
      kit.part('eye', () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(5, 5, 3, 3);
      });
    },
  };
  const registry = createRegistry([face]);
  const scene: Scene = { id: 'kit', fps: 12, duration: 1, size: [40, 40], seed: 1, layers: [{ id: 'f', rig: 'face' }] };
  const layer = sceneLayers(scene)[0];

  const paints = (kit?: DrawKit) => {
    const rec = createRecordingContext(40, 40);
    drawLayer(rec.ctx, scene, layer, 0, registry, kit);
    return rec.log.filter((e): e is Extract<LogEntry, { op: 'call' }> => e.op === 'call' && e.paint !== undefined);
  };
  const rects = (kit?: DrawKit) => paints(kit).map((e) => e.args);

  it('the default kit is PASS_THROUGH: every part draws', () => {
    expect(rects()).toEqual([[0, 0, 20, 20], [0, 30, 5, 5], [5, 5, 3, 3]]);
    expect(paints(PASS_THROUGH)).toEqual(paints());
  });

  it('onlyParts keeps the named parts and every mark outside a part', () => {
    expect(rects(onlyParts(['eye']))).toEqual([[0, 30, 5, 5], [5, 5, 3, 3]]);
    expect(rects(onlyParts(['body']))).toEqual([[0, 0, 20, 20], [0, 30, 5, 5]]);
    expect(rects(onlyParts([]))).toEqual([[0, 30, 5, 5]]);
  });

  it('a part drawn alone paints with the same state as in the full draw', () => {
    const full = paints();
    const eyeAlone = paints(onlyParts(['eye']));
    expect(eyeAlone[1]).toEqual(full[2]);
  });
});
