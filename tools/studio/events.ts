// The studio server's pushes (ADR 0008): one Server-Sent Events stream per
// page, carrying the queue, turn events, library changes and export progress.
// Pages talk back over plain HTTP, so one-way is all the stream needs. Node only.

import type { IncomingMessage, ServerResponse } from 'node:http';

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor() {
    // A comment line now and then keeps idle connections open through anything that times them out.
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  /** Opens a stream on `res`, until the page goes away. */
  open(req: IncomingMessage, res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  /** Sends one event to every open page. */
  send(event: string, data: unknown): void {
    const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(text);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
