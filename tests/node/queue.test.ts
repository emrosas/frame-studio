/**
 * The request queue on disk (ADR 0003), against temporary folders: create,
 * atomic claims, checkpoints, complete, cancel, requeue, revert, retry and the
 * current selection.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewRequest } from '../../src/studio/protocol';
import { StudioQueue } from '../../tools/studio/queue';

let dir: string;
let sceneFile: string;
let queue: StudioQueue;

const ask = (prompt: string, sceneId = 'bear-test'): NewRequest => ({
  selection: { sceneId, layerId: 'pip', from: 24, to: 48 },
  frame: 30,
  point: { x: 1312, y: 610 },
  prompt,
  references: ['references/sad.png'],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frame-studio-queue-'));
  sceneFile = join(dir, 'scene.json');
  writeFileSync(sceneFile, '{"v":1}\n');
  queue = new StudioQueue(join(dir, '.frame-studio'), async () => sceneFile);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('StudioQueue', () => {
  it('creates numbered pending requests and lists them oldest first', async () => {
    const a = await queue.create(ask('make pip sad'));
    const b = await queue.create(ask('brighten the ground'));
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a).toMatchObject({ status: 'pending', prompt: 'make pip sad', frame: 30, point: { x: 1312, y: 610 } });
    expect((await queue.list()).map((r) => r.id)).toEqual([1, 2]);
    await expect(queue.create(ask('   '))).rejects.toThrow(/needs a prompt/);
  });

  it('never gives two requests created at once the same id', async () => {
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => queue.create(ask(`ask ${i}`))));
    expect(new Set(made.map((r) => r.id)).size).toBe(12);
    expect((await queue.list()).length).toBe(12);
  });

  it('claims the oldest pending request once, checkpointing its scene', async () => {
    await queue.create(ask('first'));
    await queue.create(ask('second'));
    const claimed = await queue.claimNext('agent-a');
    expect(claimed).toMatchObject({ id: 1, status: 'in_progress', claimedBy: 'agent-a', checkpoint: true });
    expect(readFileSync(join(dir, '.frame-studio/requests/0001.before.json'), 'utf8')).toBe('{"v":1}\n');
    expect((await queue.claimNext('agent-b'))?.id).toBe(2);
    expect(await queue.claimNext('agent-c')).toBeNull();
  });

  it('lets only one of two sessions claiming at once win each request', async () => {
    for (let i = 0; i < 5; i++) await queue.create(ask(`ask ${i}`));
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => queue.claimNext(s)));
    const ids = results.filter((r) => r !== null).map((r) => r!.id);
    expect(ids.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('claims a request by id when it is still pending, and just reads it otherwise', async () => {
    await queue.create(ask('by id'));
    expect(await queue.claim(1, 'agent-a')).toMatchObject({ status: 'in_progress', claimedBy: 'agent-a' });
    expect(await queue.claim(1, 'agent-b')).toMatchObject({ status: 'in_progress', claimedBy: 'agent-a' });
    await expect(queue.claim(9, 'agent-a')).rejects.toThrow(/no request #9/);
  });

  it('completes an in-progress request with a summary, and only then', async () => {
    await queue.create(ask('x'));
    await expect(queue.complete(1, 'done', 'did it')).rejects.toThrow(/pending, not in progress/);
    await queue.claimNext('a');
    const done = await queue.complete(1, 'done', ' set pip sad over 24–48 ');
    expect(done).toMatchObject({ status: 'done', summary: 'set pip sad over 24–48' });
    expect(done.completedAt).toBeTruthy();
  });

  it('cancels and requeues, keeping the first checkpoint across a requeue', async () => {
    await queue.create(ask('x'));
    await queue.claimNext('a');
    writeFileSync(sceneFile, '{"v":"half-done"}\n');
    expect((await queue.requeue(1)).status).toBe('pending');
    await queue.claimNext('b');
    expect(readFileSync(join(dir, '.frame-studio/requests/0001.before.json'), 'utf8')).toBe('{"v":1}\n');
    expect((await queue.cancel(1)).status).toBe('cancelled');
    await expect(queue.cancel(1)).rejects.toThrow(/cancelled, so it cannot be cancelled/);
  });

  it('reverts the newest finished request on a scene, and retries it as the next attempt', async () => {
    await queue.create(ask('make pip sad'));
    await queue.claimNext('a');
    writeFileSync(sceneFile, '{"v":2}\n');
    await queue.complete(1, 'done', 'made pip sad');

    const retry = await queue.retry(1, 'sadder, but keep the eyes open');
    expect(readFileSync(sceneFile, 'utf8')).toBe('{"v":1}\n');
    expect((await queue.get(1)).status).toBe('reverted');
    expect(retry).toMatchObject({ id: 2, status: 'pending', attempt: 2, retryOf: 1, prompt: 'sadder, but keep the eyes open', frame: 30 });
    expect(retry.references).toEqual(['references/sad.png']);
  });

  it('refuses to revert anything but the newest claimed request on the scene', async () => {
    await queue.create(ask('one'));
    await queue.claimNext('a');
    writeFileSync(sceneFile, '{"v":2}\n');
    await queue.complete(1, 'done', 'one');
    await queue.create(ask('two'));
    await queue.claimNext('a');
    writeFileSync(sceneFile, '{"v":3}\n');
    await queue.complete(2, 'done', 'two');
    await expect(queue.revert(1)).rejects.toThrow(/cannot be reverted/);
    await queue.revert(2);
    expect(readFileSync(sceneFile, 'utf8')).toBe('{"v":2}\n');
    await queue.revert(1);
    expect(readFileSync(sceneFile, 'utf8')).toBe('{"v":1}\n');
  });

  it('archives finished requests and their checkpoints, keeps the rest, and never reuses their ids', async () => {
    await queue.create(ask('done'));
    await queue.claimNext('a');
    await queue.complete(1, 'done', 'ok');
    await queue.create(ask('waiting'));
    expect(await queue.clearFinished()).toBe(1);
    expect((await queue.list()).map((r) => r.id)).toEqual([2]);
    expect(readFileSync(join(dir, '.frame-studio/requests/archive/0001.json'), 'utf8')).toContain('"done"');
    expect(readFileSync(join(dir, '.frame-studio/requests/archive/0001.before.json'), 'utf8')).toBe('{"v":1}\n');
    await queue.cancel(2);
    await queue.clearFinished();
    expect((await queue.create(ask('after clearing'))).id).toBe(3);
  });

  it('releases a claim whose checkpoint fails, so the request can be claimed once the scene is back', async () => {
    let missing = true;
    const flaky = new StudioQueue(join(dir, '.frame-studio'), async () => {
      if (missing) throw new Error('No scene "bear-test".');
      return sceneFile;
    });
    await flaky.create(ask('x'));
    await expect(flaky.claimNext('a')).rejects.toThrow(/No scene/);
    expect((await flaky.get(1)).status).toBe('pending');
    missing = false;
    expect(await flaky.claimNext('a')).toMatchObject({ id: 1, status: 'in_progress', checkpoint: true });
  });

  it('records when the checkpoint was taken, and keeps that time across a requeue', async () => {
    await queue.create(ask('x'));
    const first = (await queue.claimNext('a'))!;
    expect(first.checkpointAt).toBe(first.claimedAt);
    await queue.requeue(1);
    await new Promise((r) => setTimeout(r, 5));
    const second = (await queue.claimNext('b'))!;
    expect(second.checkpointAt).toBe(first.checkpointAt);
    expect(second.claimedAt).not.toBe(first.claimedAt);
  });

  it('reads, writes and clears the current selection', async () => {
    expect(await queue.readSelection()).toBeNull();
    await queue.writeSelection({ sceneId: 'bear-test', layerId: 'bruno', from: 0, to: 96, frame: 60, point: { x: 760, y: 500 } });
    expect(await queue.readSelection()).toMatchObject({ layerId: 'bruno', frame: 60 });
    await queue.writeSelection(null);
    expect(await queue.readSelection()).toBeNull();
  });
});
