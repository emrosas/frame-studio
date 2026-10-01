import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { convertFilm, convertFilmFiles } from '../../tools/studio/convert.ts';

const format = { fps: 12, duration: 6, size: [640, 360] };

describe('converting an M9 film (ADR 0013)', () => {
  it('keeps drawing scenes, and turns a placing scene into a composition whose cut-out scenes draw what it drew', () => {
    const film = convertFilmFiles(
      { name: 'Film', fps: 12, size: [640, 360], main: 'film', cast: { bo: { rig: 'bear' } } },
      {
        shot: { id: 'shot', ...format, layers: [{ id: 'bo', cast: 'bo' }] },
        film: {
          id: 'film',
          ...format,
          seed: 4,
          background: { rig: 'paper' },
          layers: [
            { id: 'title', rig: 'text', params: { text: 'Hi' } },
            { id: 'a', scene: 'shot', start: 1, out: 2, mask: { rig: 'iris' } },
            { id: 'sun', rig: 'paper' },
            { id: 'moon', rig: 'paper' },
            { id: 'b', scene: 'shot', start: 3 },
          ],
          audio: [{ id: 'vo', file: 'media/vo.wav', start: 0, end: 2 }],
        },
      },
    );
    expect(film.project).toEqual({ name: 'Film', fps: 12, size: [640, 360], cast: { bo: { rig: 'bear' } } });
    expect(Object.keys(film.scenes).sort()).toEqual(['film-background', 'film-sun', 'film-title', 'shot']);
    expect(film.scenes['film-background']).toEqual({ id: 'film-background', ...format, seed: 4, background: { rig: 'paper' }, layers: [] });
    expect(film.scenes['film-sun'].layers).toEqual([{ id: 'sun', rig: 'paper' }, { id: 'moon', rig: 'paper' }]);
    expect(film.compositions.film).toEqual({
      id: 'film',
      ...format,
      seed: 4,
      tracks: [
        {
          id: 'V1',
          clips: [
            { id: 'backdrop', scene: 'film-background', start: 0 },
            { id: 'title', scene: 'film-title', start: 0 },
            { id: 'a', scene: 'shot', start: 1, out: 2, mask: { rig: 'iris' } },
            { id: 'sun', scene: 'film-sun', start: 0 },
            { id: 'b', scene: 'shot', start: 3 },
          ],
        },
      ],
      audio: [{ id: 'vo', file: 'media/vo.wav', start: 0, end: 2 }],
    });
    expect(film.media).toEqual(['media/vo.wav']);
  });

  it('picks scene ids the film has no use for yet', () => {
    const film = convertFilmFiles({}, {
      'film-background': { id: 'film-background', ...format, layers: [] },
      film: { id: 'film', ...format, background: { rig: 'paper' }, layers: [{ id: 'x', scene: 'film-background' }] },
    });
    expect(film.compositions.film.tracks).toEqual([{ id: 'V1', clips: [{ id: 'backdrop', scene: 'film-background-2', start: 0 }, { id: 'x', scene: 'film-background' }] }]);
  });

  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes the project folder for the repo film, and refuses a folder with files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'convert-'));
    const to = join(dir, 'bears');
    await convertFilm('projects/bears-story', to, '.');
    expect((await readdir(to)).sort()).toEqual(['audio', 'compositions', 'media', 'project.json', 'rigs', 'scenes']);
    expect((await readdir(join(to, 'scenes'))).sort()).toEqual(['film-background.json', 'meet.json', 'pip.json', 'together.json']);
    expect(await readdir(join(to, 'rigs'))).toEqual(['iris.ts']);
    const project = JSON.parse(await readFile(join(to, 'project.json'), 'utf8')) as Record<string, unknown>;
    expect(project.main).toBeUndefined();
    expect(Object.keys(project.cast as object).sort()).toEqual(['bruno', 'pip']);
    await expect(convertFilm('projects/bears-story', to, '.')).rejects.toThrow(/already has files/);
  });
});
