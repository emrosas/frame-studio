import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { RenderPool } from '../../tools/studio/render-pool';

/** A worker connection that records the jobs sent down it. */
function fakeWorker(pool: RenderPool, slot = 0): { sent: { id: string; method: string; release?: boolean }[]; req: EventEmitter } {
  const sent: { id: string; method: string; release?: boolean }[] = [];
  const req = new EventEmitter();
  const res = {
    statusCode: 0,
    setHeader() {},
    flushHeaders() {},
    end() {},
    write(text: string) {
      const data = /^event: job\ndata: (.*)\n/.exec(text);
      if (data) sent.push(JSON.parse(data[1]));
      return true;
    },
  };
  pool.attach(req as IncomingMessage, res as unknown as ServerResponse, slot);
  return { sent, req };
}

const next = () => new Promise((resolve) => setImmediate(resolve));

describe('the render pool', () => {
  it('runs background jobs only when nothing else waits', async () => {
    const pool = new RenderPool(null);
    const { sent } = fakeWorker(pool);
    const done: string[] = [];
    const call = (method: string, low = false) => void pool.call('s', method, [], { low }).then(() => done.push(method), () => {});

    call('export');
    call('poster-a', true);
    call('poster-b', true);
    call('frame');
    expect(sent.map((j) => j.method)).toEqual(['export']);

    pool.result(sent[0].id, { ok: true, value: null });
    await next();
    expect(sent.map((j) => j.method)).toEqual(['export', 'frame']);

    pool.result(sent[1].id, { ok: true, value: null });
    await next();
    expect(sent.map((j) => j.method)).toEqual(['export', 'frame', 'poster-a']);

    // An export that arrives during a poster waits for that one, and goes ahead of the next.
    call('export-2');
    pool.result(sent[2].id, { ok: true, value: null });
    await next();
    expect(sent.map((j) => j.method)).toEqual(['export', 'frame', 'poster-a', 'export-2']);
    await pool.close();
  });

  it('says when a job should release its scene, and withdraws a waiting background job', async () => {
    const pool = new RenderPool(null);
    const { sent } = fakeWorker(pool);
    const abort = new AbortController();
    void pool.call('s', 'first', [], { low: true, release: true }).catch(() => {});
    const waiting = pool.call('s', 'second', [], { low: true, signal: abort.signal });
    expect(sent[0].release).toBe(true);
    abort.abort();
    await expect(waiting).rejects.toThrow('Cancelled.');
    await pool.close();
  });

  it('spreads jobs over every connected worker, main worker first', async () => {
    const pool = new RenderPool(null);
    const main = fakeWorker(pool, 0);
    const done: string[] = [];
    for (const m of ['a', 'b', 'c', 'd']) void pool.call('s', m).then(() => done.push(m), () => {});
    expect(main.sent.map((j) => j.method)).toEqual(['a']);
    const helper = fakeWorker(pool, 2);
    const other = fakeWorker(pool, 1);
    expect(helper.sent.map((j) => j.method)).toEqual(['b']);
    expect(other.sent.map((j) => j.method)).toEqual(['c']);
    // Whichever finishes first takes the next.
    pool.result(helper.sent[0].id, { ok: true, value: null });
    await next();
    expect(helper.sent.map((j) => j.method)).toEqual(['b', 'd']);
    expect(pool.workerCount).toBe(3);
    await pool.close();
  });

  it('moves the job of a helper that goes away to another worker', async () => {
    const pool = new RenderPool(null);
    const main = fakeWorker(pool, 0);
    const helper = fakeWorker(pool, 1);
    const first = pool.call('s', 'one');
    const second = pool.call('s', 'two');
    expect(helper.sent.map((j) => j.method)).toEqual(['two']);
    helper.req.emit('close');
    pool.result(main.sent[0].id, { ok: true, value: 1 });
    expect(await first).toBe(1);
    await next();
    expect(main.sent.map((j) => j.method)).toEqual(['one', 'two']);
    pool.result(main.sent[1].id, { ok: true, value: 2 });
    expect(await second).toBe(2);
    await pool.close();
  });

  it('routes results, progress and cancels to the worker running the job', async () => {
    const pool = new RenderPool(null);
    fakeWorker(pool, 0);
    const helper = fakeWorker(pool, 1);
    const progress: number[] = [];
    const abort = new AbortController();
    void pool.call('s', 'long').catch(() => {});
    const second = pool.call('s', 'segment', [], { signal: abort.signal, onProgress: (p) => progress.push(p.done) });
    const id = helper.sent[0].id;
    expect(pool.progress(id, { stage: 'encoding', done: 3, total: 10 })).toBe(true);
    abort.abort();
    expect(pool.progress(id, { stage: 'encoding', done: 4, total: 10 })).toBe(false);
    expect(progress).toEqual([3, 4]);
    pool.result(id, { ok: false, error: 'Cancelled.' });
    await expect(second).rejects.toThrow('Cancelled.');
    await pool.close();
  });

  it('asks for helpers while a lease wants them, and lets them go a while after', async () => {
    vi.useFakeTimers();
    try {
      const counts: number[] = [];
      const pool = new RenderPool(null);
      pool.setHelperControl((n) => counts.push(n));
      fakeWorker(pool, 0);
      const releaseA = pool.lease(3);
      const releaseB = pool.lease(1);
      expect(counts).toEqual([3]);
      releaseA();
      releaseA();
      vi.advanceTimersByTime(29_000);
      expect(counts).toEqual([3]);
      // A new lease in the meantime keeps them.
      const releaseC = pool.lease(3);
      vi.advanceTimersByTime(60_000);
      expect(counts).toEqual([3]);
      releaseC();
      releaseB();
      vi.advanceTimersByTime(30_000);
      expect(counts).toEqual([3, 0]);
      await pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the helper count to a worker it launched', async () => {
    const asked: number[] = [];
    const pool = new RenderPool(async () => ({ exited: new Promise<void>(() => {}), close: async () => {}, helpers: (n: number) => asked.push(n) }));
    const release = pool.lease(2);
    await next();
    expect(asked).toEqual([2]);
    release();
    await pool.close();
  });
});
