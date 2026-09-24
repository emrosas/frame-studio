// The request queue and current selection on disk (ADR 0003). The viewer's
// studio server and the MCP server both work through this, and neither keeps
// state the other needs: the files are the truth.
//
// Atomicity, since two agent sessions (two MCP servers) and the viewer can act
// at once:
// - create: the request is written to a temp file, then hard-linked to
//   NNNN.json. A link fails if the name exists, so ids never collide and
//   readers never see a half-written request.
// - claim: an exclusive create of NNNN.claim, which only one process wins.
// - updates: written whole to a temp file and renamed over the request.
// Node only; runs as TypeScript through type stripping.

import { copyFile, link, mkdir, open, readdir, readFile, rename, rm, unlink, constants } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canRevert,
  requestFileName,
  type CurrentSelection,
  type NewRequest,
  type RequestStatus,
  type StudioRequest,
} from '../../src/studio/protocol.ts';
import { writeFileAtomic } from '../scene-files.ts';

/** Finds the scene file for a scene id, and the formatter to write it with. */
export type SceneFileResolver = (sceneId: string) => Promise<string>;

const REQUEST_FILE = /^(\d+)\.json$/;
/** Makes temp names unique within this process; the pid covers other processes. */
let tempCounter = 0;
const isCode = (err: unknown, code: string) => (err as { code?: string } | null)?.code === code;

export class StudioQueue {
  readonly dir: string;
  readonly requestsDir: string;
  /** Where Clear finished moves requests, so their ids are never handed out again. */
  readonly archiveDir: string;
  readonly selectionFile: string;
  private readonly sceneFile: SceneFileResolver;

  /** `dir` is the .frame-studio folder; `sceneFile` finds a scene's file for checkpoints and reverts. */
  constructor(dir: string, sceneFile: SceneFileResolver) {
    this.dir = dir;
    this.requestsDir = join(dir, 'requests');
    this.archiveDir = join(this.requestsDir, 'archive');
    this.selectionFile = join(dir, 'selection.json');
    this.sceneFile = sceneFile;
  }

  private path(id: number, kind: 'request' | 'before' | 'claim' = 'request'): string {
    return join(this.requestsDir, requestFileName(id, kind));
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.requestsDir, { recursive: true });
  }

  /** Every request, oldest first. Files that don't parse (mid-write by another tool) are skipped. */
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
        out.push(JSON.parse(await readFile(join(this.requestsDir, name), 'utf8')) as StudioRequest);
      } catch {
        // Skip it; the next read will see the finished file.
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  async get(id: number): Promise<StudioRequest> {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as StudioRequest;
    } catch (err) {
      if (isCode(err, 'ENOENT')) throw new Error(`There is no request #${id}.`);
      throw err;
    }
  }

  private async write(request: StudioRequest): Promise<void> {
    await writeFileAtomic(this.path(request.id), `${JSON.stringify(request, null, 2)}\n`);
  }

  async create(input: NewRequest): Promise<StudioRequest> {
    if (!input.prompt.trim()) throw new Error('A request needs a prompt.');
    await this.ensureDir();
    // Archived requests count too, so an id pasted into an agent never comes back as a different request.
    const names = [...(await readdir(this.requestsDir)), ...(await readdir(this.archiveDir).catch(() => [] as string[]))];
    const taken = names.map((n) => /^(\d+)\./.exec(n)).filter((m) => m !== null).map((m) => Number(m![1]));
    let id = Math.max(0, ...taken) + 1;
    const temp = join(this.requestsDir, `.new-${process.pid}-${tempCounter++}.tmp`);
    try {
      for (;;) {
        const request: StudioRequest = {
          id,
          createdAt: new Date().toISOString(),
          status: 'pending',
          selection: input.selection,
          frame: input.frame,
          ...(input.point ? { point: input.point } : {}),
          prompt: input.prompt.trim(),
          references: input.references,
          ...(input.attempt ? { attempt: input.attempt } : {}),
          ...(input.retryOf ? { retryOf: input.retryOf } : {}),
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

  /** Takes a pending request for this session: wins its claim file, checkpoints its scene, marks it in progress. Null if another session won. */
  private async take(request: StudioRequest, session: string): Promise<StudioRequest | null> {
    try {
      const handle = await open(this.path(request.id, 'claim'), 'wx');
      await handle.writeFile(session);
      await handle.close();
    } catch (err) {
      if (isCode(err, 'EEXIST')) return null;
      throw err;
    }
    try {
      const current = await this.get(request.id);
      if (current.status !== 'pending') {
        await unlink(this.path(request.id, 'claim')).catch(() => {});
        return null;
      }
      const now = new Date().toISOString();
      // Keep the first checkpoint: after a requeue, the scene may already hold half an attempt.
      let checkpointAt = current.checkpoint ? current.checkpointAt : undefined;
      if (!current.checkpoint) {
        await copyFile(await this.sceneFile(current.selection.sceneId), this.path(current.id, 'before'), constants.COPYFILE_EXCL).catch((err) => {
          if (!isCode(err, 'EEXIST')) throw err;
        });
        checkpointAt = now;
      }
      const claimed: StudioRequest = { ...current, status: 'in_progress', claimedAt: now, claimedBy: session, checkpoint: true, ...(checkpointAt ? { checkpointAt } : {}) };
      await this.write(claimed);
      return claimed;
    } catch (err) {
      // Let the request be claimed again once whatever failed (a missing scene, say) is fixed.
      await unlink(this.path(request.id, 'claim')).catch(() => {});
      throw err;
    }
  }

  /** Claims the oldest pending request, or returns null when none is pending. */
  async claimNext(session: string): Promise<StudioRequest | null> {
    for (const request of await this.list()) {
      if (request.status !== 'pending') continue;
      const claimed = await this.take(request, session);
      if (claimed) return claimed;
    }
    return null;
  }

  /** A request by id, claimed for this session first if it is still pending. */
  async claim(id: number, session: string): Promise<StudioRequest> {
    const request = await this.get(id);
    if (request.status !== 'pending') return request;
    return (await this.take(request, session)) ?? this.get(id);
  }

  async complete(id: number, status: 'done' | 'failed', summary: string): Promise<StudioRequest> {
    const request = await this.get(id);
    if (request.status !== 'in_progress') {
      throw new Error(`Request #${id} is ${request.status.replace('_', ' ')}, not in progress, so it cannot be completed.`);
    }
    const done: StudioRequest = { ...request, status, summary: summary.trim(), completedAt: new Date().toISOString() };
    await this.write(done);
    await rm(this.path(id, 'claim'), { force: true });
    return done;
  }

  private async setStatus(id: number, from: readonly RequestStatus[], to: RequestStatus, verb: string): Promise<StudioRequest> {
    const request = await this.get(id);
    if (!from.includes(request.status)) throw new Error(`Request #${id} is ${request.status.replace('_', ' ')}, so it cannot be ${verb}.`);
    const next: StudioRequest = { ...request, status: to };
    if (to === 'pending') {
      delete next.claimedAt;
      delete next.claimedBy;
    }
    await this.write(next);
    await rm(this.path(id, 'claim'), { force: true });
    return next;
  }

  cancel(id: number): Promise<StudioRequest> {
    return this.setStatus(id, ['pending', 'in_progress'], 'cancelled', 'cancelled');
  }

  /** Puts a request back in the queue, e.g. one whose agent stalled. Its checkpoint stays. */
  requeue(id: number): Promise<StudioRequest> {
    return this.setStatus(id, ['in_progress', 'failed'], 'pending', 'requeued');
  }

  /** Restores the scene as it was when the request was claimed. Only the newest claimed request on a scene. */
  async revert(id: number): Promise<StudioRequest> {
    const request = await this.get(id);
    if (!canRevert(request, await this.list())) {
      throw new Error(`Request #${id} cannot be reverted: only the newest finished request on a scene, with a checkpoint, can.`);
    }
    const before = await readFile(this.path(id, 'before'));
    await writeFileAtomic(await this.sceneFile(request.selection.sceneId), before);
    const reverted: StudioRequest = { ...request, status: 'reverted' };
    await this.write(reverted);
    return reverted;
  }

  /** Reverts a request and queues the same ask again as the next attempt, with an optional new prompt. */
  async retry(id: number, prompt?: string): Promise<StudioRequest> {
    const reverted = await this.revert(id);
    return this.create({
      selection: reverted.selection,
      frame: reverted.frame,
      point: reverted.point,
      prompt: prompt?.trim() ? prompt : reverted.prompt,
      references: reverted.references,
      attempt: (reverted.attempt ?? 1) + 1,
      retryOf: reverted.retryOf ?? reverted.id,
    });
  }

  /** Moves finished requests (done, failed, cancelled, reverted) and their checkpoints into requests/archive/. */
  async clearFinished(): Promise<number> {
    let removed = 0;
    for (const r of await this.list()) {
      if (r.status === 'pending' || r.status === 'in_progress') continue;
      await mkdir(this.archiveDir, { recursive: true });
      for (const kind of ['request', 'before'] as const) {
        await rename(this.path(r.id, kind), join(this.archiveDir, requestFileName(r.id, kind))).catch((err) => {
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
    await writeFileAtomic(this.selectionFile, `${JSON.stringify({ ...selection, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }
}
