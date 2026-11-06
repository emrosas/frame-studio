// The sidebar's Threads view: one group per listed project (ADR 0013), the
// project on screen first with its live queue, the others from what the app
// read off disk, and what a thread's card says. Pure, so it's tested without a
// browser. Every status word comes from STATUS_LABELS, so a card and the
// panel's header can't disagree.

import { STATUS_LABELS } from './transcript';
import type { AgentId, AgentStatus, ThreadSummary } from '../studio/protocol';
import type { ProjectEntry } from './desktop';
import { groupStatus, type GroupStatus } from './project-groups';

/** Marks turns as seen by the time they ended, so a newer turn counts as new. */
export const seenKey = (project: string, id: number) => `${project}#${id}`;
export const isSeen = (seen: Readonly<Record<string, string>>, project: string, thread: Pick<ThreadSummary, 'id' | 'at'>) => seen[seenKey(project, thread.id)] === thread.at;

export type BadgeKind = 'pending' | 'working' | 'input' | 'your_turn' | 'done' | 'stalled' | 'failed' | 'interrupted' | 'settled' | 'cancelled';

export interface ThreadBadge {
  kind: BadgeKind;
  label: string;
}

/**
 * What a card says. The files only know "your turn", however the turn ended, so:
 * a turn that failed says so, and a finished turn is Your turn until you've
 * looked at it, then Done. `seen` is false for the thread open in the panel,
 * since it's your turn while you're there.
 */
export function threadBadge(thread: Pick<ThreadSummary, 'status' | 'turn'>, seen: boolean): ThreadBadge {
  const kind = ((): BadgeKind => {
    if (thread.status !== 'your_turn') return thread.status;
    if (thread.turn === 'failed' || thread.turn === 'interrupted') return thread.turn;
    return seen ? 'done' : 'your_turn';
  })();
  return { kind, label: STATUS_LABELS[kind] };
}

/** It waits on you: a question, a stuck agent, or a turn that ended and you haven't seen. */
export const needsYou = (thread: Pick<ThreadSummary, 'status'>, seen: boolean) => thread.status === 'input' || thread.status === 'stalled' || (thread.status === 'your_turn' && !seen);

/** "3m" since `iso`; "now" under a minute. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The name of the model a thread's newest turn ran on: its agent's label, or the id itself if the agent no longer lists it. Null when the turn named none. */
export function modelLabel(agents: readonly AgentStatus[], agent: AgentId, model: string | null): string | null {
  // The agent's own default says nothing about what ran.
  if (model === null || model === 'default') return null;
  const family = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  const named = family ? `${family[1][0].toUpperCase()}${family[1].slice(1)} ${family[2]}${family[3] ? `.${family[3]}` : ''}` : model;
  return agents.find((a) => a.id === agent)?.models.find((m) => m.id === model)?.label ?? named;
}

const finished = (t: ThreadSummary) => t.status === 'settled' || t.status === 'cancelled';
const newestFirst = (a: ThreadSummary, b: ThreadSummary) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id;

/** A scene's most pressing thread that's working or waiting, as a Footage row shows it, by scene key. */
export function sceneDots(threads: readonly ThreadSummary[], seen: (t: ThreadSummary) => boolean): Record<string, ThreadBadge> {
  const rank: Partial<Record<BadgeKind, number>> = { input: 4, stalled: 3, failed: 2, interrupted: 2, your_turn: 2, working: 1, pending: 0 };
  const dots: Record<string, ThreadBadge> = {};
  for (const thread of threads) {
    const badge = threadBadge(thread, seen(thread));
    const place = rank[badge.kind];
    if (place === undefined) continue;
    const held = dots[thread.sceneId];
    if (!held || place > (rank[held.kind] ?? -1)) dots[thread.sceneId] = badge;
  }
  return dots;
}

export interface ThreadGroup {
  path: string;
  name: string;
  /** On screen. */
  current: boolean;
  missing: boolean;
  open: boolean;
  status: GroupStatus | null;
  /** Newest first. */
  threads: ThreadSummary[];
  /** Settled and cancelled, newest first, under the Done fold. */
  done: ThreadSummary[];
  doneOpen: boolean;
  /** What the fold hides. */
  count: number;
  /** Threads waiting on you, whatever the filter shows. */
  waiting: number;
}

export function threadGroups(input: {
  /** The recent projects, most recent first. Empty in a browser. */
  entries: readonly ProjectEntry[];
  /** The live queue of the project on screen. */
  live: readonly ThreadSummary[];
  folder: { path: string; name: string };
  /** The sidebar's folds: by path as in Footage, and `<path>#done` for a Done fold. */
  folds: Readonly<Record<string, boolean>>;
  seen: Readonly<Record<string, string>>;
  query: string;
}): ThreadGroup[] {
  const query = input.query.trim().toLowerCase();
  const onScreen = input.entries.find((e) => e.current) ?? input.entries.find((e) => e.path === input.folder.path);

  const group = (path: string, name: string, current: boolean, entry: ProjectEntry | undefined): ThreadGroup => {
    const all = current ? input.live : (entry?.threads ?? []);
    const shown = all.filter((t) => query === '' || t.title.toLowerCase().includes(query)).sort(newestFirst);
    const missing = entry?.missing === true;
    const threads = shown.filter((t) => !finished(t));
    const count = (kind: ThreadSummary['status']) => all.filter((t) => t.status === kind).length;
    return {
      path,
      name,
      current,
      missing,
      open: !missing && (query !== '' || (input.folds[path] ?? current)),
      status: groupStatus({ working: count('working'), input: count('input'), yours: count('your_turn') }),
      threads,
      done: shown.filter(finished),
      doneOpen: query !== '' || (input.folds[`${path}#done`] ?? false),
      count: threads.length,
      waiting: all.filter((t) => needsYou(t, isSeen(input.seen, path, t))).length,
    };
  };

  const first = group(onScreen?.path ?? input.folder.path, onScreen?.name ?? input.folder.name, true, onScreen);
  const others = input.entries.filter((e) => e !== onScreen).map((e) => group(e.path, e.name, false, e));
  const groups = [first, ...others];
  return query === '' ? groups : groups.filter((g) => g.threads.length + g.done.length > 0);
}
