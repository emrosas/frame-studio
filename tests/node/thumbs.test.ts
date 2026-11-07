import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/engine/types';
import { posterFrame, Thumbs } from '../../tools/studio/thumbs';

const scene = (id: string, seed = 1): Scene => ({ id, fps: 30, duration: 9, size: [1080, 1920], seed, layers: [{ id: 'a', rig: 'circle' }] });

describe('posters', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'thumbs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function service(current: () => Scene[], fail = false) {
    const rendered: { key: string; frame: number; maxWidth: number }[] = [];
    const pushed: string[] = [];
    let settle: () => void = () => {};
    const thumbs = new Thumbs({
      dir,
      enabled: true,
      entries: async () => ({ entries: current().map((s) => ({ key: s.id, scene: s, project: null, kind: 'scene' as const, world: {} })), shared: null }),
      render: async (key, frame, path, maxWidth) => {
        if (fail) throw new Error('rig threw');
        rendered.push({ key, frame, maxWidth });
        writeFileSync(path, 'png');
      },
      push: (_key, file) => {
        pushed.push(file);
        settle();
      },
    });
    return { thumbs, rendered, pushed, arrived: () => new Promise<void>((resolve) => (settle = resolve)) };
  }

  it('answers at once, renders what is missing at a third of the way in, and keeps the file named by what it shows', async () => {
    const s = service(() => [scene('one')]);
    const arrived = s.arrived();
    expect(await s.thumbs.list()).toEqual({ one: null });
    await arrived;
    expect(s.rendered).toEqual([{ key: 'one', frame: posterFrame(scene('one')), maxWidth: 270 }]);
    expect(s.rendered[0].frame).toBe(90);
    const again = await s.thumbs.list();
    expect(again.one).toBe(s.pushed[0]);
    expect(s.rendered.length).toBe(1);
  });

  it('renders again when the scene changes, and drops the old file', async () => {
    let seed = 1;
    const s = service(() => [scene('one', seed)]);
    let arrived = s.arrived();
    await s.thumbs.list();
    await arrived;
    seed = 2;
    arrived = s.arrived();
    expect((await s.thumbs.list()).one).toBeNull();
    await arrived;
    expect(readdirSync(dir)).toEqual([s.pushed[1]]);
    expect(s.pushed[1]).not.toBe(s.pushed[0]);
  });

  it('leaves the placeholder after a failure and does not try that version again', async () => {
    const s = service(() => [scene('one')], true);
    await s.thumbs.list();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.thumbs.list();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.pushed).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does nothing when turned off', async () => {
    const thumbs = new Thumbs({ dir, enabled: false, entries: () => Promise.reject(new Error('never')), render: () => Promise.reject(new Error('never')), push: () => {} });
    expect(await thumbs.list()).toEqual({});
  });
});
