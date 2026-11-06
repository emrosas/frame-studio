/**
 * What the app lists for a project without starting its server (ADR 0013):
 * its videos, scenes, older films and posters, from disk; and which projects
 * in the background stay warm.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectContents, projectPoster, projectStatus, WARM_COUNT, WARM_MS, warmProjects } from '../../desktop/projects';

const dir = mkdtempSync(join(tmpdir(), 'frame-studio-list-'));
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
};

beforeAll(() => {
  write('scenes/one.json', JSON.stringify({ id: 'first' }));
  write('scenes/broken.json', '{ not json');
  write('compositions/cut.json', JSON.stringify({ id: 'cut' }));
  write('projects/story/project.json', JSON.stringify({ name: 'The Story', main: 'film' }));
  write('projects/story/a-shot.json', '{}');
  write('projects/story/film.json', '{}');
  write('projects/empty/project.json', '{}');
  write('.frame-studio/thumbs/first-aaaaaaaaaaaa.png', 'old');
  write('.frame-studio/thumbs/first-bbbbbbbbbbbb.png', 'new');
  write('.frame-studio/thumbs/story_film-cccccccccccc.png', 'film');
  utimesSync(join(dir, '.frame-studio/thumbs/first-aaaaaaaaaaaa.png'), 1000, 1000);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a project's contents, from disk", () => {
  it("lists videos and scenes under the viewer's keys, with their newest posters", async () => {
    const { videos, scenes } = await projectContents(dir);
    expect(videos).toEqual([{ key: 'cut', label: 'cut', file: 'compositions/cut.json', kind: 'composition', poster: null, invalid: false }]);
    expect(scenes.map((s) => [s.key, s.invalid, s.poster])).toEqual([
      ['broken', true, null],
      ['first', false, 'first-bbbbbbbbbbbb.png'],
    ]);
  });

  it('lists older films with their main scene first, and leaves out a film with no scenes', async () => {
    const { films } = await projectContents(dir);
    expect(films.map((f) => [f.id, f.name])).toEqual([['story', 'The Story']]);
    expect(films[0].items.map((i) => [i.key, i.label, i.poster])).toEqual([
      ['story/film', 'film', 'story_film-cccccccccccc.png'],
      ['story/a-shot', 'a-shot', null],
    ]);
  });

  it('sees a change to a file', async () => {
    write('scenes/two.json', JSON.stringify({ id: 'two' }));
    expect((await projectContents(dir)).scenes.map((s) => s.key)).toContain('two');
    write('scenes/two.json', JSON.stringify({ id: 'renamed!' }));
    expect((await projectContents(dir)).scenes.map((s) => s.key)).toContain('renamed!');
    rmSync(join(dir, 'scenes/two.json'));
  });

  it('is empty for a folder with nothing in it', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'frame-studio-bare-'));
    expect(await projectContents(bare)).toEqual({ videos: [], scenes: [], films: [] });
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('a poster of another project', () => {
  it('reads as a data URL', async () => {
    expect(await projectPoster(dir, 'first-bbbbbbbbbbbb.png')).toBe(`data:image/png;base64,${Buffer.from('new').toString('base64')}`);
  });

  it('never leaves the thumbs folder', async () => {
    expect(await projectPoster(dir, '../../scenes/one.json')).toBeNull();
    expect(await projectPoster(dir, '../thumbs/first-bbbbbbbbbbbb.png')).toBeNull();
    expect(await projectPoster(dir, 'first-000000000000.png')).toBeNull();
  });
});

describe('warm projects', () => {
  const now = 100 * WARM_MS;

  it('keeps the most recently left, for a while', () => {
    const left = new Map([['/a', now - 1000], ['/b', now - 2000], ['/c', now - 3000]]);
    expect([...warmProjects(left, now)].sort()).toEqual(['/a', '/b']);
    expect(WARM_COUNT).toBe(2);
  });

  it('lets one go once it has cooled', () => {
    expect([...warmProjects(new Map([['/a', now - WARM_MS - 1], ['/b', now - 1]]), now)]).toEqual(['/b']);
  });

  it('keeps none when told to', () => {
    expect(warmProjects(new Map([['/a', now]]), now, 0).size).toBe(0);
  });
});

describe('projectStatus', () => {
  it('counts a studio agent as working only while its server runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-status-'));
    mkdirSync(join(dir, '.frame-studio', 'requests'), { recursive: true });
    const thread = { id: 1, sceneId: 'a', status: 'working', agent: 'claude', createdAt: new Date().toISOString(), turns: [{ prompt: 'x', status: 'working', selection: { sceneId: 'a', from: 0, to: 1 }, frame: 0, references: [], claimedAt: new Date().toISOString() }] };
    writeFileSync(join(dir, '.frame-studio', 'requests', '0001.json'), JSON.stringify(thread));
    expect((await projectStatus(dir, true)).working).toBe(1);
    expect((await projectStatus(dir, false)).working).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('projectContents', () => {
  it('lists a copy that kept its scene id under its path, so keys stay unique', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-copy-'));
    mkdirSync(join(root, 'scenes'));
    writeFileSync(join(root, 'scenes', 'a copy.json'), JSON.stringify({ id: 'a' }));
    writeFileSync(join(root, 'scenes', 'a.json'), JSON.stringify({ id: 'a' }));
    const { scenes } = await projectContents(root);
    expect(scenes.map((s) => [s.key, s.invalid]).sort()).toEqual([['a', false], ['scenes/a copy.json', true]]);
    rmSync(root, { recursive: true, force: true });
  });
});
