import { describe, expect, it } from 'vitest';
import type { ProjectEntry, ProjectItem } from './desktop';
import { projectRows } from './project-rows';
import type { SceneOption } from './ui.svelte';

const option = (key: string, kind: SceneOption['kind'], film: string | null = null): SceneOption => ({
  key,
  label: film ? key.slice(film.length + 1) : key,
  file: `${key}.json`,
  invalid: false,
  film,
  group: film ? 'Old Film' : null,
  main: false,
  kind,
  usedIn: [],
  format: null,
});
const item = (key: string, kind: ProjectItem['kind']): ProjectItem => ({ key, label: key, file: `${key}.json`, kind, poster: `${key}-000000000000.png`, invalid: false });
const entry = (path: string, more: Partial<ProjectEntry> = {}): ProjectEntry => ({
  path,
  name: path.slice(1),
  current: false,
  open: false,
  working: 0,
  input: 0,
  yours: 0,
  videos: [],
  scenes: [],
  films: [],
  threads: [],
  ...more,
});

const scenes = [option('cut', 'composition'), option('intro', 'scene'), option('story/film', 'scene', 'story'), option('story/shot', 'scene', 'story')];
const entries = [
  entry('/one'),
  entry('/two', { current: true, videos: [item('stale', 'composition')] }),
  entry('/three', { videos: [item('trailer', 'composition')], scenes: [item('intro', 'scene'), item('logo', 'scene')], films: [{ id: 'old', name: 'Old', items: [item('old/a', 'scene')] }], working: 1 }),
];
const base = { entries, scenes, folder: { path: '/two', name: 'two' }, query: '' };

describe("the sidebar's Footage view", () => {
  it('puts the project on screen first, then the rest, most recent first', () => {
    expect(projectRows(base).map((r) => [r.path, r.current])).toEqual([['/two', true], ['/one', false], ['/three', false]]);
  });

  it('counts the project on screen from the live list, and others from disk', () => {
    expect(projectRows(base).map((r) => r.count)).toEqual([4, 0, 4]);
  });

  it('has one row in a browser, or until the list arrives', () => {
    expect(projectRows({ ...base, entries: [] })).toEqual([{ path: '/two', name: 'two', current: true, missing: false, count: 4 }]);
  });

  it('finds the project on screen by path when no entry says so', () => {
    const entries = base.entries.map((e) => ({ ...e, current: false }));
    expect(projectRows({ ...base, entries })[0]).toMatchObject({ path: '/two', current: true });
  });

  it("filters by a project's name or what it holds, counting what matches", () => {
    expect(projectRows({ ...base, query: ' INTRO ' }).map((r) => [r.path, r.count])).toEqual([['/two', 1], ['/three', 1]]);
    expect(projectRows({ ...base, query: 'one' }).map((r) => [r.path, r.count])).toEqual([['/one', 0]]);
    expect(projectRows({ ...base, query: 'old/a' }).map((r) => r.path)).toEqual(['/three']);
    expect(projectRows({ ...base, query: 'nothing' })).toEqual([]);
  });

  it('says when a folder is gone', () => {
    expect(projectRows({ ...base, entries: [...base.entries, entry('/gone', { missing: true })] }).at(-1)).toMatchObject({ path: '/gone', missing: true });
  });
});
