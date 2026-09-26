// Small HTTP helpers for the studio server. Node only.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_JSON_BYTES = 256 * 1024;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `The upload is over the ${Math.round(limit / 1024 / 1024)} MB limit.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function json<T>(req: IncomingMessage): Promise<T> {
  // JSON only: a JSON body forces a CORS preflight, which other sites fail.
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const text = (await body(req, MAX_JSON_BYTES)).toString('utf8');
  try {
    return JSON.parse(text || 'null') as T;
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

export function send(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

/**
 * Refuses anything not from this computer. The server binds 127.0.0.1, so
 * this only matters if that ever changes: the studio server can start agents,
 * and a full-access agent runs commands.
 */
export function checkLocal(req: IncomingMessage): void {
  const remote = req.socket.remoteAddress ?? '';
  const loopback = remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  if (!loopback) throw new HttpError(403, 'The studio server only answers this computer.');
}

/**
 * Refuses requests from other sites. Any page open in the browser can send a
 * simple request to 127.0.0.1, so without this a website could queue prompts
 * for an agent. Browsers say where a request comes from in Sec-Fetch-Site, or
 * failing that Origin. Tools send neither, and pair with a bearer token.
 */
export function checkOrigin(req: IncomingMessage): void {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) {
    if (site === 'same-origin' || site === 'none') return;
    throw new HttpError(403, 'The studio server only takes requests from the viewer itself.');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    throw new HttpError(403, 'The studio server only takes requests from the viewer itself.');
  }
}
