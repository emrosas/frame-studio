import { describe, expect, it } from 'vitest';
import type { ProjectEntry, ProjectItem } from './desktop';
import { groupStatus, projectGroups } from './project-groups';
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
const base = { entries, scenes, folder: { path: '/two', name: 'two' }, folds: {}, query: '' };

describe("the sidebar's project groups", () => {
  it('puts the project on screen first and open, the rest folded, most recent first', () => {
    const groups = projectGroups(base);
    expect(groups.map((g) => [g.path, g.open])).toEqual([['/two', true], ['/one', false], ['/three', false]]);
  });

  it('shows the project on screen from the live list, and others from disk', () => {
    const [two, , three] = projectGroups(base);
    expect(two.videos.map((v) => v.key)).toEqual(['cut']);
    expect(two.scenes.map((v) => v.key)).toEqual(['intro']);
    expect(two.films).toMatchObject([{ id: 'story', name: 'Old Film' }]);
    expect(two.films[0].rows.map((r) => r.key)).toEqual(['story/film', 'story/shot']);
    expect(three.videos[0]).toMatchObject({ key: 'trailer', poster: 'trailer-000000000000.png' });
    expect(three.count).toBe(4);
  });

  it('follows the folds you set', () => {
    const groups = projectGroups({ ...base, folds: { '/two': false, '/three': true } });
    expect(groups.map((g) => g.open)).toEqual([false, false, true]);
  });

  it('has one group in a browser, or until the list arrives', () => {
    const groups = projectGroups({ ...base, entries: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ path: '/two', name: 'two', current: true, open: true, status: null });
  });

  it('finds the project on screen by path when no entry says so', () => {
    const groups = projectGroups({ ...base, entries: [entry('/one'), entry('/two')] });
    expect(groups.map((g) => g.path)).toEqual(['/two', '/one']);
    expect(groups[0].current).toBe(true);
  });

  it('filters across every project, opening what matches and dropping the rest', () => {
    const groups = projectGroups({ ...base, query: ' INTRO ' });
    expect(groups.map((g) => g.path)).toEqual(['/two', '/three']);
    expect(groups.every((g) => g.open)).toBe(true);
    expect(groups[1].scenes.map((s) => s.key)).toEqual(['intro']);
    expect(groups[1].videos).toEqual([]);
    expect(projectGroups({ ...base, query: 'shot' })[0].films[0].rows.map((r) => r.key)).toEqual(['story/shot']);
    expect(projectGroups({ ...base, query: 'nothing' })).toEqual([]);
  });

  it('never opens a project whose folder is gone', () => {
    const groups = projectGroups({ ...base, entries: [...entries, entry('/gone', { missing: true })], folds: { '/gone': true } });
    expect(groups.at(-1)).toMatchObject({ missing: true, open: false });
  });
});

describe("a project's status", () => {
  it('shows the most pressing and says all of it', () => {
    expect(groupStatus({ working: 1, input: 0, yours: 0 })).toEqual({ kind: 'working', label: '1 working' });
    expect(groupStatus({ working: 1, input: 0, yours: 2 })).toEqual({ kind: 'your_turn', label: '2 your turn, 1 working' });
    expect(groupStatus({ working: 1, input: 1, yours: 1 })?.kind).toBe('input');
    expect(groupStatus({ working: 0, input: 0, yours: 0 })).toBeNull();
  });
});
