/**
 * The rig rules from docs/SCENES.md, "Rig rules". Hit testing draws one layer,
 * or one part of a layer, into a 1x1 probe translated so the clicked pixel
 * lands at (0, 0), and selection masks draw a layer or some of its parts on
 * their own. Both only work if every rig follows these rules:
 *
 * 1. No setTransform, resetTransform or reset, and no ctx.canvas.
 * 2. A rig that declares parts wraps every paint call in kit.part, with an id
 *    from its parts list, and parts do not nest.
 * 3. Parts are independent: drawing only part p paints exactly p's marks from
 *    the full draw.
 * 4. Inside parts, only source-over or a blend mode; nothing that reads the
 *    destination the way source-atop or destination-out do.
 */
import { describe, expect, it } from 'vitest';
import type { Params, Rig } from '../engine/types';
import { BEAR_EXPRESSIONS, BEAR_POSES } from './bear';
import { allRigs } from './index';
import { ALLOWED_COMPOSITES, drawRecorded, isPaint, marksOf, partEntries, withParts, type DrawOptions } from './testing/parts';

/** The draws each rig is checked with: defaults at two times, and for the bears every pose and expression. */
function cases(rig: Rig): DrawOptions[] {
  const out: DrawOptions[] = [{ t: 0 }, { t: 1.3 }];
  if ('pose' in rig.params && 'expression' in rig.params) {
    for (const pose of BEAR_POSES) {
      for (const expression of BEAR_EXPRESSIONS) out.push({ t: 0.75, params: { pose, expression } });
    }
    out.push({ t: 2.2, params: { blink: 1, breath: 2 } });
    out.push({ t: 0.4, params: { pose: 'wave', wavePaw: 'left', bodyLength: 2.2 } });
  }
  return out;
}

const label = (o: DrawOptions) => `t=${o.t ?? 0} ${JSON.stringify(o.params ?? {})}`;
const withParts_ = allRigs.filter((rig) => (rig.parts?.length ?? 0) > 0);

describe('rule 1: no absolute transforms, no ctx.canvas', () => {
  it.each(allRigs.map((rig) => [rig.id, rig] as const))('%s', (_id, rig) => {
    for (const o of cases(rig)) {
      const { log } = drawRecorded(rig, o);
      const bad = log.filter((e) => e.op === 'call' && ['setTransform', 'resetTransform', 'reset'].includes(e.name));
      expect(bad.map((e) => e.op === 'call' && e.name), label(o)).toEqual([]);
    }
  });
});

describe('rule 2: every paint call sits in exactly one declared part', () => {
  it('the bear declares parts, so these rules apply to it', () => {
    expect(withParts_.map((rig) => rig.id)).toEqual(expect.arrayContaining(['bear', 'bear.bandaged']));
  });

  it.each(withParts_.map((rig) => [rig.id, rig] as const))('%s', (_id, rig) => {
    for (const o of cases(rig)) {
      const { log, kitErrors } = drawRecorded(rig, o);
      expect(kitErrors, label(o)).toEqual([]);
      const outside = withParts(log).filter((x) => x.part === undefined && isPaint(x.entry));
      expect(outside.map((x) => x.entry.op === 'call' && x.entry.name), `${label(o)}: paint outside any part`).toEqual([]);
    }
  });

  it.each(withParts_.map((rig) => [rig.id, rig] as const))('%s paints something in every part it declares', (_id, rig) => {
    const seen = new Set<string>();
    for (const o of cases(rig)) {
      for (const x of withParts(drawRecorded(rig, o).log)) if (x.part && isPaint(x.entry)) seen.add(x.part);
    }
    expect([...seen].sort()).toEqual([...(rig.parts ?? [])].sort());
  });
});

describe('rule 3: drawing one part alone paints exactly its marks from the full draw', () => {
  /** Fewer cases than the other rules: each one draws the rig once per part. */
  function partCases(rig: Rig): DrawOptions[] {
    const out: DrawOptions[] = [{ t: 0 }];
    if ('pose' in rig.params) {
      for (const pose of BEAR_POSES) out.push({ t: 0.6, params: { pose } });
      for (const expression of BEAR_EXPRESSIONS) out.push({ t: 1.1, params: { expression, blink: 0.5 } });
      out.push({ t: 3.7, params: { pose: 'cheer', blink: 1, breath: 3, bodyLength: 1.8 } });
    }
    return out;
  }

  it.each(withParts_.map((rig) => [rig.id, rig] as const))('%s', (_id, rig) => {
    for (const o of partCases(rig)) {
      const full = drawRecorded(rig, o).log;
      for (const part of rig.parts ?? []) {
        const alone = drawRecorded(rig, { ...o, only: [part] }).log;
        const want = marksOf(partEntries(full, part));
        expect(marksOf(partEntries(alone, part)) === want, `${label(o)}: part "${part}"`).toBe(true);
        // onlyParts skips every other part, so nothing else may paint.
        const others = withParts(alone).filter((x) => x.part !== part && isPaint(x.entry));
        expect(others.length, `${label(o)}: only "${part}" paints`).toBe(0);
      }
    }
  });
});

describe('rule 4: no destination-reading composite inside parts', () => {
  it.each(withParts_.map((rig) => [rig.id, rig] as const))('%s', (_id, rig) => {
    for (const o of cases(rig)) {
      const bad = new Set<string>();
      for (const e of drawRecorded(rig, o).log) {
        if (!isPaint(e) || e.op !== 'call') continue;
        const comp = String(e.paint?.props?.globalCompositeOperation ?? 'source-over');
        if (!ALLOWED_COMPOSITES.has(comp)) bad.add(`${e.name} with ${comp}`);
      }
      expect([...bad], label(o)).toEqual([]);
    }
  });
});

describe('the rule checks catch rule breakers', () => {
  const base: Omit<Rig, 'draw'> = { id: 'bad', description: 'test', params: {}, parts: ['a', 'b'] };
  const run = (draw: Rig['draw'], params: Params = {}) => drawRecorded({ ...base, draw }, { params });

  it('sees paint outside a part', () => {
    const { log } = run((ctx, _p, _t, _r, _s, kit) => {
      kit.part('a', () => ctx.fillRect(0, 0, 1, 1));
      ctx.fillRect(0, 0, 2, 2);
    });
    expect(withParts(log).filter((x) => x.part === undefined && isPaint(x.entry))).toHaveLength(1);
  });

  it('sees nested and undeclared parts', () => {
    const { kitErrors } = run((ctx, _p, _t, _r, _s, kit) => {
      kit.part('a', () => kit.part('b', () => ctx.fill()));
      kit.part('z', () => ctx.fill());
    });
    expect(kitErrors).toHaveLength(2);
  });

  it('sees a part that leans on state set by another part', () => {
    const draw: Rig['draw'] = (ctx, _p, _t, _r, _s, kit) => {
      kit.part('a', () => {
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 1, 1);
      });
      kit.part('b', () => ctx.fillRect(1, 1, 1, 1));
    };
    const full = drawRecorded({ ...base, draw }).log;
    const alone = drawRecorded({ ...base, draw }, { only: ['b'] }).log;
    expect(marksOf(partEntries(alone, 'b'))).not.toBe(marksOf(partEntries(full, 'b')));
  });

  it('ignores state a paint call does not use', () => {
    const draw: Rig['draw'] = (ctx, _p, _t, _r, _s, kit) => {
      kit.part('a', () => {
        ctx.lineCap = 'round';
        ctx.stroke();
      });
      kit.part('b', () => {
        ctx.fillStyle = 'red';
        ctx.fillRect(1, 1, 1, 1);
      });
    };
    const full = drawRecorded({ ...base, draw }).log;
    const alone = drawRecorded({ ...base, draw }, { only: ['b'] }).log;
    expect(marksOf(partEntries(alone, 'b'))).toBe(marksOf(partEntries(full, 'b')));
  });
});
