import { describe, expect, it } from 'vitest';
import { buildLibrary, findEntry } from '../viewer/library';
import { compositionToScene, validateComposition } from './composition';
import { sceneGraphErrors, validateFolderProject, validateProject } from './project';
import { createRegistry } from './registry';
import type { Rig } from './types';
import { validateScene } from './validate';

const rig = (id: string, params: Rig['params'] = {}): Rig => ({ id, params, draw() {} });
const registry = createRegistry([rig('fill', { color: { type: 'color', default: '#000000' } }), rig('box', { size: { type: 'number', default: 10, min: 0, max: 100 } })]);
const scenes = new Map([
  ['meet', { duration: 4, fps: 12 }],
  ['pip', { duration: 4, fps: 12 }],
  ['fast', { duration: 2, fps: 24 }],
]);
const context = { id: '', cast: {}, scenes };
const comp = (extra: Record<string, unknown> = {}) => ({
  id: 'film',
  fps: 12,
  duration: 8,
  size: [1920, 1080],
  background: '#101010',
  tracks: [
    { id: 'V1', clips: [{ id: 'a', scene: 'meet', start: 0 }, { id: 'b', scene: 'pip', start: 4, in: 1 }] },
    { id: 'V2', clips: [{ id: 'title', scene: 'meet', start: 1, out: 2, params: { scale: 0.5 } }] },
  ],
  ...extra,
});
const errorsOf = (input: unknown) => {
  const r = validateComposition(input, registry, undefined, context);
  return r.ok ? [] : r.errors;
};

describe('a composition', () => {
  it('renders as a scene whose layers are its clips, bottom track first, over its background', () => {
    const r = validateComposition(comp(), registry, undefined, context);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scene.layers.map((l) => l.id)).toEqual(['a', 'b', 'title']);
    expect(r.scene.background).toEqual({ rig: 'fill', params: { color: '#101010' } });
    expect(r.scene.seed).toBe(0);
    expect(compositionToScene(r.composition)).toEqual(r.scene);
  });

  it("says where a clip is wrong in the composition's own terms", () => {
    expect(errorsOf(comp({ tracks: [{ id: 'V1', clips: [{ id: 'a', scene: 'nope' }] }] }))).toEqual([
      'tracks[0].clips[0].scene: no scene or composition "nope" in the project; there are meet, pip, fast',
    ]);
    expect(errorsOf(comp({ tracks: [{ id: 'V1', clips: [{ id: 'a', scene: 'meet', out: 9 }] }] }))[0]).toMatch(/^tracks\[0\]\.clips\[0\]\.out: must be within the shot's duration \(4 s\)/);
    expect(errorsOf(comp({ tracks: [{ id: 'V1', clips: [{ id: 'a', scene: 'meet' }, { id: 'a', scene: 'pip' }] }] }))[0]).toMatch(/^tracks\[0\]\.clips\[1\]\.id: duplicate/);
    expect(errorsOf(comp({ tracks: [{ id: 'V1', clips: [{ id: 'a', rig: 'box' }] }] }))).toEqual([
      'tracks[0].clips[0].rig: unknown field "rig"; a clip has id, scene, start, in, out, params, tracks, overrides, mask',
      'tracks[0].clips[0].scene: must be the id of a scene or composition to place, got nothing',
    ]);
    expect(errorsOf(comp({ tracks: [{ id: 'V1', clips: [] }, { id: 'V1', clips: [] }] }))).toEqual(['tracks[1].id: duplicate track id "V1" (also tracks[0])']);
    expect(errorsOf(comp({ background: 12 }))).toEqual(['background: must be a colour, like "#101010", got 12']);
    expect(errorsOf(comp({ layers: [] }))[0]).toMatch(/^layers: unknown field "layers"/);
  });

  it('takes clips of another size, but only at its own fps', () => {
    expect(errorsOf(comp({ size: [1080, 1920] }))).toEqual([]);
    expect(errorsOf(comp({ tracks: [{ id: 'V1', clips: [{ id: 'f', scene: 'fast' }] }] }))).toEqual([
      'tracks[0].clips[0].scene: "fast" runs at 24 fps; a composition\'s clips run at its own fps (12), so change one of them',
    ]);
  });
});

describe('a project folder (ADR 0013)', () => {
  const tools = { validateProject, sceneGraphErrors, createProjectRegistry: () => registry, validateComposition, validateFolderProject: validateFolderProject as never };
  const scene = (id: string, layers: unknown[] = [], extra: Record<string, unknown> = {}) => JSON.stringify({ id, fps: 12, duration: 4, size: [1920, 1080], seed: 1, layers, ...extra });
  const film = (id: string, clips: unknown[]) => JSON.stringify({ id, fps: 12, duration: 8, size: [1920, 1080], tracks: [{ id: 'V1', clips }] });
  const build = (files: Record<string, string>) => buildLibrary(files, validateScene, () => registry, () => new Map(), tools);

  it('has scenes that draw and compositions that place them, nested, all sharing one world', () => {
    const lib = build({
      '/project.json': JSON.stringify({ name: 'Bears', cast: { bruno: { rig: 'box', params: { size: 50 } } } }),
      '/scenes/meet.json': scene('meet', [{ id: 'b', cast: 'bruno' }]),
      '/compositions/act-one.json': film('act-one', [{ id: 'm', scene: 'meet' }]),
      '/compositions/film.json': film('film', [{ id: 'one', scene: 'act-one' }, { id: 'again', scene: 'meet', start: 4 }]),
    });
    expect(lib.entries.map((e) => [e.key, e.kind, e.errors])).toEqual([
      ['meet', 'scene', []],
      ['act-one', 'composition', []],
      ['film', 'composition', []],
    ]);
    expect(lib.folder?.project?.name).toBe('Bears');
    const film_ = findEntry(lib, 'film')!;
    expect([...(film_.world.scenes?.keys() ?? [])]).toEqual(['meet', 'act-one', 'film']);
    expect(film_.world.cast?.bruno.rig).toBe('box');
  });

  it("refuses a scene that places a scene, a composition that shares a scene's id, and loops", () => {
    const lib = build({
      '/scenes/meet.json': scene('meet'),
      '/scenes/wrap.json': scene('wrap', [{ id: 'm', scene: 'meet' }]),
      '/compositions/meet.json': film('meet', []),
      '/compositions/a.json': film('a', [{ id: 'x', scene: 'b' }]),
      '/compositions/b.json': film('b', [{ id: 'y', scene: 'a' }]),
      '/compositions/c.json': film('c', [{ id: 'z', scene: 'a' }]),
    });
    expect(findEntry(lib, 'wrap')?.errors[0]).toMatch(/a scene draws and places nothing; arrange scenes in a composition/);
    expect(lib.entries.find((e) => e.file === 'compositions/meet.json')?.errors[0]).toMatch(/"meet" is already scenes\/meet\.json; a project's scenes and compositions share ids/);
    expect(findEntry(lib, 'a')?.errors[0]).toMatch(/clips place scenes in a loop: a → b → a; a composition can't show itself/);
    expect(findEntry(lib, 'c')?.errors[0]).toMatch(/clip "z" places "a", which has errors/);
  });

  it('lets a scene use the cast only when project.json has it', () => {
    const lib = build({ '/scenes/meet.json': scene('meet', [{ id: 'b', cast: 'bruno' }]) });
    expect(findEntry(lib, 'meet')?.errors[0]).toMatch(/no cast member "bruno"/);
  });
});
