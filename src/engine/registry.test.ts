import { describe, expect, it } from 'vitest';
import { baseRigId, createRegistry, defaultParams, variantsOf } from './registry';
import type { Rig } from './types';

const noop = () => {};

const dot: Rig = {
  id: 'dot',
  description: 'a dot',
  params: {
    x: { type: 'number', default: 10, min: 0, max: 100 },
    fill: { type: 'color', default: '#ff0000' },
    label: { type: 'string', default: 'hi' },
    mode: { type: 'enum', default: 'a', options: ['a', 'b'] },
    visible: { type: 'boolean', default: true },
  },
  draw: noop,
};
const dotTorn: Rig = { id: 'dot.torn', params: { ...dot.params, tear: { type: 'number', default: 0.5 } }, draw: noop };
const plain: Rig = { id: 'plain', params: {}, draw: noop };

describe('createRegistry', () => {
  it('maps ids to rigs', () => {
    const reg = createRegistry([dot, dotTorn]);
    expect(reg.size).toBe(2);
    expect(reg.get('dot')).toBe(dot);
    expect(reg.get('dot.torn')).toBe(dotTorn);
    expect(reg.get('nope')).toBeUndefined();
    expect([...reg.keys()]).toEqual(['dot', 'dot.torn']);
  });

  it('throws on a duplicate id', () => {
    expect(() => createRegistry([dot, { ...dot }])).toThrow(/duplicate rig id "dot"/);
  });

  it('accepts an empty list', () => {
    expect(createRegistry([]).size).toBe(0);
  });
});

describe('defaultParams', () => {
  it('collects every schema default', () => {
    expect(defaultParams(dot)).toEqual({ x: 10, fill: '#ff0000', label: 'hi', mode: 'a', visible: true });
  });

  it('returns a fresh object each call', () => {
    const a = defaultParams(dot);
    a.x = 99;
    expect(defaultParams(dot).x).toBe(10);
  });

  it('is empty for a rig without params', () => {
    expect(defaultParams(plain)).toEqual({});
  });
});

describe('variants in the registry', () => {
  const body: Rig = {
    id: 'body',
    params: { x: { type: 'number', default: 0 }, pose: { type: 'enum', default: 'idle', options: ['idle', 'walk'] } },
    parts: ['torso', 'head'],
    draw: noop,
  };
  const variant = (id: string, extra: Partial<Rig> = {}): Rig => ({ id, params: { ...body.params }, parts: [...(body.parts ?? [])], draw: noop, ...extra });

  it('accepts a variant that keeps every base param and part, and one that adds some', () => {
    const bandaged = variant('body.bandaged', {
      params: { ...body.params, bandage: { type: 'color', default: '#fff' } },
      parts: ['torso', 'head', 'bandage'],
    });
    const reg = createRegistry([body, bandaged, variant('body.sleepy')]);
    expect([...reg.keys()]).toEqual(['body', 'body.bandaged', 'body.sleepy']);
  });

  it('does not care whether the base comes before or after its variants', () => {
    expect(() => createRegistry([variant('body.late'), body])).not.toThrow();
  });

  it('throws when the base rig is not registered', () => {
    expect(() => createRegistry([variant('body.bandaged')])).toThrow(
      /variant rig "body\.bandaged" needs its base rig "body", which is not registered/,
    );
    expect(() => createRegistry([dot, variant('.odd')])).toThrow(/variant rig "\.odd" needs its base rig ""/);
  });

  it('throws when a variant lacks a base param', () => {
    const { pose: _pose, ...noPose } = body.params;
    expect(() => createRegistry([body, variant('body.stiff', { params: noPose })])).toThrow(
      /variant rig "body\.stiff" lacks param "pose" of its base rig "body"/,
    );
  });

  it('throws when a variant declares a base param with a different type', () => {
    const params = { ...body.params, x: { type: 'string', default: '0' } } as Rig['params'];
    expect(() => createRegistry([body, variant('body.odd', { params })])).toThrow(
      /variant rig "body\.odd" declares param "x" as string, but its base rig "body" declares it as number/,
    );
  });

  it('throws when a variant drops a part the base declares', () => {
    expect(() => createRegistry([body, variant('body.headless', { parts: ['torso'] })])).toThrow(
      /variant rig "body\.headless" drops part "head" of its base rig "body"/,
    );
    expect(() => createRegistry([body, variant('body.blob', { parts: undefined })])).toThrow(
      /drops part "torso".*drops part "head"/s,
    );
  });

  it('lets a variant declare parts its base does not', () => {
    expect(() => createRegistry([dot, { ...dotTorn, parts: ['rip'] }])).not.toThrow();
  });

  it('reports every problem in one error', () => {
    const bad = variant('body.bad', { params: {}, parts: [] });
    let message = '';
    try {
      createRegistry([body, bad, variant('ghost.x')]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/lacks param "x"/);
    expect(message).toMatch(/lacks param "pose"/);
    expect(message).toMatch(/drops part "torso"/);
    expect(message).toMatch(/base rig "ghost", which is not registered/);
  });
});

describe('baseRigId and variantsOf', () => {
  it('splits at the first dot', () => {
    expect(baseRigId('bear')).toBe('bear');
    expect(baseRigId('bear.bandaged')).toBe('bear');
    expect(baseRigId('bear.bandaged.wet')).toBe('bear');
  });

  it('lists the registered variants of a base, not the base or other rigs', () => {
    const reg = createRegistry([dot, dotTorn, plain, { ...dotTorn, id: 'dot.wet' }]);
    expect(variantsOf(reg, 'dot').map((r) => r.id)).toEqual(['dot.torn', 'dot.wet']);
    expect(variantsOf(reg, 'plain')).toEqual([]);
    expect(variantsOf(reg, 'ghost')).toEqual([]);
  });
});
