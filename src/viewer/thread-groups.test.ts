import { describe, expect, it } from 'vitest';
import type { AgentStatus, ThreadSummary } from '../studio/protocol';
import type { ProjectEntry } from './desktop';
import { ago, isSeen, modelLabel, needsYou, seenKey, threadBadge, threadList, type ThreadEntry } from './thread-groups';

const thread = (id: number, more: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: `thread ${id}`,
  status: 'your_turn',
  turn: 'done',
  sceneId: 'intro',
  agent: 'claude',
  model: null,
  at: `2026-11-06T10:0${id}:00.000Z`,
  poster: null,
  ...more,
});
const entry = (path: string, more: Partial<ProjectEntry> = {}): ProjectEntry => ({ path, name: path.slice(1), current: false, open: false, working: 0, input: 0, yours: 0, videos: [], scenes: [], films: [], threads: [], ...more });

const base = {
  entries: [entry('/two', { current: true, threads: [thread(9, { title: 'stale copy from disk' })] }), entry('/three', { threads: [thread(1), thread(2), thread(3, { status: 'settled' })] })],
  live: [thread(1), thread(3, { status: 'working', turn: 'working' }), thread(2, { status: 'cancelled', turn: 'cancelled' })],
  folder: { path: '/two', name: 'two' },
  seen: {},
  query: '',
};

describe('the Threads view', () => {
  const ids = (entries: readonly ThreadEntry[]) => entries.map((e) => `${e.path}#${e.thread.id}`);

  it("lists every project's threads in one list, newest first, each naming its project", () => {
    const list = threadList(base);
    // The project on screen brings its live queue, the others what was read off disk.
    expect(ids(list.threads)).toEqual(['/two#3', '/three#2', '/two#1', '/three#1']);
    expect(list.threads[0]).toMatchObject({ path: '/two', name: 'two', current: true });
    expect(list.threads[1]).toMatchObject({ path: '/three', name: 'three', current: false });
  });

  it('sorts newest first by when a thread last moved', () => {
    const live = [thread(1, { at: '2026-11-06T12:00:00.000Z' }), thread(2), thread(3)];
    expect(ids(threadList({ ...base, entries: [], live }).threads)).toEqual(['/two#1', '/two#3', '/two#2']);
  });

  it('puts settled and cancelled threads under one Done fold', () => {
    expect(ids(threadList(base).done)).toEqual(['/three#3', '/two#2']);
  });

  it('has the one project in a browser', () => {
    const list = threadList({ ...base, entries: [] });
    expect(new Set(list.threads.map((e) => e.path))).toEqual(new Set(['/two']));
  });

  it("filters by title or project name across projects", () => {
    const entries = [base.entries[0], entry('/three', { threads: [thread(1, { title: 'A Bluer lake' }), thread(2, { title: 'bluer, settled', status: 'settled' })] })];
    const list = threadList({ ...base, entries, query: ' BLUER ' });
    expect(ids(list.threads)).toEqual(['/three#1']);
    expect(ids(list.done)).toEqual(['/three#2']);
    expect(ids(threadList({ ...base, query: 'three' }).threads)).toEqual(['/three#2', '/three#1']);
    expect(threadList({ ...base, query: 'nothing' })).toMatchObject({ threads: [], done: [] });
  });

  it('keeps counting what waits on you whatever the filter shows', () => {
    const list = threadList({ ...base, entries: [], query: 'thread 3' });
    expect(ids(list.threads)).toEqual(['/two#3']);
    expect(list.waiting).toBe(1);
  });

  it('counts what waits on you in every project', () => {
    expect(threadList(base).waiting).toBe(3);
  });

  it('stops counting a finished turn once you have seen it, until a newer one ends', () => {
    const seen = { [seenKey('/two', 1)]: thread(1).at };
    expect(threadList({ ...base, entries: [], seen }).waiting).toBe(0);
    const later = thread(1, { at: '2026-11-06T11:00:00.000Z' });
    expect(threadList({ ...base, entries: [], live: [later], seen }).waiting).toBe(1);
  });

  it('leaves out a project whose folder is gone', () => {
    const list = threadList({ ...base, entries: [...base.entries, entry('/gone', { missing: true, threads: [thread(7)] })] });
    expect(list.threads.some((e) => e.path === '/gone')).toBe(false);
  });
});

describe('what a card says', () => {
  it("says a finished turn is your turn until you've looked at it, then done", () => {
    expect(threadBadge(thread(1), false)).toEqual({ kind: 'your_turn', label: 'Your turn' });
    expect(threadBadge(thread(1), true)).toEqual({ kind: 'done', label: 'Done' });
  });

  it('keeps a failure red, seen or not', () => {
    for (const seen of [false, true]) {
      expect(threadBadge(thread(1, { turn: 'failed' }), seen)).toEqual({ kind: 'failed', label: 'Failed' });
      expect(threadBadge(thread(1, { turn: 'interrupted' }), seen)).toEqual({ kind: 'interrupted', label: 'Interrupted' });
    }
  });

  it('treats a stopped or reverted turn like a finished one: Your turn until seen', () => {
    expect(threadBadge(thread(1, { turn: 'stopped' }), false).kind).toBe('your_turn');
    expect(threadBadge(thread(1, { turn: 'stopped' }), true).kind).toBe('done');
    expect(threadBadge(thread(1, { turn: 'reverted' }), true).kind).toBe('done');
  });

  it('uses the shared words for the rest', () => {
    const says = (status: ThreadSummary['status']) => threadBadge(thread(1, { status }), false).label;
    expect([says('pending'), says('working'), says('input'), says('stalled'), says('settled'), says('cancelled')]).toEqual(['Waiting', 'Working', 'Needs you', 'Stalled', 'Settled', 'Cancelled']);
  });

  it('counts questions, stuck agents and unseen turns as waiting on you', () => {
    expect(needsYou({ status: 'input' }, true)).toBe(true);
    expect(needsYou({ status: 'stalled' }, true)).toBe(true);
    expect(needsYou({ status: 'your_turn' }, false)).toBe(true);
    expect(needsYou({ status: 'your_turn' }, true)).toBe(false);
    expect(needsYou({ status: 'working' }, false)).toBe(false);
  });

  it('reads seen turns by project', () => {
    const seen = { [seenKey('/a', 1)]: thread(1).at };
    expect(isSeen(seen, '/a', thread(1))).toBe(true);
    expect(isSeen(seen, '/b', thread(1))).toBe(false);
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-11-06T12:00:00.000Z');
    const before = (ms: number) => ago(new Date(now - ms).toISOString(), now);
    expect([before(5_000), before(180_000), before(7_200_000), before(259_200_000)]).toEqual(['now', '3m', '2h', '3d']);
  });

  it("names the model its agent lists, its id if the agent doesn't, and nothing if the turn named none", () => {
    const agents = [{ id: 'claude', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] }] as AgentStatus[];
    expect(modelLabel(agents, 'claude', 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel(agents, 'claude', 'retired-model')).toBe('retired-model');
    expect(modelLabel(agents, 'claude', null)).toBeNull();
    expect(modelLabel(agents, 'claude', 'default')).toBeNull();
  });
});
