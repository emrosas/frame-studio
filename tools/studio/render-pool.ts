// The render worker's server side (ADR 0008). Agents' renders, contact
// sheets, hit tests and exports run in render.html opened as a render worker:
// a page that connects here, takes one job at a time over its event stream,
// and posts the result back. A parallel export leases helper workers on more
// slots (ADR 0019); every job goes to whichever worker is free. Bytes it produces (PNGs, videos) come back in
// chunks to sinks, which write files. The app opens the worker in a hidden
// window; a server without the app launches Electron in worker-only mode.
// Node only.

import { randomBytes } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';

export interface RenderProgress {
  stage: string;
  done: number;
  total: number;
}

export interface RenderCallOptions {
  onProgress?(progress: RenderProgress): void;
  signal?: AbortSignal;
  /** Runs only when nothing else waits, so background work such as a poster never holds up an export or an agent's render. */
  low?: boolean;
  /** The worker drops the scene's canvas after this job, for one-off work across many scenes. */
  release?: boolean;
}

interface Job {
  id: string;
  scene: string;
  method: string;
  args: unknown[];
  options: RenderCallOptions;
  resolve(value: unknown): void;
  reject(err: Error): void;
  /** How many workers it was sent to. A job that keeps taking its worker down gives up. */
  attempts: number;
}

/** A render worker this server started: it can be closed, and says when it has gone. */
export interface LaunchedWorker {
  close(): Promise<void>;
  exited: Promise<void>;
  /** Opens helper workers on slots 1 to `count`, and closes any above (ADR 0019). */
  helpers?(count: number): void;
}

/** Starts a render worker for this server. */
export type WorkerLauncher = () => Promise<LaunchedWorker>;

/** One connected worker page, by slot: 0 is the worker every server has, 1 and up are helpers for parallel exports. */
interface Connection {
  slot: number;
  res: ServerResponse;
  current: Job | null;
}

const WORKER_WAIT_MS = 60_000;
/** A job that was running on this many workers that went away is given up on. */
const MAX_ATTEMPTS = 3;
/** Helpers stay open this long after the last export that wanted them, so the next one finds them ready. */
const HELPER_IDLE_MS = 30_000;

export class RenderPool {
  private readonly connections = new Map<number, Connection>();
  private readonly jobs: Job[] = [];
  /** Background jobs: they run when `jobs` is empty, in order. */
  private readonly low: Job[] = [];
  private readonly sinks = new Map<string, FileHandle>();
  private launch: WorkerLauncher | null;
  private launched: Promise<LaunchedWorker | null> | null = null;
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** The server's file generation: a worker with an older library loads it again before the job. */
  private readonly generation: () => number;
  /** Opens and closes helpers when no launched worker does it: the app's main process (ADR 0019). */
  private helperControl: ((count: number) => void) | null = null;
  /** Helpers each live lease wants. */
  private readonly leases = new Map<symbol, number>();
  /** Helpers asked for last. */
  private helperCount = 0;
  private shrinking: ReturnType<typeof setTimeout> | null = null;

  constructor(launch: WorkerLauncher | null, generation: () => number = () => 0) {
    this.launch = launch;
    this.generation = generation;
  }

  /** How to start a worker when a job arrives and none is connected; the server sets it once it knows its address. */
  setLauncher(launch: WorkerLauncher | null): void {
    this.launch = launch;
  }

  /** How to open helper workers where this pool doesn't launch them itself: the app's windows. */
  setHelperControl(control: ((count: number) => void) | null): void {
    this.helperControl = control;
  }

  /** True while a worker is connected. */
  get connected(): boolean {
    return this.connections.size > 0;
  }

  /** Workers connected now, helpers included. */
  get workerCount(): number {
    return this.connections.size;
  }

  /**
   * A worker page's event stream: jobs go down it. A page on a slot that is
   * already taken replaces the one there, and takes over its job.
   */
  attach(req: IncomingMessage, res: ServerResponse, slot = 0): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    const replaced = this.connections.get(slot);
    const connection: Connection = { slot, res, current: replaced?.current ?? null };
    replaced?.res.end();
    this.connections.set(slot, connection);
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = null;
    req.on('close', () => {
      if (this.connections.get(slot) !== connection) return;
      this.connections.delete(slot);
      // The job it had goes back to the front, for the next worker.
      if (connection.current) this.jobs.unshift(connection.current);
      connection.current = null;
      if (this.connections.size === 0 && this.waitingJobs > 0) this.ensureWorker();
      else this.pump();
    });
    // A job whose worker went away mid-way (a crash, a reload) goes to this one, unless it keeps doing that.
    if (connection.current) this.send(connection, connection.current);
    else this.pump();
  }

  /** Runs `method` on the worker's window.studio for `scene`, and resolves with what it returns. */
  call(scene: string, method: string, args: unknown[] = [], options: RenderCallOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The studio server is closing.'));
    if (options.signal?.aborted) return Promise.reject(new Error('Cancelled.'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: randomBytes(8).toString('hex'), scene, method, args, options, resolve, reject, attempts: 0 };
      options.signal?.addEventListener('abort', () => this.cancel(job.id), { once: true });
      (options.low ? this.low : this.jobs).push(job);
      this.pump();
    });
  }

  /**
   * Asks for `count` helper workers beside the main one, for as long as the
   * returned release isn't called. Jobs go to whichever worker is free, so
   * work queued now starts on the main worker and spreads as helpers connect.
   * Helpers close a while after the last lease is released.
   */
  lease(count: number): () => void {
    const key = Symbol('lease');
    this.leases.set(key, Math.max(0, Math.floor(count)));
    if (this.shrinking) clearTimeout(this.shrinking);
    this.shrinking = null;
    this.applyHelpers(Math.max(this.helperCount, ...this.leases.values()));
    if (this.connections.size === 0) this.ensureWorker();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.delete(key);
      const wanted = Math.max(0, ...this.leases.values());
      if (wanted >= this.helperCount) return;
      if (this.shrinking) clearTimeout(this.shrinking);
      this.shrinking = setTimeout(() => {
        this.shrinking = null;
        this.applyHelpers(Math.max(0, ...this.leases.values()));
      }, HELPER_IDLE_MS);
      this.shrinking.unref?.();
    };
  }

  private applyHelpers(count: number): void {
    if (count === this.helperCount) return;
    this.helperCount = count;
    if (this.helperControl) {
      this.helperControl(count);
      return;
    }
    void this.launched?.then((worker) => worker?.helpers?.(this.helperCount));
  }

  private get waitingJobs(): number {
    return this.jobs.length + this.low.length;
  }

  private get busy(): boolean {
    for (const c of this.connections.values()) if (c.current) return true;
    return false;
  }

  private pump(): void {
    if (this.waitingJobs === 0) return;
    if (this.connections.size === 0) {
      this.ensureWorker();
      return;
    }
    // The main worker first, then helpers by slot.
    const idle = [...this.connections.values()].filter((c) => !c.current).sort((a, b) => a.slot - b.slot);
    for (const connection of idle) {
      const job = this.jobs.shift() ?? this.low.shift();
      if (!job) return;
      connection.current = job;
      this.send(connection, job);
    }
  }

  private send(connection: Connection, job: Job): void {
    if (++job.attempts > MAX_ATTEMPTS) {
      connection.current = null;
      job.reject(new Error(`The render worker stopped while working on this ${MAX_ATTEMPTS} times, so it was given up. A rig that loops forever or runs out of memory can do that.`));
      this.pump();
      return;
    }
    const payload = { id: job.id, scene: job.scene, method: job.method, args: job.args, generation: this.generation(), ...(job.options.release ? { release: true } : {}) };
    connection.res.write(`event: job\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** Starts a worker if none is connected, and fails the waiting jobs if none arrives in time. */
  private ensureWorker(): void {
    if (this.launch && !this.launched) {
      const launched: Promise<LaunchedWorker | null> = this.launch().then(
        (worker) => {
          if (this.helperCount > 0) worker.helpers?.(this.helperCount);
          // Gone: the next job starts another.
          void worker.exited.then(() => {
            if (this.launched !== launched) return;
            this.launched = null;
            if (this.connections.size === 0 && !this.closed && this.waitingJobs > 0) this.ensureWorker();
          });
          return worker;
        },
        (err: unknown) => {
          this.failAll(new Error(`The render worker could not start: ${err instanceof Error ? err.message : String(err)}`));
          if (this.launched === launched) this.launched = null;
          return null;
        },
      );
      this.launched = launched;
    }
    if (this.waiting) return;
    this.waiting = setTimeout(() => {
      this.waiting = null;
      if (this.connections.size === 0) this.failAll(new Error('No render worker connected. In the app, reopen the window; elsewhere, check that Electron is installed (npm install).'));
    }, WORKER_WAIT_MS);
    this.waiting.unref?.();
  }

  private failAll(err: Error): void {
    const all: Job[] = [];
    for (const c of this.connections.values()) {
      if (c.current) all.push(c.current);
      c.current = null;
    }
    all.push(...this.jobs.splice(0), ...this.low.splice(0));
    for (const job of all) job.reject(err);
  }

  private running(id: string): Connection | null {
    for (const c of this.connections.values()) if (c.current?.id === id) return c;
    return null;
  }

  private finish(id: string): Job | null {
    const connection = this.running(id);
    if (!connection) return null;
    const job = connection.current!;
    connection.current = null;
    queueMicrotask(() => this.pump());
    return job;
  }

  /** The worker's answer to a job. */
  result(id: string, answer: { ok: true; value: unknown } | { ok: false; error: string }): boolean {
    const job = this.finish(id);
    if (!job) return false;
    if (answer.ok) job.resolve(answer.value);
    else job.reject(new Error(answer.error));
    return true;
  }

  /** Export progress from the worker. Returns whether the job should go on. */
  progress(id: string, progress: RenderProgress): boolean {
    const job = this.running(id)?.current;
    if (!job) return false;
    job.options.onProgress?.(progress);
    return !job.options.signal?.aborted;
  }

  /** Withdraws a job: a waiting one at once, a running one at its next progress report. */
  cancel(id: string): void {
    for (const queue of [this.jobs, this.low]) {
      const at = queue.findIndex((j) => j.id === id);
      if (at >= 0) {
        queue.splice(at, 1)[0].reject(new Error('Cancelled.'));
        return;
      }
    }
    const connection = this.running(id);
    if (connection) connection.res.write(`event: cancel\ndata: ${JSON.stringify({ id })}\n\n`);
  }

  /** A sink whose bytes land in `path`. Parent folders are created. */
  async openSink(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    const id = `sink-${randomBytes(8).toString('hex')}`;
    this.sinks.set(id, await open(path, 'w'));
    return id;
  }

  async write(sinkId: string, position: number, data: Buffer): Promise<void> {
    const handle = this.sinks.get(sinkId);
    if (!handle) throw new Error(`unknown sink ${sinkId}`);
    await handle.write(data, 0, data.length, position);
  }

  /** Closes a sink's file. Safe to call twice. */
  async closeSink(sinkId: string): Promise<void> {
    const handle = this.sinks.get(sinkId);
    this.sinks.delete(sinkId);
    await handle?.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error('The studio server closed.'));
    if (this.waiting) clearTimeout(this.waiting);
    if (this.shrinking) clearTimeout(this.shrinking);
    for (const c of this.connections.values()) c.res.end();
    this.connections.clear();
    if (this.helperCount > 0) this.helperControl?.(0);
    for (const id of [...this.sinks.keys()]) await this.closeSink(id);
    const launched = await this.launched?.catch(() => null);
    await launched?.close();
  }
}
