import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { RenderPool } from '../../tools/studio/render-pool';

/** A worker connection that records the jobs sent down it. */
function fakeWorker(pool: RenderPool): { sent: { id: string; method: string; release?: boolean }[] } {
  const sent: { id: string; method: string; release?: boolean }[] = [];
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
  pool.attach(new EventEmitter() as IncomingMessage, res as unknown as ServerResponse);
  return { sent };
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
});
