// The render worker's server side (ADR 0008). Agents' renders, contact
// sheets, hit tests and exports run in render.html opened as a render worker:
// a page that connects here, takes one job at a time over its event stream,
// and posts the result back. Bytes it produces (PNGs, videos) come back in
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
}

/** Starts a render worker for this server. */
export type WorkerLauncher = () => Promise<LaunchedWorker>;

const WORKER_WAIT_MS = 60_000;
/** A job that was running on this many workers that went away is given up on. */
const MAX_ATTEMPTS = 3;

export class RenderPool {
  private worker: ServerResponse | null = null;
  private readonly jobs: Job[] = [];
  private current: Job | null = null;
  private readonly sinks = new Map<string, FileHandle>();
  private launch: WorkerLauncher | null;
  private launched: Promise<LaunchedWorker | null> | null = null;
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** The server's file generation: a worker with an older library loads it again before the job. */
  private readonly generation: () => number;

  constructor(launch: WorkerLauncher | null, generation: () => number = () => 0) {
    this.launch = launch;
    this.generation = generation;
  }

  /** How to start a worker when a job arrives and none is connected; the server sets it once it knows its address. */
  setLauncher(launch: WorkerLauncher | null): void {
    this.launch = launch;
  }

  /** True while a worker is connected. */
  get connected(): boolean {
    return this.worker !== null;
  }

  /** A worker page's event stream: jobs go down it. The newest worker replaces any earlier one. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    this.worker?.end();
    this.worker = res;
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = null;
    req.on('close', () => {
      if (this.worker !== res) return;
      this.worker = null;
      // The job it had goes to the next worker, which has to come first.
      if (this.current || this.jobs.length > 0) this.ensureWorker();
    });
    // A job whose worker went away mid-way (a crash, a reload) goes to this one, unless it keeps doing that.
    if (this.current) this.send(this.current);
    else this.pump();
  }

  /** Runs `method` on the worker's window.studio for `scene`, and resolves with what it returns. */
  call(scene: string, method: string, args: unknown[] = [], options: RenderCallOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The studio server is closing.'));
    if (options.signal?.aborted) return Promise.reject(new Error('Cancelled.'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: randomBytes(8).toString('hex'), scene, method, args, options, resolve, reject, attempts: 0 };
      options.signal?.addEventListener('abort', () => this.cancel(job.id), { once: true });
      this.jobs.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.jobs.length === 0) return;
    if (!this.worker) {
      this.ensureWorker();
      return;
    }
    this.current = this.jobs.shift()!;
    this.send(this.current);
  }

  private send(job: Job): void {
    if (!this.worker) return;
    if (++job.attempts > MAX_ATTEMPTS) {
      this.current = null;
      job.reject(new Error(`The render worker stopped while working on this ${MAX_ATTEMPTS} times, so it was given up. A rig that loops forever or runs out of memory can do that.`));
      this.pump();
      return;
    }
    const payload = { id: job.id, scene: job.scene, method: job.method, args: job.args, generation: this.generation() };
    this.worker.write(`event: job\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** Starts a worker if none is connected, and fails the waiting jobs if none arrives in time. */
  private ensureWorker(): void {
    if (this.launch && !this.launched) {
      const launched: Promise<LaunchedWorker | null> = this.launch().then(
        (worker) => {
          // Gone: the next job starts another.
          void worker.exited.then(() => {
            if (this.launched !== launched) return;
            this.launched = null;
            if (!this.worker && !this.closed && (this.current || this.jobs.length > 0)) this.ensureWorker();
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
      if (!this.worker) this.failAll(new Error('No render worker connected. In the app, reopen the window; elsewhere, check that Electron is installed (npm install).'));
    }, WORKER_WAIT_MS);
    this.waiting.unref?.();
  }

  private failAll(err: Error): void {
    const all = [...(this.current ? [this.current] : []), ...this.jobs.splice(0)];
    this.current = null;
    for (const job of all) job.reject(err);
  }

  private finish(id: string): Job | null {
    if (this.current?.id !== id) return null;
    const job = this.current;
    this.current = null;
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
    const job = this.current?.id === id ? this.current : null;
    if (!job) return false;
    job.options.onProgress?.(progress);
    return !job.options.signal?.aborted;
  }

  /** Withdraws a job: a waiting one at once, a running one at its next progress report, or at once with no worker. */
  cancel(id: string): void {
    const at = this.jobs.findIndex((j) => j.id === id);
    if (at >= 0) {
      this.jobs.splice(at, 1)[0].reject(new Error('Cancelled.'));
      return;
    }
    if (this.current?.id !== id) return;
    if (this.worker) {
      this.worker.write(`event: cancel\ndata: ${JSON.stringify({ id })}\n\n`);
      return;
    }
    const job = this.current;
    this.current = null;
    job.reject(new Error('Cancelled.'));
    this.pump();
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
    this.worker?.end();
    this.worker = null;
    for (const id of [...this.sinks.keys()]) await this.closeSink(id);
    const launched = await this.launched?.catch(() => null);
    await launched?.close();
  }
}
