// The sidebar's Threads view: every listed project's threads in one list
// (ADR 0013), the project on screen's from its live queue, the others' from
// what the app read off disk, and what a thread's card says. Pure, so it's
// tested without a browser. Every status word comes from STATUS_LABELS, so a
// card and the panel's header can't disagree.

import { STATUS_LABELS } from './transcript';
import type { AgentId, AgentStatus, ThreadSummary } from '../studio/protocol';
import type { ProjectEntry } from './desktop';

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

/** A thread with the project it belongs to, since one list holds every project's. */
export interface ThreadEntry {
  thread: ThreadSummary;
  path: string;
  name: string;
  /** Its project is on screen. */
  current: boolean;
}

export interface ThreadList {
  /** Working or waiting, newest first, across every project. */
  threads: ThreadEntry[];
  /** Settled and cancelled, newest first, under the Done fold. */
  done: ThreadEntry[];
  /** Threads waiting on you, whatever the filter shows. */
  waiting: number;
}

const newestFirst = (a: ThreadEntry, b: ThreadEntry) => Date.parse(b.thread.at) - Date.parse(a.thread.at) || b.thread.id - a.thread.id;

/**
 * The sidebar's Threads view: one list, newest first, each thread naming its
 * project, so no project needs a fold of its own (ADR 0013). The project on
 * screen brings its live queue, the others what the app read off disk.
 */
export function threadList(input: {
  /** The recent projects, most recent first. Empty in a browser. */
  entries: readonly ProjectEntry[];
  /** The live queue of the project on screen. */
  live: readonly ThreadSummary[];
  folder: { path: string; name: string };
  seen: Readonly<Record<string, string>>;
  /** Matches a thread's title or its project's name. */
  query: string;
}): ThreadList {
  const query = input.query.trim().toLowerCase();
  const onScreen = input.entries.find((e) => e.current) ?? input.entries.find((e) => e.path === input.folder.path);
  const projects = [
    { path: onScreen?.path ?? input.folder.path, name: onScreen?.name ?? input.folder.name, current: true, threads: input.live },
    ...input.entries.filter((e) => e !== onScreen && e.missing !== true).map((e) => ({ path: e.path, name: e.name, current: false, threads: e.threads })),
  ];
  const all = projects.flatMap((p) => p.threads.map((thread): ThreadEntry => ({ thread, path: p.path, name: p.name, current: p.current })));
  const shown = all.filter((e) => query === '' || e.thread.title.toLowerCase().includes(query) || e.name.toLowerCase().includes(query)).sort(newestFirst);
  return {
    threads: shown.filter((e) => !finished(e.thread)),
    done: shown.filter((e) => finished(e.thread)),
    waiting: all.filter((e) => needsYou(e.thread, isSeen(input.seen, e.path, e.thread))).length,
  };
}
