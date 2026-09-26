import { describe, expect, it } from 'vitest';
import { createRegistry, sceneGraphErrors, validateProject, validateScene } from '../engine';
import type { Rig, RigRegistry, Scene } from '../engine/types';
import { buildLibrary, findEntry, openingEntry, type ProjectTools, type ValidateScene } from './library';

const registry: RigRegistry = new Map();

// Stand-in validator: a scene needs a string id and a positive fps.
const validate: ValidateScene = (input) => {
  const o = input as Partial<Scene>;
  const errors: string[] = [];
  if (typeof o?.id !== 'string' || o.id === '') errors.push('id: must be a non-empty string');
  if (typeof o?.fps !== 'number' || o.fps <= 0) errors.push('fps: must be a positive integer');
  return errors.length ? { ok: false, errors } : { ok: true, scene: o as Scene };
};

const scene = (id: string, fps = 12) => JSON.stringify({ id, fps, duration: 1, size: [10, 10], seed: 1, layers: [] });

describe('buildLibrary', () => {
  it('keys valid scenes by id, sorted by path', () => {
    const lib = buildLibrary({ '/scenes/b.json': scene('beta'), '/scenes/a.json': scene('alpha') }, validate, () => registry);
    expect(lib.entries.map((e) => e.key)).toEqual(['alpha', 'beta']);
    expect(lib.entries[0].file).toBe('scenes/a.json');
    expect(lib.entries[0].scene?.id).toBe('alpha');
    expect(lib.entries[0].errors).toEqual([]);
    expect(lib.registry).toBe(registry);
  });

  it('reports malformed JSON per file without failing the others', () => {
    const lib = buildLibrary({ '/scenes/bad.json': '{ "id": "bad", ', '/scenes/ok.json': scene('ok') }, validate, () => registry);
    const bad = findEntry(lib, 'bad');
    expect(bad?.scene).toBeNull();
    expect(bad?.errors[0]).toMatch(/^invalid JSON: /);
    expect(findEntry(lib, 'ok')?.scene).not.toBeNull();
  });

  it('keeps the id as key for invalid scenes so the selection survives a bad edit', () => {
    const lib = buildLibrary({ '/scenes/x.json': JSON.stringify({ id: 'hero', fps: 0 }) }, validate, () => registry);
    expect(lib.entries[0].key).toBe('hero');
    expect(lib.entries[0].scene).toBeNull();
    expect(lib.entries[0].errors).toEqual(['fps: must be a positive integer']);
  });

  it('flags duplicate ids and gives the later file a unique key', () => {
    const lib = buildLibrary({ '/scenes/a.json': scene('same'), '/scenes/b.json': scene('same') }, validate, () => registry);
    expect(lib.entries.map((e) => e.key)).toEqual(['same', 'scenes/b.json']);
    expect(lib.entries[0].scene).not.toBeNull();
    expect(lib.entries[1].scene).toBeNull();
    expect(lib.entries[1].errors[0]).toContain('already used by scenes/a.json');
  });

  it('gives a clashing id to the file named after it and flags the copy, whatever the sort order', () => {
    // bounce.json is a copy of hello.json that still says "id": "hello", and it sorts first.
    const lib = buildLibrary({ '/scenes/hello.json': scene('hello'), '/scenes/bounce.json': scene('hello') }, validate, () => registry);
    expect(lib.entries.map((e) => e.key)).toEqual(['scenes/bounce.json', 'hello']);
    const original = findEntry(lib, 'hello');
    expect(original?.path).toBe('/scenes/hello.json');
    expect(original?.scene).not.toBeNull();
    expect(original?.errors).toEqual([]);
    const copy = lib.entries[0];
    expect(copy.scene).toBeNull();
    expect(copy.errors).toEqual(['id: "hello" is already used by scenes/hello.json. Scene ids must be unique; rename one of them.']);
  });

  it('reports a registry failure as a library error', () => {
    const lib = buildLibrary({ '/scenes/a.json': scene('a') }, validate, () => {
      throw new Error('duplicate rig id "circle"');
    });
    expect(lib.registry).toBeNull();
    expect(lib.errors[0]).toContain('duplicate rig id "circle"');
  });

  it('reports a throwing validator instead of crashing', () => {
    const lib = buildLibrary({ '/scenes/a.json': scene('a') }, () => {
      throw new Error('boom');
    }, () => registry);
    expect(lib.entries[0].errors).toEqual(['validator threw: boom']);
  });
});

describe('findEntry', () => {
  const lib = buildLibrary({ '/scenes/a.json': scene('alpha') }, validate, () => registry);

  it('finds by key, then by path (id renamed in place)', () => {
    expect(findEntry(lib, 'alpha')?.path).toBe('/scenes/a.json');
    expect(findEntry(lib, 'old-name', '/scenes/a.json')?.key).toBe('alpha');
    expect(findEntry(lib, 'missing')).toBeNull();
    expect(findEntry(lib, null)).toBeNull();
  });

  it('falls back to the file name when no id matches', () => {
    // scenes/a.json declares "alpha"; ?scene=a still opens it.
    expect(findEntry(lib, 'a')?.key).toBe('alpha');
  });
});

describe('openingEntry', () => {
  const lib = buildLibrary({ '/scenes/a.json': scene('alpha'), '/scenes/b.json': scene('beta') }, validate, () => registry);

  it('opens the requested scene by id or file name', () => {
    expect(openingEntry(lib, 'beta')).toEqual({ entry: lib.entries[1], missing: false });
    expect(openingEntry(lib, 'b')).toEqual({ entry: lib.entries[1], missing: false });
  });

  it('opens the first scene when nothing is requested', () => {
    expect(openingEntry(lib, null)).toEqual({ entry: lib.entries[0], missing: false });
  });

  it('opens the first scene and reports the request missing when nothing matches', () => {
    expect(openingEntry(lib, 'sunrse')).toEqual({ entry: lib.entries[0], missing: true });
    expect(openingEntry(buildLibrary({}, validate, () => registry), 'x')).toEqual({ entry: null, missing: true });
  });
});

describe('projects (ADR 0007)', () => {
  const box: Rig = {
    id: 'box',
    params: { size: { type: 'number', default: 10, min: 0, max: 1000 } },
    draw: (ctx, p) => ctx.fillRect(0, 0, Number(p.size), Number(p.size)),
  };
  const hat: Rig = { ...box, id: 'hat' };
  const tools: ProjectTools = {
    validateProject,
    sceneGraphErrors,
    createProjectRegistry: (rigs) => createRegistry([box, ...rigs]),
    rigs: { story: [hat] },
  };
  const json = (value: unknown) => JSON.stringify(value);
  const project = { name: 'Story', fps: 12, size: [100, 100], main: 'film', cast: { bruno: { rig: 'box', params: { size: 40 } } } };
  const shot = (id: string, layers: unknown[] = [{ id: 'b', cast: 'bruno' }]) => json({ id, fps: 12, duration: 2, size: [100, 100], seed: 1, layers });
  const build = (files: Record<string, string>) => buildLibrary(files, validateScene, () => createRegistry([box]), () => new Map(), tools);
  const story = (extra: Record<string, string> = {}) =>
    build({
      '/scenes/loose.json': shot('loose', [{ id: 'b', rig: 'box' }]),
      '/projects/story/project.json': json(project),
      '/projects/story/film.json': shot('film', [{ id: 'one', scene: 'one' }, { id: 'two', scene: 'two', start: 1 }]),
      '/projects/story/one.json': shot('one'),
      '/projects/story/two.json': shot('two', [{ id: 'h', rig: 'hat' }]),
      ...extra,
    });

  it('keys project scenes by qualified id, after the loose ones, with their project, world and context', () => {
    const lib = story();
    expect(lib.entries.map((e) => e.key)).toEqual(['loose', 'story/film', 'story/one', 'story/two']);
    expect(lib.entries.every((e) => e.errors.length === 0)).toBe(true);
    expect(lib.projects).toEqual([
      { id: 'story', name: 'Story', file: 'projects/story/project.json', project, main: 'story/film', errors: [] },
    ]);
    const film = findEntry(lib, 'story/film')!;
    expect(film.project).toBe('story');
    expect(film.file).toBe('projects/story/film.json');
    expect([...(film.world.scenes?.keys() ?? [])].sort()).toEqual(['film', 'one', 'two']);
    expect(film.world.cast).toEqual(project.cast);
    expect(film.context?.fps).toBe(12);
    expect(findEntry(lib, 'loose')?.world).toEqual({});
  });

  it("offers a project's rigs only to its own scenes", () => {
    const lib = story({ '/scenes/stray.json': shot('stray', [{ id: 'h', rig: 'hat' }]) });
    expect(findEntry(lib, 'story/two')?.registry?.has('hat')).toBe(true);
    expect(findEntry(lib, 'stray')?.errors.join('\n')).toMatch(/unknown rig "hat"/);
  });

  it('finds a project scene only by its qualified id', () => {
    const lib = story();
    expect(findEntry(lib, 'film')).toBeNull();
    expect(openingEntry(lib, 'story/one').entry?.key).toBe('story/one');
  });

  it('needs project.json, and checks every scene against it', () => {
    const missing = build({ '/projects/story/one.json': shot('one') });
    expect(missing.projects[0].errors[0]).toMatch(/project\.json: missing/);
    expect(missing.entries[0].scene).toBeNull();
    expect(missing.entries[0].errors[0]).toMatch(/can't be checked/);
    const wrongFps = story({ '/projects/story/one.json': json({ ...JSON.parse(shot('one')), fps: 24 }) });
    expect(findEntry(wrongFps, 'story/one')?.errors.join('\n')).toMatch(/fps/);
  });

  it('names a scene after its file', () => {
    const lib = story({ '/projects/story/one.json': shot('uno') });
    expect(findEntry(lib, 'story/one')?.errors).toContain('id: must be "one", the file\'s name, got "uno"');
  });

  it('marks a scene that places a broken scene, and scenes that place each other', () => {
    const broken = story({ '/projects/story/one.json': shot('one', [{ id: 'b', cast: 'nobody' }]) });
    expect(findEntry(broken, 'story/one')?.scene).toBeNull();
    expect(findEntry(broken, 'story/film')?.errors).toContain('layers: "one" places scene "one", which has errors');
    expect(findEntry(broken, 'story/two')?.scene).not.toBeNull();

    const loop = story({ '/projects/story/one.json': shot('one', [{ id: 'f', scene: 'film' }]) });
    for (const key of ['story/film', 'story/one']) expect(findEntry(loop, key)?.errors.join('\n')).toMatch(/in a loop/);
  });

  it('reports rigs that fail to register against the project', () => {
    const lib = buildLibrary(
      { '/projects/story/project.json': json(project), '/projects/story/one.json': shot('one') },
      validateScene,
      () => createRegistry([box]),
      () => new Map(),
      { ...tools, rigs: { story: [box] } },
    );
    expect(lib.projects[0].errors[0]).toMatch(/^rigs: .*projects\/story\/rigs/);
  });
});
