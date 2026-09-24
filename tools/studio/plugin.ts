// The studio server protocol (ADR 0001), served by the Vite dev server for
// now: HTTP endpoints under /__studio/ for the request queue, the current
// selection and reference uploads, and a push of the whole queue over Vite's
// websocket (event "frame-studio:queue") whenever .frame-studio/ changes. The
// same endpoints move into a standalone Node server when the Electron app
// arrives. Node only.

import { watch, type FSWatcher } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import {
  checkNewRequest,
  MAX_REFERENCE_BYTES,
  QUEUE_EVENT,
  REFERENCE_TYPES,
  type CurrentSelection,
  type NewRequest,
} from '../../src/studio/protocol.ts';
import { entryPath, loadModules, ROOT, sceneLibrary, writeFileAtomic } from '../scene-files.ts';
import { StudioQueue } from './queue.ts';

/** The handoff folder. FRAME_STUDIO_DIR moves it, so tests never touch a real queue. */
export const STUDIO_DIR = process.env.FRAME_STUDIO_DIR ?? join(ROOT, '.frame-studio');
export const REFERENCES_DIR = join(ROOT, 'references');
export { QUEUE_EVENT };

const MAX_JSON_BYTES = 256 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `The upload is over the ${Math.round(limit / 1024 / 1024)} MB limit.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Refuses requests from other sites. Any page open in the browser can send a
 * simple POST to localhost, so without this a website could queue prompts for
 * the agent, or revert scenes. Browsers say where a request comes from in
 * Sec-Fetch-Site, or failing that Origin; tools without either (curl, tests)
 * are local processes that could write the files directly anyway.
 */
function checkOrigin(req: IncomingMessage): void {
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

async function json<T>(req: IncomingMessage): Promise<T> {
  // JSON only: a JSON body forces a CORS preflight, which other sites fail.
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const text = (await body(req, MAX_JSON_BYTES)).toString('utf8');
  try {
    return JSON.parse(text || 'null') as T;
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

/** "Sad Bear (1).PNG" -> "sad-bear-1". */
function slug(name: string): string {
  return (
    name
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'reference'
  );
}

/** Saves an uploaded image as references/<date>-<slug>.<ext>, numbering it if the name is taken. Returns the repo-relative path. */
async function saveReference(name: string, type: string, data: Buffer): Promise<string> {
  const ext = REFERENCE_TYPES[type];
  if (!ext) throw new HttpError(415, 'References must be PNG, JPEG or WebP images.');
  if (data.length === 0) throw new HttpError(400, 'The image is empty.');
  await mkdir(REFERENCES_DIR, { recursive: true });
  const stem = `${new Date().toISOString().slice(0, 10)}-${slug(name)}`;
  for (let n = 1; ; n++) {
    const file = `${stem}${n === 1 ? '' : `-${n}`}${ext}`;
    const path = join(REFERENCES_DIR, file);
    try {
      await stat(path);
    } catch {
      await writeFileAtomic(path, data);
      return `references/${file}`;
    }
  }
}

export function studioServer(): Plugin {
  return {
    name: 'frame-studio-studio-server',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const queue = new StudioQueue(STUDIO_DIR, async (sceneId) => {
        const modules = await loadModules(server);
        const entry = modules.library.findEntry(await sceneLibrary(modules), sceneId);
        if (!entry) throw new HttpError(404, `No scene "${sceneId}".`);
        return entryPath(entry);
      });

      // Push the queue when .frame-studio/ changes. Watch the folders, not files, and wait
      // out the several steps an atomic write takes (T3 Code does the same).
      let timer: ReturnType<typeof setTimeout> | null = null;
      const push = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          try {
            server.ws.send({ type: 'custom', event: QUEUE_EVENT, data: { requests: await queue.list() } });
          } catch {
            // The next change pushes again.
          }
        }, 100);
      };
      const watchers: FSWatcher[] = [];
      mkdir(queue.requestsDir, { recursive: true })
        .then(() => {
          // Not persistent, so a watcher never keeps a finished tool's process alive.
          watchers.push(watch(queue.requestsDir, { persistent: false }, push));
        })
        .catch(() => {});
      server.httpServer?.once('close', () => watchers.forEach((w) => w.close()));

      server.middlewares.use('/__studio', async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://studio');
        const parts = url.pathname.split('/').filter(Boolean);
        try {
          checkOrigin(req);
          if (req.method === 'GET' && url.pathname === '/queue') return send(res, 200, { requests: await queue.list() });
          if (req.method === 'GET' && url.pathname === '/selection') return send(res, 200, { selection: await queue.readSelection() });
          if (req.method === 'PUT' && url.pathname === '/selection') {
            const selection = await json<Omit<CurrentSelection, 'updatedAt'> | null>(req);
            if (selection !== null) {
              // The same checks as a request's selection, frame and point, with a stand-in prompt.
              const problem = checkNewRequest({ selection: { sceneId: selection.sceneId, layerId: selection.layerId, partId: selection.partId, from: selection.from, to: selection.to }, frame: selection.frame, point: selection.point, prompt: '-', references: [] });
              if (problem) throw new HttpError(400, problem);
            }
            await queue.writeSelection(selection);
            return send(res, 200, { ok: true });
          }
          if (req.method === 'POST' && url.pathname === '/requests') {
            const input = await json<NewRequest>(req);
            const problem = checkNewRequest(input);
            if (problem) throw new HttpError(400, problem);
            return send(res, 201, { request: await queue.create(input) });
          }
          if (req.method === 'POST' && url.pathname === '/requests/clear') return send(res, 200, { removed: await queue.clearFinished() });
          if (req.method === 'POST' && parts[0] === 'requests' && parts.length === 3) {
            const id = Number(parts[1]);
            if (!Number.isInteger(id)) throw new HttpError(400, `Bad request id ${JSON.stringify(parts[1])}.`);
            const action = parts[2];
            if (action === 'cancel') return send(res, 200, { request: await queue.cancel(id) });
            if (action === 'requeue') return send(res, 200, { request: await queue.requeue(id) });
            if (action === 'revert') return send(res, 200, { request: await queue.revert(id) });
            if (action === 'retry') {
              const input = await json<{ prompt?: unknown } | null>(req);
              const prompt = input?.prompt;
              if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > 8000)) throw new HttpError(400, 'prompt must be text');
              return send(res, 201, { request: await queue.retry(id, prompt) });
            }
          }
          if (req.method === 'POST' && url.pathname === '/references') {
            const name = url.searchParams.get('name') ?? 'reference';
            const path = await saveReference(name, String(req.headers['content-type'] ?? ''), await body(req, MAX_REFERENCE_BYTES));
            return send(res, 201, { path });
          }
          next();
        } catch (err) {
          send(res, err instanceof HttpError ? err.status : 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}
