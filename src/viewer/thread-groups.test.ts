import { describe, expect, it } from 'vitest';
import type { AgentStatus, ThreadSummary } from '../studio/protocol';
import type { ProjectEntry } from './desktop';
import { ago, isSeen, modelLabel, needsYou, sceneDots, seenKey, threadBadge, threadGroups } from './thread-groups';

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
  folds: {},
  seen: {},
  query: '',
};

describe('the Threads view', () => {
  it('puts the project on screen first and open with its live queue, others folded from disk', () => {
    const groups = threadGroups(base);
    expect(groups.map((g) => [g.path, g.open])).toEqual([['/two', true], ['/three', false]]);
    expect(groups[0].threads.map((t) => t.id)).toEqual([3, 1]);
    expect(groups[1].threads.map((t) => t.id)).toEqual([2, 1]);
  });

  it('sorts newest first by when a thread last moved', () => {
    const live = [thread(1, { at: '2026-11-06T12:00:00.000Z' }), thread(2), thread(3)];
    expect(threadGroups({ ...base, live })[0].threads.map((t) => t.id)).toEqual([1, 3, 2]);
  });

  it('puts settled and cancelled threads under a Done fold, closed until you open it', () => {
    const [two, three] = threadGroups(base);
    expect(two.done.map((t) => t.id)).toEqual([2]);
    expect(three.done.map((t) => t.id)).toEqual([3]);
    expect(two.doneOpen).toBe(false);
    expect(threadGroups({ ...base, folds: { '/two#done': true } })[0].doneOpen).toBe(true);
  });

  it('shares the folds Footage uses', () => {
    expect(threadGroups({ ...base, folds: { '/two': false, '/three': true } }).map((g) => g.open)).toEqual([false, true]);
  });

  it('counts what the fold hides, leaving out what is done', () => {
    expect(threadGroups(base).map((g) => g.count)).toEqual([2, 2]);
  });

  it('has one group in a browser, with its header status from the queue', () => {
    const groups = threadGroups({ ...base, entries: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ path: '/two', current: true, status: { kind: 'your_turn', label: '1 your turn, 1 working' } });
  });

  it('filters titles across projects, opening what matches and dropping the rest', () => {
    const groups = threadGroups({ ...base, entries: [base.entries[0], entry('/three', { threads: [thread(1, { title: 'A Bluer lake' }), thread(2, { title: 'bluer, settled', status: 'settled' })] })], query: ' BLUER ' });
    expect(groups.map((g) => g.path)).toEqual(['/three']);
    expect(groups[0]).toMatchObject({ open: true, doneOpen: true });
    expect(groups[0].threads.map((t) => t.id)).toEqual([1]);
    expect(threadGroups({ ...base, query: 'nothing' })).toEqual([]);
  });

  it('keeps counting what waits on you whatever the filter shows', () => {
    const groups = threadGroups({ ...base, entries: [], query: 'thread 3' });
    expect(groups[0].threads.map((t) => t.id)).toEqual([3]);
    expect(groups[0].waiting).toBe(1);
  });

  it('stops counting a finished turn once you have seen it, until a newer one ends', () => {
    const seen = { [seenKey('/two', 1)]: thread(1).at };
    expect(threadGroups({ ...base, entries: [], seen })[0].waiting).toBe(0);
    const later = thread(1, { at: '2026-11-06T11:00:00.000Z' });
    expect(threadGroups({ ...base, entries: [], live: [later], seen })[0].waiting).toBe(1);
  });

  it('never opens a project whose folder is gone', () => {
    const groups = threadGroups({ ...base, entries: [...base.entries, entry('/gone', { missing: true })], folds: { '/gone': true } });
    expect(groups.at(-1)).toMatchObject({ missing: true, open: false });
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

  it('leaves a stopped or reverted turn as your turn: there was nothing to call done', () => {
    expect(threadBadge(thread(1, { turn: 'stopped' }), true).kind).toBe('your_turn');
    expect(threadBadge(thread(1, { turn: 'reverted' }), true).kind).toBe('your_turn');
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
  });
});

describe('dots on Footage rows', () => {
  it("shows each scene's most pressing thread that's working or waiting", () => {
    const threads = [thread(1, { status: 'working', turn: 'working', sceneId: 'a' }), thread(2, { status: 'input', turn: 'working', sceneId: 'a' }), thread(3, { sceneId: 'b' }), thread(4, { status: 'pending', turn: 'pending', sceneId: 'c' })];
    const dots = sceneDots(threads, () => false);
    expect(dots.a.kind).toBe('input');
    expect(dots.b.kind).toBe('your_turn');
    expect(dots.c.kind).toBe('pending');
  });

  it('leaves out what is done or failed', () => {
    expect(sceneDots([thread(1), thread(2, { turn: 'failed' }), thread(3, { status: 'settled' })], () => true)).toEqual({});
  });
});
