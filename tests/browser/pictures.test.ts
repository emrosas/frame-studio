/**
 * Picture clips (ADR 0014) on real files, through the render worker: a video
 * reaches the same pixels seeked to as played to, and the HTML export refuses.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Studio } from '../../tools/render/studio';
import { renderClient, startStudio, type TestStudio } from './studio-server';

const FOLDER = mkdtempSync(join(tmpdir(), 'frame-studio-pictures-'));
let server: TestStudio;
let studio: Studio;

beforeAll(async () => {
  for (const dir of ['media', 'compositions', 'scenes']) mkdirSync(join(FOLDER, dir));
  writeFileSync(join(FOLDER, 'project.json'), JSON.stringify({ name: 'Pictures', format: { fps: 30, size: [640, 360] }, cast: {} }));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', join(FOLDER, 'media/clip.mp4')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:size=64x64', '-frames:v', '1', join(FOLDER, 'media/card.png')]);
  writeFileSync(
    join(FOLDER, 'compositions/reel.json'),
    JSON.stringify({
      id: 'reel', fps: 30, duration: 4, size: [640, 360], background: '#101018',
      tracks: [{ id: 'V1', clips: [
        { id: 'video', file: 'media/clip.mp4', start: 0, in: 0.5, out: 2.5 },
        { id: 'card', file: 'media/card.png', start: 2, out: 2, fit: 'contain', params: { scale: 0.5 } },
      ] }],
    }),
  );
  server = await startStudio({ folder: FOLDER });
  studio = await renderClient(server, 'reel');
}, 120_000);

afterAll(async () => {
  await studio?.close();
  await server?.close();
  rmSync(FOLDER, { recursive: true, force: true });
});

const place = (scene: string, file: string) =>
  fetch(`${server.base}__studio/sounds`, { method: 'POST', headers: { ...server.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ scene, file, start: 0.5 }) });

describe('picture clips', () => {
  it('places a picture from the library on a new top track of a video, and refuses a scene', async () => {
    const res = await place('reel', 'media/card.png');
    expect(res.status, await res.clone().text()).toBe(201);
    const reel = JSON.parse(readFileSync(join(FOLDER, 'compositions/reel.json'), 'utf8'));
    expect(reel.tracks.at(-1).clips).toEqual([{ id: 'card-2', file: 'media/card.png', start: 0.5, out: 3 }]);
    reel.tracks.pop();
    writeFileSync(join(FOLDER, 'compositions/reel.json'), JSON.stringify(reel));
    writeFileSync(join(FOLDER, 'scenes/empty.json'), JSON.stringify({ id: 'empty', fps: 30, duration: 2, size: [640, 360], seed: 1, layers: [] }));
    const refused = await place('empty', 'media/card.png');
    expect(refused.ok).toBe(false);
    expect(await refused.text()).toContain('go in a video');
  });

  it('takes a clip\'s fades with it when it moves, and keeps a picture clip\'s out when trimmed to the end', async () => {
    const path = join(FOLDER, 'compositions/reel.json');
    const before = JSON.parse(readFileSync(path, 'utf8'));
    const keyed = structuredClone(before);
    keyed.tracks[0].clips[1].tracks = [{ param: 'opacity', keys: [{ t: 2, v: 0 }, { t: 2.5, v: 1 }] }];
    writeFileSync(path, JSON.stringify(keyed));
    const res = await fetch(`${server.base}__studio/compositions/reel/clip`, {
      method: 'POST',
      headers: { ...server.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip: 'card', start: 3, in: 0, out: null }),
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const clip = JSON.parse(readFileSync(path, 'utf8')).tracks[0].clips[1];
    expect(clip.tracks[0].keys.map((k: { t: number }) => k.t)).toEqual([3, 3.5]);
    expect(clip.out).toBe(2);
    writeFileSync(path, JSON.stringify(before));
  });

  it('draws the same pixels seeked to as played to', async () => {
    const played = new Map<number, string>();
    for (let f = 0; f < 50; f++) played.set(f, await studio.call('pixelHash', f));
    expect(new Set(played.values()).size).toBeGreaterThan(40);
    for (const f of [47, 3, 31, 12, 49, 0, 22]) expect(await studio.call('pixelHash', f), `frame ${f}`).toBe(played.get(f));
  }, 60_000);

  it('shows the image over the video once it starts', async () => {
    const before = await studio.call('pixelHash', 59);
    expect(await studio.call('pixelHash', 60)).not.toBe(before);
  });
});
