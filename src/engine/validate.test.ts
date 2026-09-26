import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry';
import type { Rig, Scene } from './types';
import { validateScene, type ValidationResult } from './validate';

const noop = () => {};
const dot: Rig = {
  id: 'dot',
  params: {
    x: { type: 'number', default: 0 },
    y: { type: 'number', default: 0 },
    fill: { type: 'color', default: '#000' },
    label: { type: 'string', default: '' },
    mode: { type: 'enum', default: 'a', options: ['a', 'b'] },
    visible: { type: 'boolean', default: true },
  },
  draw: noop,
};
/** A variant keeps every base param (createRegistry checks) and adds tear. */
const dotTorn: Rig = {
  id: 'dot.torn',
  params: { ...dot.params, tear: { type: 'number', default: 0.5 } },
  draw: noop,
};
const paper: Rig = { id: 'paper', params: { tone: { type: 'color', default: '#f4efe6' } }, draw: noop };
const registry = createRegistry([dot, dotTorn, paper]);

/** 12 fps * 10 s = 120 frames. */
function validScene(): Scene {
  return {
    id: 'fly-test',
    fps: 12,
    duration: 10,
    size: [1920, 1080],
    seed: 42,
    background: { rig: 'paper', params: { tone: '#f4efe6' } },
    layers: [
      {
        id: 'fly',
        rig: 'dot',
        stepFps: 6,
        params: { x: 400, y: 500, label: 'hi', mode: 'a', visible: true },
        tracks: [
          { param: 'x', keys: [{ t: 0, v: 400 }, { t: 3, v: 1400, ease: 'inOutCubic' }] },
          { param: 'mode', keys: [{ t: 0, v: 'a' }, { t: 3, v: 'b' }] },
        ],
        overrides: [
          { from: 36, to: 48, rig: 'dot.torn', params: { tear: 0.2 } },
          { from: 48, to: 60, params: { visible: false } },
        ],
      },
      { id: 'other', rig: 'dot' },
    ],
    audio: [{ id: 'buzz', generator: 'buzz', start: 3, end: 6, params: { pitch: 220 } }],
  };
}

// any on purpose: these tests poke arbitrary junk into the scene.
type Mutable = Record<string, any>;

function withChange(change: (s: Mutable) => void, reg = registry): string[] {
  const s = validScene() as unknown as Mutable;
  change(s);
  const r = validateScene(s, reg);
  return r.ok ? [] : r.errors;
}

function expectError(errors: string[], path: string, message?: RegExp): void {
  const hits = errors.filter((e) => e.startsWith(`${path}: `));
  expect(hits, `expected an error at "${path}", got:\n${errors.join('\n')}`).not.toHaveLength(0);
  if (message) {
    expect(
      hits.some((e) => message.test(e)),
      `expected an error at "${path}" matching ${message}, got:\n${hits.join('\n')}`,
    ).toBe(true);
  }
}

describe('valid scenes', () => {
  it('passes and returns the scene', () => {
    const scene = validScene();
    const r: ValidationResult = validateScene(scene, registry);
    expect(r).toEqual({ ok: true, scene });
    if (r.ok) expect(r.scene).toBe(scene);
  });

  it('passes without a registry', () => {
    expect(validateScene(validScene()).ok).toBe(true);
  });

  it('passes the minimal scene', () => {
    const r = validateScene({ id: 'a', fps: 1, duration: 0.5, size: [1, 1], seed: 0, layers: [] });
    expect(r.ok).toBe(true);
  });

  it('allows touching overrides [a, b) and [b, c)', () => {
    expect(withChange((s) => (s.layers[0].overrides = [{ from: 0, to: 10 }, { from: 10, to: 20 }]))).toEqual([]);
  });

  it('allows an override ending exactly at frameCount', () => {
    expect(withChange((s) => (s.layers[0].overrides = [{ from: 100, to: 120 }]))).toEqual([]);
  });

  it('allows a fractional stepFps and stepFps equal to fps', () => {
    expect(withChange((s) => (s.layers[0].stepFps = 7.5))).toEqual([]);
    expect(withChange((s) => (s.layers[0].stepFps = 12))).toEqual([]);
  });

  it('allows a scene without background or audio', () => {
    expect(withChange((s) => {
      delete s.background;
      delete s.audio;
    })).toEqual([]);
  });
});

describe('scene-level errors', () => {
  it.each([null, 5, 'scene', [1, 2]])('rejects a non-object scene (%j)', (input) => {
    const r = validateScene(input, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expectError(r.errors, 'scene', /object/);
  });

  it.each([undefined, '', 5])('id %j', (id) => {
    expectError(withChange((s) => (s.id = id)), 'id', /non-empty string/);
  });

  it('keeps "/" out of scene ids, so a loose scene never looks like a project scene', () => {
    expectError(withChange((s) => (s.id = 'bears-story/film')), 'id', /may not contain "\/"/);
  });

  it.each([undefined, 0, -12, 12.5, '12', Number.NaN])('fps %j', (fps) => {
    expectError(withChange((s) => (s.fps = fps)), 'fps', /positive integer/);
  });

  it.each([undefined, 0, -1, Infinity, Number.NaN, '10'])('duration %j', (duration) => {
    expectError(withChange((s) => (s.duration = duration)), 'duration', /positive/);
  });

  it.each([undefined, 'big', [1920], [1920, 1080, 1], [1920, 0], [1920.5, 1080], [-1, 5], ['1920', 1080]])(
    'size %j',
    (size) => {
      expectError(withChange((s) => (s.size = size)), 'size', /two positive integers/);
    },
  );

  it.each([1e-12, 5e-11])('rejects a duration too short to give one frame (%j s)', (duration) => {
    expectError(withChange((s) => (s.duration = duration)), 'duration', /0 frames at 12 fps; use at least 1\/12 s/);
  });

  it.each([undefined, 1.5, '42', Number.NaN])('seed %j', (seed) => {
    expectError(withChange((s) => (s.seed = seed)), 'seed', /integer/);
  });

  it.each([undefined, {}, 'fly'])('layers %j', (layers) => {
    expectError(withChange((s) => (s.layers = layers)), 'layers', /array/);
  });

  it('collects every error instead of stopping at the first', () => {
    const errors = withChange((s) => {
      s.id = '';
      s.fps = 0;
      s.layers[0].rig = '';
      s.layers[1].id = 'background';
      s.layers[0].tracks[0].keys[1].t = -1;
    });
    expectError(errors, 'id');
    expectError(errors, 'fps');
    expectError(errors, 'layers[0].rig');
    expectError(errors, 'layers[1].id');
    expectError(errors, 'layers[0].tracks[0].keys[1].t');
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it('every error has the "path: message" shape', () => {
    const errors = withChange((s) => {
      s.fps = -1;
      s.layers[0].params.x = null;
    });
    for (const e of errors) expect(e).toMatch(/^[\w.[\]]+: \S/);
  });
});

describe('layer errors', () => {
  it('rejects a non-object layer', () => {
    expectError(withChange((s) => (s.layers[1] = 5)), 'layers[1]', /object/);
  });

  it.each([undefined, '', 7])('layer id %j', (id) => {
    expectError(withChange((s) => (s.layers[1].id = id)), 'layers[1].id', /non-empty string/);
  });

  it('rejects duplicate layer ids', () => {
    expectError(withChange((s) => (s.layers[1].id = 'fly')), 'layers[1].id', /duplicate.*"fly".*layers\[0\]/);
  });

  it('reserves the background id', () => {
    expectError(withChange((s) => (s.layers[1].id = 'background')), 'layers[1].id', /reserved/);
  });

  it('rejects "/" in a layer id, which would share RNG streams with another layer', () => {
    // Layer "fly/wing" would draw from the same stream as layer "fly" forking "wing".
    expectError(withChange((s) => (s.layers[1].id = 'fly/wing')), 'layers[1].id', /may not contain "\/"/);
  });

  it.each(['', 3])('layer rig %j', (rig) => {
    expectError(withChange((s) => (s.layers[0].rig = rig)), 'layers[0].rig', /non-empty string/);
  });

  it('needs a rig, a cast member or a scene', () => {
    expectError(withChange((s) => delete s.layers[0].rig), 'layers[0]', /needs a "rig".*a "cast" member.*or a "scene"/);
  });

  it.each([0, -6, 13, '6', Number.NaN])('stepFps %j', (stepFps) => {
    expectError(withChange((s) => (s.layers[0].stepFps = stepFps)), 'layers[0].stepFps', /0 < stepFps <= 12/);
  });

  it('rejects params that are not an object', () => {
    expectError(withChange((s) => (s.layers[0].params = [1, 2])), 'layers[0].params', /object/);
  });

  it.each([null, { a: 1 }, [1], Number.NaN])('rejects a param value %j', (v) => {
    expectError(withChange((s) => (s.layers[0].params.x = v)), 'layers[0].params.x', /number, string, or boolean/);
  });

  it('checks the background like a layer, with background.* paths', () => {
    expectError(withChange((s) => (s.background = 'paper')), 'background', /object/);
    expectError(withChange((s) => (s.background.rig = '')), 'background.rig');
    expectError(withChange((s) => (s.background.stepFps = 99)), 'background.stepFps');
    expectError(
      withChange((s) => (s.background.overrides = [{ from: -1, to: 5 }])),
      'background.overrides[0].from',
    );
  });
});

describe('track errors', () => {
  it('tracks must be an array', () => {
    expectError(withChange((s) => (s.layers[0].tracks = {})), 'layers[0].tracks', /array/);
  });

  it('a track must be an object', () => {
    expectError(withChange((s) => (s.layers[0].tracks[1] = 'x')), 'layers[0].tracks[1]', /object/);
  });

  it.each([undefined, '', 5])('track param %j', (param) => {
    expectError(withChange((s) => (s.layers[0].tracks[0].param = param)), 'layers[0].tracks[0].param', /non-empty string/);
  });

  it('rejects a second track for the same param', () => {
    expectError(
      withChange((s) => (s.layers[0].tracks[1].param = 'x')),
      'layers[0].tracks[1].param',
      /duplicate.*"x".*tracks\[0\]/,
    );
  });

  it.each([undefined, [], 'keys'])('keys %j', (keys) => {
    expectError(withChange((s) => (s.layers[0].tracks[0].keys = keys)), 'layers[0].tracks[0].keys', /non-empty array/);
  });

  it('a key must be an object', () => {
    expectError(withChange((s) => (s.layers[0].tracks[0].keys[1] = 3)), 'layers[0].tracks[0].keys[1]', /object/);
  });

  it.each([undefined, '1', Number.NaN, Infinity])('key t %j', (t) => {
    expectError(withChange((s) => (s.layers[0].tracks[0].keys[1].t = t)), 'layers[0].tracks[0].keys[1].t', /finite/);
  });

  it('key times must be strictly increasing', () => {
    expectError(
      withChange((s) => (s.layers[0].tracks[0].keys[1].t = 0)),
      'layers[0].tracks[0].keys[1].t',
      /strictly increasing/,
    );
    expectError(
      withChange((s) => (s.layers[0].tracks[0].keys[1].t = -2)),
      'layers[0].tracks[0].keys[1].t',
      /strictly increasing/,
    );
    const three = withChange((s) =>
      (s.layers[0].tracks[0].keys = [{ t: 0, v: 1 }, { t: 2, v: 2 }, { t: 1, v: 3 }]),
    );
    expectError(three, 'layers[0].tracks[0].keys[2].t', /strictly increasing/);
  });

  it.each([undefined, null, {}, [1]])('key v %j', (v) => {
    expectError(withChange((s) => (s.layers[0].tracks[0].keys[0].v = v)), 'layers[0].tracks[0].keys[0].v');
  });

  it('ease must be a known easing name and the message lists them', () => {
    expectError(
      withChange((s) => (s.layers[0].tracks[0].keys[1].ease = 'bouncy')),
      'layers[0].tracks[0].keys[1].ease',
      /"bouncy".*inOutCubic/,
    );
  });
});

describe('override errors', () => {
  it('overrides must be an array of objects', () => {
    expectError(withChange((s) => (s.layers[0].overrides = {})), 'layers[0].overrides', /array/);
    expectError(withChange((s) => (s.layers[0].overrides[0] = null)), 'layers[0].overrides[0]', /object/);
  });

  it.each([undefined, 1.5, '3', Number.NaN])('from %j must be an integer', (from) => {
    expectError(withChange((s) => (s.layers[0].overrides[0].from = from)), 'layers[0].overrides[0].from', /integer/);
  });

  it.each([undefined, 40.5, '48'])('to %j must be an integer', (to) => {
    expectError(withChange((s) => (s.layers[0].overrides[0].to = to)), 'layers[0].overrides[0].to', /integer/);
  });

  it('from must be >= 0', () => {
    expectError(withChange((s) => (s.layers[0].overrides[0].from = -1)), 'layers[0].overrides[0].from', />= 0/);
  });

  it('to must be <= frameCount', () => {
    expectError(withChange((s) => (s.layers[0].overrides[1].to = 121)), 'layers[0].overrides[1].to', /120/);
  });

  it('from must be < to', () => {
    expectError(
      withChange((s) => (s.layers[0].overrides[0] = { from: 10, to: 10 })),
      'layers[0].overrides[0]',
      /from < to/,
    );
    expectError(withChange((s) => (s.layers[0].overrides[0] = { from: 11, to: 10 })), 'layers[0].overrides[0]', /from < to/);
  });

  it('rejects overlapping overrides on one layer', () => {
    const errors = withChange((s) => (s.layers[0].overrides = [{ from: 0, to: 11 }, { from: 10, to: 20 }]));
    expectError(errors, 'layers[0].overrides[1]', /overlaps overrides\[0\]/);
  });

  it('rejects overlapping overrides that are not next to each other in the list', () => {
    const errors = withChange((s) => (s.layers[0].overrides = [{ from: 0, to: 10 }, { from: 20, to: 30 }, { from: 5, to: 15 }]));
    expectError(errors, 'layers[0].overrides[2]', /overlaps overrides\[0\]/);
  });

  it('rejects an override nested inside another', () => {
    const errors = withChange((s) => (s.layers[0].overrides = [{ from: 30, to: 40 }, { from: 0, to: 100 }]));
    expectError(errors, 'layers[0].overrides[1]', /overlaps overrides\[0\]/);
  });

  it('allows the same range on different layers', () => {
    expect(
      withChange((s) => {
        s.layers[0].overrides = [{ from: 0, to: 10 }];
        s.layers[1].overrides = [{ from: 0, to: 10 }];
      }),
    ).toEqual([]);
  });

  it('checks override rig and param values', () => {
    expectError(withChange((s) => (s.layers[0].overrides[0].rig = '')), 'layers[0].overrides[0].rig', /non-empty string/);
    expectError(
      withChange((s) => (s.layers[0].overrides[0].params = { tear: null })),
      'layers[0].overrides[0].params.tear',
    );
  });
});

describe('audio errors', () => {
  it('audio must be an array of objects', () => {
    expectError(withChange((s) => (s.audio = {})), 'audio', /array/);
    expectError(withChange((s) => (s.audio[0] = 'buzz')), 'audio[0]', /object/);
  });

  it('checks id, generator, start, end', () => {
    expectError(withChange((s) => (s.audio[0].id = '')), 'audio[0].id', /non-empty string/);
    expectError(withChange((s) => delete s.audio[0].generator), 'audio[0].generator', /non-empty string/);
    expectError(withChange((s) => (s.audio[0].start = 'x')), 'audio[0].start', /number/);
    expectError(withChange((s) => (s.audio[0].end = Number.NaN)), 'audio[0].end', /number/);
    expectError(withChange((s) => (s.audio[0].end = 3)), 'audio[0]', /start < end/);
    expectError(withChange((s) => (s.audio[0].params = { p: null })), 'audio[0].params.p');
  });

  it('rejects duplicate audio ids', () => {
    expectError(withChange((s) => s.audio.push({ ...s.audio[0] })), 'audio[1].id', /duplicate/);
  });

  it('keeps each cue inside the scene', () => {
    expectError(withChange((s) => (s.audio[0].start = -1)), 'audio[0].start', /0 or more/);
    expectError(withChange((s) => (s.audio[0].end = 11)), 'audio[0].end', /duration \(10 s\)/);
    expect(withChange((s) => (s.audio[0].end = 10))).toEqual([]);
  });

  it('rejects "/" in cue ids, which would let two cues share random numbers', () => {
    expectError(withChange((s) => (s.audio[0].id = 'buzz/wander')), 'audio[0].id', /may not contain "\/"/);
  });

  it('needs an fps that divides 48000 when the scene has audio, so frames land on whole samples', () => {
    expectError(withChange((s) => (s.fps = 7)), 'fps', /48000.*12, 24, 25, 30/);
    expect(withChange((s) => (s.fps = 25))).toEqual([]);
    expect(withChange((s) => ((s.fps = 7), (s.audio = [])))).toEqual([]);
  });
});

describe('audio generators', () => {
  const generators = new Map([
    ['buzz', { id: 'buzz', params: { pitch: { type: 'number', default: 220 }, wave: { type: 'enum', default: 'saw', options: ['saw', 'square'] } } }],
    ['pad', { id: 'pad', params: {} }],
  ] as const);
  const check = (change: (s: Mutable) => void) => {
    const s = validScene() as unknown as Mutable;
    change(s);
    const r = validateScene(s, registry, generators as never);
    return r.ok ? [] : r.errors;
  };

  it('accepts a cue for a known generator with matching params', () => {
    expect(check(() => {})).toEqual([]);
    expect(check((s) => (s.audio[0].params = { pitch: 330, wave: 'square' }))).toEqual([]);
  });

  it('names an unknown generator and lists the known ones', () => {
    expectError(check((s) => (s.audio[0].generator = 'buz')), 'audio[0].generator', /unknown generator "buz".*buzz, pad/);
  });

  it('checks params against the generator schema', () => {
    expectError(check((s) => (s.audio[0].params = { pitch: 'high' })), 'audio[0].params.pitch', /generator "buzz" param "pitch" expects a number/);
    expectError(check((s) => (s.audio[0].params = { wave: 'sine' })), 'audio[0].params.wave', /"sine" is not an option/);
    expectError(check((s) => (s.audio[0].params = { volume: 1 })), 'audio[0].params.volume', /unknown param "volume" for generator "buzz"/);
  });

  it('skips generator checks without a generator registry', () => {
    expect(withChange((s) => (s.audio[0].generator = 'anything'))).toEqual([]);
  });
});

describe('unknown fields', () => {
  it.each([
    ['backgorund', 'backgorund', /unknown field "backgorund"; did you mean "background"\?.*allowed fields: id, fps, duration, size, seed, background, layers, audio/],
    ['bg', 'bg', /unknown field "bg"; allowed fields: id, fps/],
  ])('rejects the scene field %s', (field, path, message) => {
    expectError(withChange((s) => (s[field] = { rig: 'paper' })), path, message);
  });

  it.each([
    ['stepfps', 6, /unknown field "stepfps"; did you mean "stepFps"\?/],
    ['stepFPS', 12, /did you mean "stepFps"\?/],
    ['overide', [{ from: 0, to: 6 }], /did you mean "overrides"\?/],
    ['override', [{ from: 0, to: 6 }], /did you mean "overrides"\?/],
    ['track', [], /did you mean "tracks"\?/],
    ['hidden', true, /unknown field "hidden"; allowed fields: id, rig, cast, scene, start, in, out, params, tracks, stepFps, overrides, mask/],
  ])('rejects the layer field %s', (field, value, message) => {
    expectError(withChange((s) => (s.layers[0][field] = value)), `layers[0].${field}`, message);
  });

  it('rejects unknown background fields, and says the background id is fixed', () => {
    expectError(withChange((s) => (s.background.overide = [])), 'background.overide', /allowed fields: rig, cast, scene, start, in, out, params, tracks, stepFps, overrides, mask/);
    expectError(withChange((s) => (s.background.id = 'sky')), 'background.id', /always "background"/);
  });

  it('rejects unknown track, key, override and audio fields', () => {
    expectError(
      withChange((s) => (s.layers[0].tracks[0].key = [])),
      'layers[0].tracks[0].key',
      /did you mean "keys"\?.*allowed fields: param, keys/,
    );
    expectError(
      withChange((s) => (s.layers[0].tracks[0].keys[1].easing = 'inOutCubic')),
      'layers[0].tracks[0].keys[1].easing',
      /unknown field "easing"; did you mean "ease"\?.*allowed fields: t, v, ease/,
    );
    expectError(
      withChange((s) => (s.layers[0].overrides[0].param = { tear: 1 })),
      'layers[0].overrides[0].param',
      /did you mean "params"\?.*allowed fields: from, to, rig, params/,
    );
    expectError(
      withChange((s) => (s.audio[0].volume = 1)),
      'audio[0].volume',
      /allowed fields: id, generator, start, end, params/,
    );
  });

  it('treats Object.prototype names as unknown fields', () => {
    const errors = withChange((s) => Object.defineProperty(s.layers[0], 'constructor', { value: 1, enumerable: true }));
    expectError(errors, 'layers[0].constructor', /unknown field/);
  });
});

describe('registry-aware checks', () => {
  it('an unknown layer rig lists the known rigs', () => {
    expectError(
      withChange((s) => (s.layers[0].rig = 'ghost')),
      'layers[0].rig',
      /unknown rig "ghost".*"dot", "dot\.torn", "paper"/,
    );
  });

  it('an unknown override rig lists the known rigs', () => {
    expectError(
      withChange((s) => (s.layers[0].overrides[0].rig = 'dot.ghost')),
      'layers[0].overrides[0].rig',
      /unknown rig "dot\.ghost".*"dot\.torn"/,
    );
  });

  it('an unknown background rig is reported', () => {
    expectError(withChange((s) => (s.background.rig = 'wallpaper')), 'background.rig', /unknown rig "wallpaper"/);
  });

  it('skips rig checks without a registry', () => {
    const s = validScene();
    s.layers[0].rig = 'ghost';
    expect(validateScene(s).ok).toBe(true);
  });

  it('an unknown layer param lists the known params', () => {
    expectError(
      withChange((s) => (s.layers[0].params.radius = 5)),
      'layers[0].params.radius',
      /unknown param "radius" for rig "dot".*x, y, fill, label, mode, visible/,
    );
  });

  it('does not treat Object.prototype keys as params', () => {
    expectError(withChange((s) => (s.layers[0].params.toString = 'x')), 'layers[0].params.toString', /unknown param/);
    expectError(withChange((s) => (s.layers[0].tracks[0].param = 'constructor')), 'layers[0].tracks[0].param', /unknown param/);
  });

  it('an unknown track param lists the known params', () => {
    expectError(
      withChange((s) => (s.layers[0].tracks[0].param = 'size')),
      'layers[0].tracks[0].param',
      /unknown param "size" for rig "dot".*known params/,
    );
  });

  it('override params are checked against the override rig', () => {
    // tear exists on dot.torn: fine inside the dot.torn override
    expect(withChange((s) => (s.layers[0].overrides[0].params = { tear: 1 }))).toEqual([]);
    // without the rig swap, the layer rig (dot) has no tear
    expectError(
      withChange((s) => delete s.layers[0].overrides[0].rig),
      'layers[0].overrides[0].params.tear',
      /unknown param "tear" for rig "dot"/,
    );
    // base params are on the variant too
    expect(withChange((s) => (s.layers[0].overrides[0].params = { label: 'x' }))).toEqual([]);
    expectError(
      withChange((s) => (s.layers[0].overrides[0].params = { rip: 1 })),
      'layers[0].overrides[0].params.rip',
      /unknown param "rip" for rig "dot\.torn"/,
    );
  });

  it.each([
    ['x', '10', /expects a number/],
    ['fill', 0xff0000, /expects a color string/],
    ['label', true, /expects a string/],
    ['mode', 1, /expects one of "a", "b"/],
    ['visible', 'yes', /expects a boolean/],
  ])('wrong type for %s (%j)', (name, value, message) => {
    expectError(withChange((s) => (s.layers[0].params[name] = value)), `layers[0].params.${name}`, message);
  });

  it.each([
    '#fff', '#FFFA', '#ff8800', '#ff880080', 'red', 'Tomato', 'REBECCAPURPLE', 'transparent', 'none', 'None',
    'rgb(255 136 0)', 'rgba(0, 0, 0, 0.5)', 'hsl(10 50% 50%)', 'HSLA(10, 50%, 50%, 1)', 'hwb(0 0% 0%)',
    'lab(50% 40 59)', 'lch(50% 70 60)', 'oklab(0.6 0.1 0.1)', 'oklch(70% 0.1 200)', 'color(display-p3 1 0 0)',
    'color-mix(in srgb, red, blue)', 'rgb(from red r g b)',
  ])('accepts the CSS colour %j', (color) => {
    expect(withChange((s) => (s.layers[0].params.fill = color))).toEqual([]);
  });

  it.each([
    'redd', '#e0457', '#ff8800f', '#ggg', 'ff8800', '', 'rgb(1, 2, 3', 'rgb)1(', 'bogus(1, 2, 3)', 'rgb(1, 2, 3))', 'red blue',
  ])('rejects the malformed colour %j', (color) => {
    expectError(
      withChange((s) => (s.layers[0].params.fill = color)),
      'layers[0].params.fill',
      /is not a CSS color for rig "dot" param "fill"; use .*"#ff8800"/,
    );
  });

  it('checks colours in track keys, override params and the background too', () => {
    const errors = withChange((s) => {
      s.layers[0].tracks.push({ param: 'fill', keys: [{ t: 0, v: '#000' }, { t: 1, v: '#e0457' }] });
      s.layers[0].overrides[1].params = { fill: 'sunflower' };
      s.background.params.tone = 'papyrus';
    });
    expectError(errors, 'layers[0].tracks[2].keys[1].v', /"#e0457" is not a CSS color/);
    expectError(errors, 'layers[0].overrides[1].params.fill', /"sunflower" is not a CSS color/);
    expectError(errors, 'background.params.tone', /"papyrus" is not a CSS color/);
    expect(errors).toHaveLength(3);
  });

  it('an enum value outside the options lists them', () => {
    expectError(
      withChange((s) => (s.layers[0].params.mode = 'c')),
      'layers[0].params.mode',
      /"c" is not an option.*"a", "b"/,
    );
  });

  it('track key values are type-checked against the param spec', () => {
    expectError(
      withChange((s) => (s.layers[0].tracks[0].keys[1].v = 'far')),
      'layers[0].tracks[0].keys[1].v',
      /expects a number/,
    );
    expectError(
      withChange((s) => (s.layers[0].tracks[1].keys[1].v = 'z')),
      'layers[0].tracks[1].keys[1].v',
      /not an option/,
    );
  });

  it('override param values are type-checked', () => {
    expectError(
      withChange((s) => (s.layers[0].overrides[0].params = { tear: 'lots' })),
      'layers[0].overrides[0].params.tear',
      /expects a number/,
    );
  });

  it('background params are checked against the background rig', () => {
    expectError(withChange((s) => (s.background.params = { tone: 5 })), 'background.params.tone', /color/);
    expectError(withChange((s) => (s.background.params = { hue: '#fff' })), 'background.params.hue', /unknown param/);
  });

  it('does not pile param errors on a layer whose rig is unknown', () => {
    const errors = withChange((s) => (s.layers[0].rig = 'ghost'));
    expect(errors).toHaveLength(1);
  });
});

describe('override rigs and variants', () => {
  /** dot.calm narrows the mode options, so values that fit dot can fail on it. */
  const dotCalm: Rig = {
    id: 'dot.calm',
    params: { ...dot.params, mode: { type: 'enum', default: 'a', options: ['a'] } },
    draw: noop,
  };
  const dotWet: Rig = { id: 'dot.wet', params: { ...dot.params }, draw: noop };
  const reg = createRegistry([dot, dotTorn, dotCalm, dotWet, paper]);
  const change = (fn: (s: Mutable) => void) => withChange(fn, reg);

  it('rejects an override rig with a different base, listing the variants of the layer rig', () => {
    const errors = change((s) => (s.layers[0].overrides[0].rig = 'paper'));
    expectError(
      errors,
      'layers[0].overrides[0].rig',
      /rig "paper" does not share a base with the layer rig "dot".*registered variants of "dot": "dot\.torn", "dot\.calm", "dot\.wet"\)$/,
    );
    // tear is then not checked against paper: one error, not a pile
    expect(errors).toHaveLength(1);
  });

  it('says so when the layer rig has no variants', () => {
    expectError(
      change((s) => (s.background.overrides = [{ from: 0, to: 12, rig: 'dot' }])),
      'background.overrides[0].rig',
      /rig "dot" does not share a base with the layer rig "paper".*no variants of "paper" are registered/,
    );
  });

  it('reports an unknown rig with a different base once, as a base mismatch', () => {
    const errors = change((s) => (s.layers[0].overrides[0].rig = 'ghost'));
    expect(errors).toHaveLength(1);
    expectError(errors, 'layers[0].overrides[0].rig', /does not share a base/);
  });

  it('allows swapping from a variant back to its base, or to a sibling variant', () => {
    const fromVariant = (rig: string) =>
      change((s) => {
        s.layers[0].rig = 'dot.torn';
        s.layers[0].overrides[0] = { from: 36, to: 48, rig };
      });
    expect(fromVariant('dot')).toEqual([]);
    expect(fromVariant('dot.wet')).toEqual([]);
  });

  it('skips the base check without a registry or when the layer rig is unknown', () => {
    const s = validScene() as unknown as Mutable;
    s.layers[0].overrides[0].rig = 'paper';
    expect(validateScene(s).ok).toBe(true);
    expect(change((x) => (x.layers[0].rig = 'ghost'))).toHaveLength(1);
  });

  it('reports a layer param that does not fit the override rig, at the override path', () => {
    const errors = change((s) => {
      s.layers[0].rig = 'dot.torn';
      s.layers[0].params.tear = 0.3;
      s.layers[0].overrides[0] = { from: 36, to: 48, rig: 'dot' };
    });
    expectError(
      errors,
      'layers[0].overrides[0]',
      /frames \[36, 48\).*param "tear" \(layers\[0\]\.params\.tear\).*unknown param "tear" for rig "dot"/,
    );
    expect(errors).toHaveLength(1);
  });

  it('reports a layer enum value the override rig does not offer', () => {
    const errors = change((s) => {
      s.layers[0].tracks.splice(1, 1); // no mode track, so params.mode reaches the rig
      s.layers[0].params.mode = 'b';
      s.layers[0].overrides[0] = { from: 36, to: 48, rig: 'dot.calm' };
    });
    expectError(errors, 'layers[0].overrides[0]', /param "mode" \(layers\[0\]\.params\.mode\).*"b" is not an option for rig "dot\.calm"/);
    expect(errors).toHaveLength(1);
  });

  it('skips layer params that a track or the override itself replaces', () => {
    // the mode track (a at 0 s, b at 3 s) replaces params.mode; frames [0, 12) only see key 0
    expect(
      change((s) => {
        s.layers[0].params.mode = 'b';
        s.layers[0].overrides[0] = { from: 0, to: 12, rig: 'dot.calm' };
      }),
    ).toEqual([]);
    expect(
      change((s) => {
        s.layers[0].tracks.splice(1, 1);
        s.layers[0].params.mode = 'b';
        s.layers[0].overrides[0] = { from: 36, to: 48, rig: 'dot.calm', params: { mode: 'a' } };
      }),
    ).toEqual([]);
  });

  it('reports track keys that reach the override rig on its frames, and only those', () => {
    // stepFps 6 at 12 fps: frames [36, 48) see t = 3 .. 3.8333, so key 1 (b, at 3 s) reaches dot.calm
    const errors = change((s) => (s.layers[0].overrides[0] = { from: 36, to: 48, rig: 'dot.calm' }));
    expectError(
      errors,
      'layers[0].overrides[0]',
      /frames \[36, 48\).*track "mode" key 1 \(layers\[0\]\.tracks\[1\]\.keys\[1\]\.v\).*"b" is not an option for rig "dot\.calm"/,
    );
    expect(errors).toHaveLength(1);
    // frames [24, 36) end at t = 2.8333, before key 1
    expect(change((s) => (s.layers[0].overrides[0] = { from: 24, to: 36, rig: 'dot.calm' }))).toEqual([]);
    // frame 35 holds t = 2.8333 on twos, so [35, 36) still misses key 1; [36, 37) hits it
    expect(change((s) => (s.layers[0].overrides[0] = { from: 35, to: 36, rig: 'dot.calm' }))).toEqual([]);
    expect(change((s) => (s.layers[0].overrides[0] = { from: 36, to: 37, rig: 'dot.calm' }))).toHaveLength(1);
    // a key before the range still holds into it
    expect(change((s) => (s.layers[0].overrides[0] = { from: 100, to: 120, rig: 'dot.calm' }))).toHaveLength(1);
  });

  it('reports a track param the override rig does not have', () => {
    const errors = change((s) => {
      s.layers[0].rig = 'dot.torn';
      s.layers[0].tracks.push({ param: 'tear', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] });
      s.layers[0].overrides[0] = { from: 36, to: 48, rig: 'dot' };
    });
    expectError(errors, 'layers[0].overrides[0]', /track "tear" \(layers\[0\]\.tracks\[2\]\).*unknown param "tear" for rig "dot"/);
    expect(errors).toHaveLength(1);
  });

  it('does not report a value again when it already fails on the layer rig', () => {
    const errors = change((s) => {
      s.layers[0].params.fill = 'sunflower';
      s.layers[0].tracks[1].keys[1].v = 'z';
      s.layers[0].overrides[0] = { from: 36, to: 48, rig: 'dot.calm' };
    });
    expectError(errors, 'layers[0].params.fill', /"sunflower"/);
    expectError(errors, 'layers[0].tracks[1].keys[1].v', /"z" is not an option for rig "dot"/);
    expect(errors).toHaveLength(2);
  });

  it('checks every key when the override range is invalid', () => {
    const errors = change((s) => (s.layers[0].overrides[0] = { from: 0, to: 500, rig: 'dot.calm' }));
    expectError(errors, 'layers[0].overrides[0].to', /120/);
    expectError(errors, 'layers[0].overrides[0]', /track "mode" key 1/);
  });

  it('the shipped fixture passes: dot.torn takes every dot param', () => {
    expect(change(() => {})).toEqual([]);
  });
});
