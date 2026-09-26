// The request queue and current selection on disk (ADR 0003, ADR 0006). The
// viewer's studio server, the agents inside it and the MCP server all work
// through this, and none keeps state another needs: the files are the truth.
// A request is a thread of turns; see src/studio/protocol.ts.
//
// Atomicity, since two agent sessions (two MCP servers, or one and the studio
// server) and the viewer can act at once:
// - create: the thread is written to a temp file, then hard-linked to
//   NNNN.json. A link fails if the name exists, so ids never collide and
//   readers never see a half-written thread.
// - claim: an exclusive create of NNNN.claim, which only one process wins.
//   The claim is held from the start of a claim until the turn ends.
// - one working thread per scene: an exclusive create of scene-<id>.lock,
//   naming the thread, held while its turn works. A lock is live while its
//   thread's claim file exists; one without is left over from a crash, and is
//   broken by renaming it aside and checking it was the one read.
// - both are written whole and then hard-linked into place, so no reader
//   ever sees an empty claim or lock.
// - updates: written whole to a temp file and renamed over the thread. Within
//   this process, changes to one thread take turns, so a read-modify-write
//   (a session id, say) can't undo a cancel that landed in between.
// Node only; runs as TypeScript through type stripping.

import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  canRevert,
  checkpointFileName,
  currentTurn,
  firstRevertableTurn,
  isFinished,
  normalizeRequest,
  projectCheckpointFileName,
  projectOf,
  requestFileName,
  threadDirName,
  type AgentId,
  type CurrentSelection,
  type NewRequest,
  type Reply,
  type StudioRequest,
  type Turn,
  type TurnSettings,
  type TurnStatus,
  type TurnUsage,
} from '../../src/studio/protocol.ts';
import { writeFileAtomic } from '../scene-files.ts';

/** Finds the scene file for a scene id. */
export type SceneFileResolver = (sceneId: string) => Promise<string>;

const REQUEST_FILE = /^(\d+)\.json$/;
/** Makes temp names unique within this process; the pid covers other processes. */
let tempCounter = 0;
const isCode = (err: unknown, code: string) => (err as { code?: string } | null)?.code === code;
const now = () => new Date().toISOString();
const exists = (path: string) => stat(path).then(() => true, () => false);

/** Who may end a working turn: the session that claimed it, that turn, and threads for these agents. */
export interface TurnOwner {
  session?: string;
  turn?: number;
  agents?: readonly AgentId[];
}

export class StudioQueue {
  readonly dir: string;
  readonly requestsDir: string;
  /** Where Clear finished moves threads, so their ids are never handed out again. */
  readonly archiveDir: string;
  readonly selectionFile: string;
  private readonly sceneFile: SceneFileResolver;
  /** Changes to a thread in flight in this process, so they run one at a time. */
  private readonly busy = new Map<number, Promise<unknown>>();

  /** `dir` is the .frame-studio folder; `sceneFile` finds a scene's file for checkpoints and reverts. */
  constructor(dir: string, sceneFile: SceneFileResolver) {
    this.dir = dir;
    this.requestsDir = join(dir, 'requests');
    this.archiveDir = join(this.requestsDir, 'archive');
    this.selectionFile = join(dir, 'selection.json');
    this.sceneFile = sceneFile;
  }

  private path(id: number, kind: 'request' | 'claim' = 'request'): string {
    return join(this.requestsDir, requestFileName(id, kind));
  }

  checkpointPath(id: number, turn: number): string {
    return join(this.requestsDir, checkpointFileName(id, turn));
  }

  /** A project scene's turn keeps project.json here too (ADR 0007). */
  projectCheckpointPath(id: number, turn: number): string {
    return join(this.requestsDir, projectCheckpointFileName(id, turn));
  }

  /** The project.json beside a project scene's file, or null for a loose scene. */
  private async projectFile(sceneId: string): Promise<string | null> {
    return projectOf(sceneId) === null ? null : join(dirname(await this.sceneFile(sceneId)), 'project.json');
  }

  /** Whether the project's project.json differs from turn `turn`'s copy of it, made at claim time. */
  private async projectChanged(thread: StudioRequest, turn: number): Promise<boolean> {
    const file = await this.projectFile(thread.sceneId).catch(() => null);
    if (!file) return false;
    const read = (path: string) => readFile(path, 'utf8').catch(() => null);
    const before = await read(this.projectCheckpointPath(thread.id, turn));
    return before !== null && before !== (await read(file));
  }

  /** The folder with a thread's turn logs and frame thumbnails. */
  threadDir(id: number): string {
    return join(this.requestsDir, threadDirName(id));
  }

  private lockPath(sceneId: string): string {
    return join(this.requestsDir, `scene-${encodeURIComponent(sceneId)}.lock`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.requestsDir, { recursive: true });
  }

  /** Runs `fn` after any other change to thread `id` in this process has finished. */
  private exclusive<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const run = (this.busy.get(id) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    this.busy.set(id, settled);
    void settled.then(() => {
      if (this.busy.get(id) === settled) this.busy.delete(id);
    });
    return run;
  }

  /** Creates `path` holding `content`, whole, only if it doesn't exist. False when it does. */
  private async createExclusive(path: string, content: string): Promise<boolean> {
    const temp = join(this.requestsDir, `.new-${process.pid}-${tempCounter++}.tmp`);
    try {
      await writeFileAtomic(temp, content);
      await link(temp, path);
      return true;
    } catch (err) {
      if (isCode(err, 'EEXIST')) return false;
      throw err;
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Every thread, oldest first. Files that don't parse (mid-write by another tool) are skipped. */
  async list(): Promise<StudioRequest[]> {
    let names: string[];
    try {
      names = await readdir(this.requestsDir);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return [];
      throw err;
    }
    const out: StudioRequest[] = [];
    for (const name of names) {
      if (!REQUEST_FILE.test(name)) continue;
      try {
        out.push(normalizeRequest(JSON.parse(await readFile(join(this.requestsDir, name), 'utf8'))));
      } catch {
        // Skip it; the next read will see the finished file.
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  async get(id: number): Promise<StudioRequest> {
    try {
      return normalizeRequest(JSON.parse(await readFile(this.path(id), 'utf8')));
    } catch (err) {
      if (isCode(err, 'ENOENT')) throw new Error(`There is no request #${id}.`);
      throw err;
    }
  }

  private async write(request: StudioRequest): Promise<void> {
    await writeFileAtomic(this.path(request.id), `${JSON.stringify(request, null, 2)}\n`);
  }

  private static turnFrom(input: Reply, attempt?: number): Turn {
    return {
      ask: {
        prompt: input.prompt.trim(),
        references: input.references,
        selection: input.selection,
        frame: input.frame,
        ...(input.point ? { point: input.point } : {}),
        at: now(),
      },
      status: 'pending',
      ...(input.settings ? { settings: input.settings } : {}),
      ...(attempt ? { attempt } : {}),
    };
  }

  /** Starts a thread with its first ask. */
  async create(input: NewRequest): Promise<StudioRequest> {
    if (!input.prompt.trim()) throw new Error('A request needs a prompt.');
    await this.ensureDir();
    // Archived threads count too, so an id pasted into an agent never comes back as a different thread.
    const names = [...(await readdir(this.requestsDir)), ...(await readdir(this.archiveDir).catch(() => [] as string[]))];
    const taken = names.map((n) => /^(\d+)\./.exec(n)).filter((m) => m !== null).map((m) => Number(m![1]));
    let id = Math.max(0, ...taken) + 1;
    const temp = join(this.requestsDir, `.new-${process.pid}-${tempCounter++}.tmp`);
    try {
      for (;;) {
        const request: StudioRequest = {
          id,
          createdAt: now(),
          status: 'pending',
          agent: input.agent ?? 'external',
          sceneId: input.selection.sceneId,
          turns: [StudioQueue.turnFrom(input)],
        };
        await writeFileAtomic(temp, `${JSON.stringify(request, null, 2)}\n`);
        try {
          await link(temp, this.path(id));
          return request;
        } catch (err) {
          if (!isCode(err, 'EEXIST')) throw err;
          id++;
        }
      }
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Adds your reply as a new pending turn. Replying to a settled thread reopens it. */
  reply(id: number, input: Reply): Promise<StudioRequest> {
    return this.exclusive(id, () => this.replyNow(id, input));
  }

  private async replyNow(id: number, input: Reply): Promise<StudioRequest> {
    if (!input.prompt.trim()) throw new Error('A reply needs a prompt.');
    const thread = await this.get(id);
    if (thread.status === 'pending' || thread.status === 'working') {
      throw new Error(`Request #${id} is ${thread.status}; wait for the agent's turn to end, or stop it, before replying.`);
    }
    if (input.selection.sceneId !== thread.sceneId) {
      throw new Error(`Request #${id} is about scene "${thread.sceneId}"; start a new request for "${input.selection.sceneId}".`);
    }
    const next: StudioRequest = { ...thread, status: 'pending', turns: [...thread.turns, StudioQueue.turnFrom(input)] };
    delete next.settledAt;
    await this.write(next);
    return next;
  }

  /** Takes the scene's working lock for thread `id`. False when another thread holds it. */
  private async lockScene(sceneId: string, id: number): Promise<boolean> {
    const path = this.lockPath(sceneId);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.createExclusive(path, String(id))) return true;
      const owner = Number(await readFile(path, 'utf8').catch(() => 'NaN'));
      if (owner === id) return true;
      // The holder keeps its claim file from the start of its claim until its turn ends.
      if (Number.isInteger(owner) && (await exists(this.path(owner, 'claim')))) return false;
      if (!(await this.breakStaleLock(path, owner))) return false;
    }
    return false;
  }

  /**
   * Removes a lock left by a thread that no longer holds its claim. It is renamed aside first and
   * checked, so a lock another process took in the meantime is put back rather than deleted.
   */
  private async breakStaleLock(path: string, owner: number): Promise<boolean> {
    const aside = `${path}.stale-${process.pid}-${tempCounter++}`;
    try {
      await rename(path, aside);
    } catch {
      return true; // gone already: try to take it
    }
    const moved = Number(await readFile(aside, 'utf8').catch(() => 'NaN'));
    if (moved === owner || !Number.isInteger(moved)) {
      await rm(aside, { force: true });
      return true;
    }
    await link(aside, path).catch(() => {});
    await rm(aside, { force: true });
    return false;
  }

  private async unlockScene(sceneId: string, id: number): Promise<void> {
    const path = this.lockPath(sceneId);
    const owner = Number(await readFile(path, 'utf8').catch(() => 'NaN'));
    if (owner === id) await rm(path, { force: true });
  }

  private async release(thread: StudioRequest): Promise<void> {
    await rm(this.path(thread.id, 'claim'), { force: true });
    await this.unlockScene(thread.sceneId, thread.id);
  }

  /** Removes claim files older than `maxAgeMs` on threads that aren't working: left by a process that crashed mid-claim. */
  async clearOrphanClaims(maxAgeMs = 60_000): Promise<void> {
    const names = await readdir(this.requestsDir).catch(() => [] as string[]);
    for (const name of names) {
      const m = /^(\d+)\.claim$/.exec(name);
      if (!m) continue;
      const thread = await this.get(Number(m[1])).catch(() => null);
      const info = await stat(join(this.requestsDir, name)).catch(() => null);
      if (!info || (maxAgeMs > 0 && Date.now() - info.mtimeMs < maxAgeMs)) continue;
      if (!thread || thread.status !== 'working') await rm(join(this.requestsDir, name), { force: true });
    }
  }

  /**
   * Takes a pending turn for this session: wins the thread's claim file and its
   * scene's lock, checkpoints the scene for the turn, and marks it working.
   * Null if another session won, or another thread is working on the scene.
   */
  private take(request: StudioRequest, session: string): Promise<StudioRequest | null> {
    return this.exclusive(request.id, () => this.takeNow(request, session));
  }

  private async takeNow(request: StudioRequest, session: string): Promise<StudioRequest | null> {
    if (!(await this.createExclusive(this.path(request.id, 'claim'), session))) return null;
    let locked = false;
    try {
      const current = await this.get(request.id);
      if (current.status !== 'pending' || currentTurn(current).status !== 'pending') {
        await rm(this.path(request.id, 'claim'), { force: true });
        return null;
      }
      locked = await this.lockScene(current.sceneId, current.id);
      if (!locked) {
        await rm(this.path(request.id, 'claim'), { force: true });
        return null;
      }
      const k = current.turns.length - 1;
      const turn = current.turns[k];
      const at = now();
      // Keep the first checkpoint: after a requeue, the scene may already hold half a turn.
      let checkpointAt = turn.checkpointAt;
      if (!checkpointAt) {
        await copyFile(await this.sceneFile(current.sceneId), this.checkpointPath(current.id, k), constants.COPYFILE_EXCL).catch((err) => {
          if (!isCode(err, 'EEXIST')) throw err;
        });
        const project = await this.projectFile(current.sceneId);
        if (project) {
          await copyFile(project, this.projectCheckpointPath(current.id, k), constants.COPYFILE_EXCL).catch((err) => {
            if (!isCode(err, 'EEXIST') && !isCode(err, 'ENOENT')) throw err;
          });
        }
        checkpointAt = at;
      }
      const turns = [...current.turns];
      turns[k] = { ...turn, status: 'working', claimedAt: at, claimedBy: session, checkpointAt };
      const claimed: StudioRequest = { ...current, status: 'working', turns };
      await this.write(claimed);
      return claimed;
    } catch (err) {
      // Let the turn be claimed again once whatever failed (a missing scene, say) is fixed.
      await rm(this.path(request.id, 'claim'), { force: true });
      if (locked) await this.unlockScene(request.sceneId, request.id);
      throw err;
    }
  }

  /**
   * Claims the oldest pending thread for one of `agents`, or returns null when none can go. A turn that
   * can't start (its scene is gone, say) fails with the reason, rather than holding up the threads after it.
   */
  async claimNext(session: string, agents: readonly AgentId[] = ['external']): Promise<StudioRequest | null> {
    const all = await this.list();
    for (const request of all) {
      if (request.status !== 'pending' || !agents.includes(request.agent)) continue;
      if (all.some((r) => r.id !== request.id && r.sceneId === request.sceneId && r.status === 'working')) continue;
      try {
        const claimed = await this.take(request, session);
        if (claimed) return claimed;
      } catch (err) {
        await this.failPending(request.id, `Could not start: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
    }
    return null;
  }

  /** Fails a pending turn that couldn't start, and hands the thread back to you with the reason. */
  private failPending(id: number, reason: string): Promise<StudioRequest> {
    return this.exclusive(id, async () => {
      const thread = await this.get(id);
      const k = thread.turns.length - 1;
      if (thread.status !== 'pending' || thread.turns[k].status !== 'pending') return thread;
      const turns = [...thread.turns];
      turns[k] = { ...turns[k], status: 'failed', summary: reason, completedAt: now() };
      const next: StudioRequest = { ...thread, turns, status: 'your_turn' };
      await this.write(next);
      return next;
    });
  }

  /**
   * A thread by id, its pending turn claimed for this session first when the
   * thread belongs to one of `agents`. Otherwise it is just read.
   */
  async claim(id: number, session: string, agents: readonly AgentId[] = ['external']): Promise<StudioRequest> {
    const request = await this.get(id);
    if (request.status !== 'pending' || !agents.includes(request.agent)) return request;
    return (await this.take(request, session)) ?? this.get(id);
  }

  /** Changes the working turn and the thread through `change`, then writes it. With `owner`, only that turn's owner may. */
  private updateWorking(
    id: number,
    verb: string,
    owner: TurnOwner,
    change: (turn: Turn, thread: StudioRequest) => { turn: Turn; thread?: Partial<StudioRequest> },
  ): Promise<StudioRequest> {
    return this.exclusive(id, () => this.updateWorkingNow(id, verb, owner, change));
  }

  private async updateWorkingNow(
    id: number,
    verb: string,
    owner: TurnOwner,
    change: (turn: Turn, thread: StudioRequest) => { turn: Turn; thread?: Partial<StudioRequest> },
  ): Promise<StudioRequest> {
    const thread = await this.get(id);
    const k = thread.turns.length - 1;
    if (thread.status !== 'working' || thread.turns[k].status !== 'working') {
      throw new Error(`Request #${id} has no turn working, so it cannot be ${verb}.`);
    }
    if (owner.agents && !owner.agents.includes(thread.agent)) {
      throw new Error(`Request #${id} is being worked by ${thread.agent === 'external' ? 'an external agent' : `the studio's ${thread.agent} agent`}, not by you.`);
    }
    if ((owner.turn !== undefined && owner.turn !== k) || (owner.session !== undefined && thread.turns[k].claimedBy !== owner.session)) {
      throw new Error(`Request #${id} has moved on to another turn, so this one cannot be ${verb}.`);
    }
    const { turn, thread: patch } = change(thread.turns[k], thread);
    const turns = [...thread.turns];
    // A turn that ends having changed project.json says so, so its revert restores that too.
    turns[k] = turn.status !== 'working' && (await this.projectChanged(thread, k)) ? { ...turn, projectChanged: true } : turn;
    const next: StudioRequest = { ...thread, ...patch, turns };
    await this.write(next);
    if (next.status !== 'working') await this.release(next);
    return next;
  }

  /** Ends the working turn as done or failed, with the agent's summary, and hands the thread back to you. */
  complete(id: number, status: 'done' | 'failed', summary: string, extra: { usage?: TurnUsage } = {}, owner: TurnOwner = {}): Promise<StudioRequest> {
    return this.updateWorking(id, 'completed', owner, (turn) => ({
      turn: { ...turn, status, summary: summary.trim(), completedAt: now(), ...(extra.usage ? { usage: extra.usage } : {}) },
      thread: { status: 'your_turn' },
    }));
  }

  /** Ends the working turn early: stopped by you, or interrupted when the studio server went away. Edits so far stay. */
  endTurn(
    id: number,
    status: 'stopped' | 'interrupted',
    summary?: string,
    extra: { usage?: TurnUsage } = {},
    owner: TurnOwner = {},
  ): Promise<StudioRequest> {
    return this.updateWorking(id, status === 'stopped' ? 'stopped' : 'interrupted', owner, (turn) => ({
      turn: { ...turn, status, completedAt: now(), ...(summary ? { summary: summary.trim() } : {}), ...(extra.usage ? { usage: extra.usage } : {}) },
      thread: { status: 'your_turn' },
    }));
  }

  /** Remembers the provider's session id, so the next turn resumes the same conversation. */
  setSession(id: number, session: string): Promise<StudioRequest> {
    return this.exclusive(id, async () => {
      const thread = await this.get(id);
      if (thread.session === session) return thread;
      const next = { ...thread, session };
      await this.write(next);
      return next;
    });
  }

  /** Withdraws the newest turn before or while an agent works on it. A thread with nothing else in it is cancelled. */
  cancel(id: number): Promise<StudioRequest> {
    return this.exclusive(id, () => this.cancelNow(id));
  }

  private async cancelNow(id: number): Promise<StudioRequest> {
    const thread = await this.get(id);
    const k = thread.turns.length - 1;
    const turn = thread.turns[k];
    if (turn.status !== 'pending' && turn.status !== 'working') {
      throw new Error(`Request #${id} has no waiting or working turn to cancel.`);
    }
    const turns = [...thread.turns];
    // A turn cancelled while it worked keeps its edits, so it says whether project.json was among them.
    const changed = turn.status === 'working' && (await this.projectChanged(thread, k));
    turns[k] = { ...turn, status: 'cancelled', completedAt: now(), ...(changed ? { projectChanged: true } : {}) };
    const next: StudioRequest = { ...thread, turns, status: turns.every((t) => t.status === 'cancelled') ? 'cancelled' : 'your_turn' };
    await this.write(next);
    await this.release(next);
    return next;
  }

  /** Puts the newest turn back in the queue, e.g. one whose agent stalled, failed or was interrupted. Its checkpoint stays. */
  requeue(id: number): Promise<StudioRequest> {
    return this.exclusive(id, () => this.requeueNow(id));
  }

  private async requeueNow(id: number): Promise<StudioRequest> {
    const thread = await this.get(id);
    const k = thread.turns.length - 1;
    const turn = thread.turns[k];
    const from: readonly TurnStatus[] = ['working', 'failed', 'interrupted', 'stopped'];
    if (!from.includes(turn.status)) throw new Error(`Request #${id}'s newest turn is ${turn.status}, so it cannot be requeued.`);
    const turns = [...thread.turns];
    const pending: Turn = { ...turn, status: 'pending' };
    delete pending.claimedAt;
    delete pending.claimedBy;
    delete pending.completedAt;
    delete pending.summary;
    turns[k] = pending;
    const next: StudioRequest = { ...thread, turns, status: 'pending' };
    delete next.settledAt;
    await this.write(next);
    await this.release(next);
    return next;
  }

  /**
   * "Revert to here": restores the scene as it was before turn `turn`'s agent
   * started, and marks that turn and every later one reverted. The thread
   * goes back to you. See canRevert for when it is allowed.
   */
  revertTo(id: number, turn: number): Promise<StudioRequest> {
    return this.exclusive(id, () => this.revertNow(id, turn));
  }

  private async revertNow(id: number, turn: number): Promise<StudioRequest> {
    const thread = await this.get(id);
    if (!canRevert(thread, turn, await this.list())) {
      throw new Error(
        `Request #${id} cannot be reverted to turn ${turn + 1}: that needs a finished turn with a checkpoint, and no later work on the scene from another request.`,
      );
    }
    const before = await readFile(this.checkpointPath(id, turn));
    await writeFileAtomic(await this.sceneFile(thread.sceneId), before);
    const project = await this.projectFile(thread.sceneId);
    if (project && thread.turns.slice(turn).some((t) => t.projectChanged && t.status !== 'reverted')) {
      const projectBefore = await readFile(this.projectCheckpointPath(id, turn)).catch(() => null);
      if (projectBefore) await writeFileAtomic(project, projectBefore);
    }
    const turns = thread.turns.map((t, k) => (k >= turn && t.status !== 'cancelled' ? { ...t, status: 'reverted' as const } : t));
    const next: StudioRequest = { ...thread, turns, status: 'your_turn' };
    delete next.settledAt;
    await this.write(next);
    return next;
  }

  /** Revert on a settled (or any) thread: back to before its first turn that still counts. */
  revertAll(id: number): Promise<StudioRequest> {
    return this.exclusive(id, async () => {
      const thread = await this.get(id);
      const k = firstRevertableTurn(thread, await this.list());
      if (k === null) throw new Error(`Request #${id} cannot be reverted: nothing to undo, or another request changed the scene since.`);
      return this.revertNow(id, k);
    });
  }

  /**
   * Try again: reverts the newest turn that counts and asks the same thing
   * again, with an optional new prompt, and new references and settings when given.
   */
  retry(id: number, prompt?: string, change: { references?: string[]; settings?: TurnSettings } = {}): Promise<StudioRequest> {
    return this.exclusive(id, () => this.retryNow(id, prompt, change));
  }

  private async retryNow(id: number, prompt?: string, change: { references?: string[]; settings?: TurnSettings } = {}): Promise<StudioRequest> {
    const thread = await this.get(id);
    let k = thread.turns.length - 1;
    while (k >= 0 && (thread.turns[k].status === 'reverted' || thread.turns[k].status === 'cancelled')) k--;
    if (k < 0) throw new Error(`Request #${id} has no turn to try again.`);
    const last = thread.turns[k];
    if (!isFinished(last)) throw new Error(`Request #${id}'s newest turn is still ${last.status}.`);
    // A turn with no checkpoint changed nothing to revert, e.g. one cancelled before any agent took it.
    const reverted = last.checkpointAt ? await this.revertNow(id, k) : thread;
    const settings = change.settings ?? last.settings;
    const turn = StudioQueue.turnFrom(
      { ...last.ask, prompt: prompt?.trim() ? prompt : last.ask.prompt, references: change.references ?? last.ask.references, ...(settings ? { settings } : {}) },
      (last.attempt ?? 1) + 1,
    );
    const next: StudioRequest = { ...reverted, status: 'pending', turns: [...reverted.turns, turn] };
    await this.write(next);
    return next;
  }

  /** You close the thread. Only a thread waiting for you can be settled. */
  settle(id: number): Promise<StudioRequest> {
    return this.exclusive(id, async () => {
      const thread = await this.get(id);
      if (thread.status !== 'your_turn') throw new Error(`Request #${id} is ${thread.status.replace('_', ' ')}, so it cannot be settled.`);
      const next: StudioRequest = { ...thread, status: 'settled', settledAt: now() };
      await this.write(next);
      return next;
    });
  }

  /** Moves settled and cancelled threads, their checkpoints and their turn logs into requests/archive/. */
  async clearFinished(): Promise<number> {
    let removed = 0;
    for (const r of await this.list()) {
      if (r.status !== 'settled' && r.status !== 'cancelled') continue;
      await mkdir(this.archiveDir, { recursive: true });
      const names = [
        requestFileName(r.id),
        threadDirName(r.id),
        ...r.turns.flatMap((_, k) => [checkpointFileName(r.id, k), projectCheckpointFileName(r.id, k)]),
      ];
      for (const name of names) {
        await rename(join(this.requestsDir, name), join(this.archiveDir, name)).catch((err) => {
          if (!isCode(err, 'ENOENT')) throw err;
        });
      }
      await rm(this.path(r.id, 'claim'), { force: true });
      removed++;
    }
    return removed;
  }

  async readSelection(): Promise<CurrentSelection | null> {
    try {
      return JSON.parse(await readFile(this.selectionFile, 'utf8')) as CurrentSelection;
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    }
  }

  async writeSelection(selection: Omit<CurrentSelection, 'updatedAt'> | null): Promise<void> {
    if (!selection) {
      await rm(this.selectionFile, { force: true });
      return;
    }
    await writeFileAtomic(this.selectionFile, `${JSON.stringify({ ...selection, updatedAt: now() }, null, 2)}\n`);
  }
}
