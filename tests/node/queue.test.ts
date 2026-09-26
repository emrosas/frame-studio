/**
 * The request queue on disk (ADR 0003, ADR 0006), against temporary folders:
 * threads and their turns, atomic claims, one working thread per scene,
 * per-turn checkpoints, Revert to here, Try again, settling, old request
 * files, and the current selection.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewRequest } from '../../src/studio/protocol';
import { StudioQueue } from '../../tools/studio/queue';

let dir: string;
let queue: StudioQueue;
const scenes = new Map<string, string>();
const scene = (id = 'bear-test') => scenes.get(id)!;
const requests = () => join(dir, '.frame-studio/requests');

const ask = (prompt: string, sceneId = 'bear-test', extra: Partial<NewRequest> = {}): NewRequest => ({
  selection: { sceneId, layerId: 'pip', from: 24, to: 48 },
  frame: 30,
  point: { x: 1312, y: 610 },
  prompt,
  references: ['references/sad.png'],
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frame-studio-queue-'));
  scenes.clear();
  for (const id of ['bear-test', 'hello', 'shapes-test']) {
    const file = join(dir, `${id}.json`);
    writeFileSync(file, '{"v":1}\n');
    scenes.set(id, file);
  }
  queue = new StudioQueue(join(dir, '.frame-studio'), async (id) => {
    const file = scenes.get(id);
    if (!file) throw new Error(`No scene "${id}".`);
    return file;
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Claims thread `id`'s pending turn, writes `v` into its scene as the agent's edit, and completes the turn. */
async function work(id: number, v: string, session = 'a'): Promise<void> {
  const claimed = await queue.claim(id, session);
  expect(claimed.status, `claim #${id}`).toBe('working');
  writeFileSync(scene(claimed.sceneId), `{"v":"${v}"}\n`);
  await queue.complete(id, 'done', `set v to ${v}`);
}

describe('threads', () => {
  it('starts numbered pending threads with one turn, and lists them oldest first', async () => {
    const a = await queue.create(ask('make pip sad'));
    const b = await queue.create(ask('brighten the ground', 'hello', { agent: 'claude', settings: { access: 'studio', model: 'opus' } }));
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a).toMatchObject({ status: 'pending', agent: 'external', sceneId: 'bear-test' });
    expect(a.turns).toHaveLength(1);
    expect(a.turns[0]).toMatchObject({ status: 'pending', ask: { prompt: 'make pip sad', frame: 30, point: { x: 1312, y: 610 } } });
    expect(b).toMatchObject({ agent: 'claude', turns: [{ settings: { access: 'studio', model: 'opus' } }] });
    expect((await queue.list()).map((r) => r.id)).toEqual([1, 2]);
    await expect(queue.create(ask('   '))).rejects.toThrow(/needs a prompt/);
  });

  it('never gives two threads started at once the same id', async () => {
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => queue.create(ask(`ask ${i}`))));
    expect(new Set(made.map((r) => r.id)).size).toBe(12);
    expect((await queue.list()).length).toBe(12);
  });

  it('works a turn: claim with a checkpoint, complete with a summary, and the thread is yours', async () => {
    await queue.create(ask('first'));
    const claimed = (await queue.claimNext('agent-a'))!;
    expect(claimed).toMatchObject({ id: 1, status: 'working', turns: [{ status: 'working', claimedBy: 'agent-a' }] });
    expect(claimed.turns[0].checkpointAt).toBe(claimed.turns[0].claimedAt);
    expect(readFileSync(join(requests(), '0001.before.json'), 'utf8')).toBe('{"v":1}\n');
    await expect(queue.settle(1)).rejects.toThrow(/working, so it cannot be settled/);
    const done = await queue.complete(1, 'done', ' set pip sad over 24–48 ', { usage: { inputTokens: 900, outputTokens: 120 } });
    expect(done).toMatchObject({ status: 'your_turn', turns: [{ status: 'done', summary: 'set pip sad over 24–48', usage: { inputTokens: 900 } }] });
    await expect(queue.complete(1, 'done', 'again')).rejects.toThrow(/no turn working/);
  });

  it('continues with a reply: a new pending turn, its own checkpoint, and settling closes it', async () => {
    await queue.create(ask('make pip sad'));
    await work(1, 'sad');
    await expect(queue.reply(1, ask('now on hello', 'hello'))).rejects.toThrow(/about scene "bear-test"/);
    const replied = await queue.reply(1, ask('a bit less sad', 'bear-test', { settings: { access: 'full' } }));
    expect(replied).toMatchObject({ status: 'pending', turns: [{ status: 'done' }, { status: 'pending', settings: { access: 'full' } }] });
    await expect(queue.reply(1, ask('more'))).rejects.toThrow(/pending; wait/);
    await work(1, 'a bit sad');
    expect(readFileSync(join(requests(), '0001.1.before.json'), 'utf8')).toBe('{"v":"sad"}\n');
    const settled = await queue.settle(1);
    expect(settled.status).toBe('settled');
    expect(settled.settledAt).toBeTruthy();
    // A reply reopens a settled thread.
    const reopened = await queue.reply(1, ask('one more thing'));
    expect(reopened.status).toBe('pending');
    expect(reopened.settledAt).toBeUndefined();
  });

  it('lets only one of several sessions claiming at once win each thread', async () => {
    for (const [i, id] of ['bear-test', 'hello', 'shapes-test'].entries()) await queue.create(ask(`ask ${i}`, id));
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => queue.claimNext(s)));
    const ids = results.filter((r) => r !== null).map((r) => r!.id);
    expect(ids.sort()).toEqual([1, 2, 3]);
  });

  it('works one thread per scene at a time, and threads on other scenes in parallel', async () => {
    await queue.create(ask('one', 'bear-test'));
    await queue.create(ask('two', 'bear-test'));
    await queue.create(ask('three', 'hello'));
    expect((await queue.claimNext('a'))?.id).toBe(1);
    expect((await queue.claimNext('b'))?.id).toBe(3); // 2 waits for 1
    expect(await queue.claimNext('c')).toBeNull();
    expect((await queue.claim(2, 'c')).status).toBe('pending');
    await queue.complete(1, 'done', 'one');
    expect((await queue.claimNext('c'))?.id).toBe(2);
  });

  it('takes over a scene lock left by a thread that is not working any more', async () => {
    await queue.create(ask('one'));
    await queue.create(ask('two'));
    writeFileSync(join(requests(), `scene-${encodeURIComponent('bear-test')}.lock`), '1');
    expect((await queue.claimNext('a'))?.id).toBe(1); // its own lock
    await queue.complete(1, 'done', 'one');
    writeFileSync(join(requests(), `scene-${encodeURIComponent('bear-test')}.lock`), '1'); // stale: 1 is not working
    expect((await queue.claimNext('a'))?.id).toBe(2);
  });

  it('claims only threads for the agents asked for', async () => {
    await queue.create(ask('for claude', 'bear-test', { agent: 'claude' }));
    await queue.create(ask('for anyone', 'hello'));
    expect((await queue.claimNext('mcp'))?.id).toBe(2);
    expect(await queue.claimNext('mcp')).toBeNull();
    expect((await queue.claim(1, 'mcp')).status).toBe('pending'); // get_request only reads another agent's thread
    expect((await queue.claimNext('studio', ['claude', 'codex']))?.id).toBe(1);
  });

  it('claims a thread by id when its turn is pending, and just reads it otherwise', async () => {
    await queue.create(ask('by id'));
    expect(await queue.claim(1, 'agent-a')).toMatchObject({ status: 'working', turns: [{ claimedBy: 'agent-a' }] });
    expect(await queue.claim(1, 'agent-b')).toMatchObject({ status: 'working', turns: [{ claimedBy: 'agent-a' }] });
    await expect(queue.claim(9, 'agent-a')).rejects.toThrow(/no request #9/);
  });

  it('stops or interrupts a working turn, keeping the edits, and remembers the provider session', async () => {
    await queue.create(ask('x', 'bear-test', { agent: 'claude' }));
    await queue.claimNext('studio', ['claude']);
    await queue.setSession(1, 'sess-123');
    writeFileSync(scene(), '{"v":"half"}\n');
    const stopped = await queue.endTurn(1, 'stopped');
    expect(stopped).toMatchObject({ status: 'your_turn', session: 'sess-123', turns: [{ status: 'stopped' }] });
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":"half"}\n');
    await queue.reply(1, ask('go on'));
    await queue.claimNext('studio', ['claude']);
    expect((await queue.endTurn(1, 'interrupted')).turns[1].status).toBe('interrupted');
    // The scene is free again.
    await queue.create(ask('next', 'bear-test'));
    expect((await queue.claimNext('mcp'))?.id).toBe(2);
  });

  it('cancels a waiting turn, and a thread with nothing else in it', async () => {
    await queue.create(ask('x'));
    expect((await queue.cancel(1)).status).toBe('cancelled');
    await expect(queue.cancel(1)).rejects.toThrow(/no waiting or working turn/);
    await queue.create(ask('y', 'hello'));
    await work(2, 'y');
    await queue.reply(2, ask('then this', 'hello'));
    const cancelled = await queue.cancel(2);
    expect(cancelled).toMatchObject({ status: 'your_turn', turns: [{ status: 'done' }, { status: 'cancelled' }] });
  });

  it('requeues a stalled or failed turn, keeping its first checkpoint', async () => {
    await queue.create(ask('x'));
    const first = (await queue.claimNext('a'))!;
    writeFileSync(scene(), '{"v":"half-done"}\n');
    expect((await queue.requeue(1)).status).toBe('pending');
    await new Promise((r) => setTimeout(r, 5));
    const second = (await queue.claimNext('b'))!;
    expect(second.turns[0].checkpointAt).toBe(first.turns[0].checkpointAt);
    expect(second.turns[0].claimedAt).not.toBe(first.turns[0].claimedAt);
    expect(readFileSync(join(requests(), '0001.before.json'), 'utf8')).toBe('{"v":1}\n');
    await queue.complete(1, 'failed', 'could not');
    expect((await queue.requeue(1)).status).toBe('pending');
  });
});

describe('undo', () => {
  it('reverts to any finished turn, marking it and later turns reverted, and continues from there', async () => {
    await queue.create(ask('one'));
    await work(1, 'one');
    await queue.reply(1, ask('two'));
    await work(1, 'two');
    await queue.reply(1, ask('three'));
    await work(1, 'three');
    const back = await queue.revertTo(1, 1);
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":"one"}\n');
    expect(back.turns.map((t) => t.status)).toEqual(['done', 'reverted', 'reverted']);
    expect(back.status).toBe('your_turn');
    await expect(queue.revertTo(1, 2)).rejects.toThrow(/cannot be reverted to turn 3/);
    await queue.revertTo(1, 0);
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":1}\n');
  });

  it("never reverts over another thread's later work on the scene, but steps back one thread at a time", async () => {
    await queue.create(ask('one'));
    await work(1, 'one');
    await queue.create(ask('two'));
    await work(2, 'two');
    await expect(queue.revertTo(1, 0)).rejects.toThrow(/cannot be reverted/);
    await queue.revertTo(2, 0);
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":"one"}\n');
    await queue.revertTo(1, 0);
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":1}\n');
  });

  it('reverts a whole settled thread, and reopens it', async () => {
    await queue.create(ask('one'));
    await work(1, 'one');
    await queue.reply(1, ask('two'));
    await work(1, 'two');
    await queue.settle(1);
    const back = await queue.revertAll(1);
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":1}\n');
    expect(back).toMatchObject({ status: 'your_turn', turns: [{ status: 'reverted' }, { status: 'reverted' }] });
  });

  it('tries again: reverts the newest turn and asks the same again, as the next attempt', async () => {
    await queue.create(ask('make pip sad'));
    await work(1, 'sad');
    const retry = await queue.retry(1, 'sadder, but keep the eyes open');
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":1}\n');
    expect(retry.status).toBe('pending');
    expect(retry.turns.map((t) => t.status)).toEqual(['reverted', 'pending']);
    expect(retry.turns[1]).toMatchObject({ attempt: 2, ask: { prompt: 'sadder, but keep the eyes open', frame: 30, references: ['references/sad.png'] } });
  });
});

describe('projects (ADR 0007)', () => {
  let project: string;
  beforeEach(() => {
    const folder = join(dir, 'projects/story');
    mkdirSync(folder, { recursive: true });
    project = join(folder, 'project.json');
    writeFileSync(project, '{"cast":1}\n');
    for (const id of ['one', 'two']) {
      writeFileSync(join(folder, `${id}.json`), '{"v":1}\n');
      scenes.set(`story/${id}`, join(folder, `${id}.json`));
    }
  });

  /** Works a turn on a project scene, changing project.json too when `cast` is given. */
  async function workProject(id: number, v: string, cast?: string, session = 'a'): Promise<void> {
    const claimed = await queue.claim(id, session);
    expect(claimed.status, `claim #${id}`).toBe('working');
    writeFileSync(scene(claimed.sceneId), `{"v":"${v}"}\n`);
    if (cast !== undefined) writeFileSync(project, `{"cast":"${cast}"}\n`);
    await queue.complete(id, 'done', `set v to ${v}`);
  }

  it("keeps project.json with a project scene's checkpoint, and marks the turns that changed it", async () => {
    await queue.create(ask('one', 'story/one'));
    await workProject(1, 'one');
    expect(readFileSync(join(requests(), '0001.project.before.json'), 'utf8')).toBe('{"cast":1}\n');
    await queue.reply(1, ask('recast', 'story/one'));
    await workProject(1, 'two', 'bruno');
    expect(readFileSync(join(requests(), '0001.1.project.before.json'), 'utf8')).toBe('{"cast":1}\n');
    expect((await queue.get(1)).turns.map((t) => t.projectChanged ?? false)).toEqual([false, true]);
    // A loose scene's turn keeps no project copy.
    await queue.create(ask('loose', 'hello'));
    await work(2, 'x');
    expect(existsSync(join(requests(), '0002.project.before.json'))).toBe(false);
  });

  it('reverts project.json with the scene when the turns undone changed it, and only then', async () => {
    await queue.create(ask('recast', 'story/one'));
    await workProject(1, 'one', 'bruno');
    await queue.reply(1, ask('scene only', 'story/one'));
    await workProject(1, 'two');
    await queue.revertTo(1, 1);
    expect(readFileSync(scene('story/one'), 'utf8')).toBe('{"v":"one"}\n');
    expect(readFileSync(project, 'utf8')).toBe('{"cast":"bruno"}\n');
    await queue.revertTo(1, 0);
    expect(readFileSync(scene('story/one'), 'utf8')).toBe('{"v":1}\n');
    expect(readFileSync(project, 'utf8')).toBe('{"cast":1}\n');
  });

  it("won't restore project.json while another thread in the project works, or over its later change", async () => {
    await queue.create(ask('recast', 'story/one'));
    await workProject(1, 'one', 'bruno');
    await queue.create(ask('shot two', 'story/two'));
    await queue.claim(2, 'b');
    await expect(queue.revertTo(1, 0)).rejects.toThrow(/cannot be reverted/);
    writeFileSync(project, '{"cast":"pip"}\n');
    await queue.complete(2, 'done', 'recast again');
    expect((await queue.get(2)).turns[0].projectChanged).toBe(true);
    await expect(queue.revertTo(1, 0)).rejects.toThrow(/cannot be reverted/);
    await queue.revertTo(2, 0);
    expect(readFileSync(project, 'utf8')).toBe('{"cast":"bruno"}\n');
    await queue.revertTo(1, 0);
    expect(readFileSync(project, 'utf8')).toBe('{"cast":1}\n');
  });

  it('remembers a project.json change by a turn cancelled while it worked, and holds back reverts over it', async () => {
    await queue.create(ask('one', 'story/one'));
    await workProject(1, 'one');
    await queue.create(ask('recast', 'story/two'));
    await queue.claim(2, 'b');
    writeFileSync(project, '{"cast":"pip"}\n');
    const cancelled = await queue.cancel(2);
    expect(cancelled.turns[0]).toMatchObject({ status: 'cancelled', projectChanged: true });
    // Thread 1's revert leaves project.json alone, so thread 2's change doesn't stop it.
    await queue.revertTo(1, 0);
    expect(readFileSync(project, 'utf8')).toBe('{"cast":"pip"}\n');
  });

  it("archives a thread's project.json copies with it", async () => {
    await queue.create(ask('recast', 'story/one'));
    await workProject(1, 'one', 'bruno');
    await queue.settle(1);
    await queue.clearFinished();
    expect(existsSync(join(requests(), 'archive/0001.project.before.json'))).toBe(true);
  });
});

describe('housekeeping', () => {
  it('archives settled and cancelled threads with their checkpoints and logs, and never reuses their ids', async () => {
    await queue.create(ask('done'));
    await work(1, 'done');
    await queue.reply(1, ask('more'));
    await work(1, 'more');
    await queue.settle(1);
    await queue.create(ask('waiting', 'hello'));
    expect(await queue.clearFinished()).toBe(1);
    expect((await queue.list()).map((r) => r.id)).toEqual([2]);
    expect(readFileSync(join(requests(), 'archive/0001.json'), 'utf8')).toContain('"settled"');
    expect(readFileSync(join(requests(), 'archive/0001.before.json'), 'utf8')).toBe('{"v":1}\n');
    expect(existsSync(join(requests(), 'archive/0001.1.before.json'))).toBe(true);
    await queue.cancel(2);
    await queue.clearFinished();
    expect((await queue.create(ask('after clearing'))).id).toBe(3);
  });

  it('fails a turn whose scene is gone, without holding up the threads after it', async () => {
    let missing = true;
    const flaky = new StudioQueue(join(dir, '.frame-studio'), async (id) => {
      if (missing && id === 'bear-test') throw new Error('No scene "bear-test".');
      return scene(id);
    });
    await flaky.create(ask('x'));
    await flaky.create(ask('y', 'hello'));
    expect((await flaky.claimNext('a'))?.id).toBe(2);
    expect(await flaky.get(1)).toMatchObject({ status: 'your_turn', turns: [{ status: 'failed', summary: 'Could not start: No scene "bear-test".' }] });
    // Claimed by id, as get_request does, the error goes to the agent and the turn stays waiting.
    await flaky.reply(1, ask('again'));
    await expect(flaky.claim(1, 'a')).rejects.toThrow(/No scene/);
    expect((await flaky.get(1)).status).toBe('pending');
    missing = false;
    expect(await flaky.claim(1, 'a')).toMatchObject({ id: 1, status: 'working' });
  });

  it('lets only one of many claims at once work a scene, across queues sharing the folder', async () => {
    for (let round = 0; round < 20; round++) {
      const a = await queue.create(ask(`a ${round}`));
      const b = await queue.create(ask(`b ${round}`));
      const other = new StudioQueue(join(dir, '.frame-studio'), async (id) => scene(id));
      await Promise.all([queue.claimNext('one'), other.claimNext('two'), queue.claim(b.id, 'three'), other.claim(a.id, 'four')]);
      const working = (await queue.list()).filter((r) => r.status === 'working');
      expect(working.map((r) => r.id), `round ${round}`).toHaveLength(1);
      await queue.complete(working[0].id, 'done', 'ok');
      const left = (await queue.list()).find((r) => r.status === 'pending')!;
      await queue.claim(left.id, 'five');
      await queue.complete(left.id, 'done', 'ok');
    }
  });

  it('lets only the owner of a working turn end it', async () => {
    await queue.create(ask('x', 'bear-test', { agent: 'claude' }));
    await queue.claimNext('studio-1', ['claude']);
    await expect(queue.complete(1, 'done', 'from outside', {}, { agents: ['external'] })).rejects.toThrow(/studio's claude agent, not by you/);
    await queue.cancel(1);
    await queue.reply(1, ask('go on'));
    await queue.claimNext('studio-2', ['claude']);
    // The first run finishing late must not end the second run's turn.
    await expect(queue.endTurn(1, 'stopped', undefined, {}, { session: 'studio-1', turn: 0 })).rejects.toThrow(/moved on to another turn/);
    expect((await queue.complete(1, 'done', 'second', {}, { session: 'studio-2', turn: 1 })).turns[1].status).toBe('done');
  });

  it('clears claim files a crash left on threads that are not working', async () => {
    await queue.create(ask('x'));
    writeFileSync(join(requests(), '0001.claim'), 'crashed');
    await queue.clearOrphanClaims(60_000);
    expect(existsSync(join(requests(), '0001.claim'))).toBe(true); // too new to be sure
    await queue.clearOrphanClaims(0);
    expect(existsSync(join(requests(), '0001.claim'))).toBe(false);
    expect((await queue.claimNext('a'))?.id).toBe(1);
  });

  it('reads request files written before threads as one-turn threads', async () => {
    const legacy = {
      id: 7,
      createdAt: '2026-09-24T10:00:00.000Z',
      status: 'done',
      selection: { sceneId: 'bear-test', layerId: 'pip', from: 36, to: 72 },
      frame: 40,
      prompt: 'Give pip rosy cheeks',
      references: ['references/bears.png'],
      claimedAt: '2026-09-24T10:01:00.000Z',
      claimedBy: 'mcp-1',
      completedAt: '2026-09-24T10:05:00.000Z',
      summary: 'added bear.blush',
      checkpoint: true,
      checkpointAt: '2026-09-24T10:01:00.000Z',
    };
    await queue.create(ask('make the dir'));
    writeFileSync(join(requests(), '0007.json'), JSON.stringify(legacy));
    writeFileSync(join(requests(), '0007.before.json'), '{"v":"before rosy"}\n');
    const thread = await queue.get(7);
    expect(thread).toMatchObject({ status: 'your_turn', agent: 'external', sceneId: 'bear-test' });
    expect(thread.turns).toEqual([
      expect.objectContaining({ status: 'done', summary: 'added bear.blush', checkpointAt: legacy.checkpointAt, ask: expect.objectContaining({ prompt: 'Give pip rosy cheeks', frame: 40 }) }),
    ]);
    await queue.revertTo(7, 0);
    expect(readFileSync(scene(), 'utf8')).toBe('{"v":"before rosy"}\n');
  });

  it('reads, writes and clears the current selection', async () => {
    expect(await queue.readSelection()).toBeNull();
    await queue.writeSelection({ sceneId: 'bear-test', layerId: 'bruno', from: 0, to: 96, frame: 60, point: { x: 760, y: 500 } });
    expect(await queue.readSelection()).toMatchObject({ layerId: 'bruno', frame: 60 });
    await queue.writeSelection(null);
    expect(await queue.readSelection()).toBeNull();
  });
});
