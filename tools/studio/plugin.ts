// The studio server protocol (ADR 0001), served by the Vite dev server for
// now: HTTP endpoints under /__studio/ for the request queue, the current
// selection and reference uploads, and a push of the whole queue over Vite's
// websocket (event "frame-studio:queue") whenever .frame-studio/ changes. It
// also runs the agents that live in the studio (ADR 0006): their turns stream
// over the same websocket (event "frame-studio:turn"), and they reach the
// studio tools at /__studio/mcp. The same endpoints move into a standalone
// Node server when the Electron app arrives. Node only.

import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import {
  checkNewRequest,
  checkRetry,
  MAX_REFERENCE_BYTES,
  QUEUE_EVENT,
  REFERENCE_TYPES,
  type AgentStatus,
  type ApprovalDecision,
  type CurrentSelection,
  type NewRequest,
  type Reply,
  type TurnSettings,
} from '../../src/studio/protocol.ts';
import { createSerial } from '../mcp/tools.ts';
import type { Workspace } from '../mcp/workspace.ts';
import { entryPath, loadModules, ROOT, sceneLibrary, writeFileAtomic } from '../scene-files.ts';
import { STUDIO_INSTRUCTIONS } from './agents/instructions.ts';
import { createProviders } from './agents/providers.ts';
import { AgentRunner, readTurnEvents } from './agents/runner.ts';
import { McpEndpoint } from './mcp-http.ts';
import { REFERENCES_DIR, STUDIO_DIR, type StudioInlineConfig } from './paths.ts';
import { StudioQueue } from './queue.ts';

/** The external agent, as the agent picker shows it next to the studio's own. */
const EXTERNAL: AgentStatus = {
  id: 'external',
  label: 'External agent',
  ready: true,
  detail: 'Any agent with the frame-studio MCP server, such as Claude Code in a terminal. Take it with /frame-studio:next.',
  models: [],
  efforts: [],
};

const FRAME_FILE = /^frame-[a-z0-9]+-\d{3,}\.png$/;

export { QUEUE_EVENT, REFERENCES_DIR, STUDIO_DIR };

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
 * Refuses anything not from this computer, even when Vite listens on the
 * network (--host): the studio server can start agents, and a full-access
 * agent runs commands. Processes on this computer are trusted, as they could
 * write the queue files directly anyway; the standalone server of M9 adds
 * pairing (ADR 0001).
 */
function checkLocal(req: IncomingMessage): void {
  const remote = req.socket.remoteAddress ?? '';
  const loopback = remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  if (!loopback) throw new HttpError(403, 'The studio server only answers this computer.');
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

      // Agents run only in the dev server the viewer uses, not in the Vite servers tools start (startVite).
      const agents = (server.config.inlineConfig as StudioInlineConfig).frameStudio?.agents !== false;

      // The studio tools for agents in the studio, over one workspace (its own Vite server and
      // headless page), started when an agent first calls a tool.
      let workspace: Promise<Workspace> | null = null;
      // Loaded on first use, so the dev server doesn't load Playwright until an agent needs pixels.
      const ws = () =>
        (workspace ??= import('../mcp/workspace.ts')
          .then(({ Workspace }) => Workspace.open())
          .catch((err) => {
            workspace = null;
            throw err;
          }));
      const endpoint = new McpEndpoint(ws, createSerial());
      const runner = new AgentRunner({
        queue,
        providers: agents ? createProviders(STUDIO_DIR) : [],
        root: ROOT,
        endpoint,
        mcpUrl: () => {
          const base = server.resolvedUrls?.local[0];
          return base ? `${base}__studio/mcp` : null;
        },
        push: (event, data) => server.ws.send({ type: 'custom', event, data }),
        instructions: async () => STUDIO_INSTRUCTIONS,
        sceneInfo: async (sceneId) => {
          const modules = await loadModules(server);
          const entry = modules.library.findEntry(await sceneLibrary(modules), sceneId);
          if (!entry) return {};
          const scene = entry.scene;
          if (!scene) return { file: entry.file };
          const rigs = [...new Set(modules.engine.rigIdsUsed(scene).map((id) => modules.engine.baseRigId(id)))];
          return { file: entry.file, timecode: (f: number) => modules.engine.formatTimecode(f, scene.fps), rigs };
        },
      });
      if (agents) {
        server.httpServer?.once('listening', () => {
          runner.start().catch((err) => console.error('[frame-studio] agent runner:', err));
        });
      }
      server.httpServer?.once('close', () => {
        void runner.dispose();
        void workspace?.then((w) => w.close()).catch(() => {});
      });

      // Push the queue when .frame-studio/ changes. Watch the folders, not files, and wait
      // out the several steps an atomic write takes (T3 Code does the same).
      let timer: ReturnType<typeof setTimeout> | null = null;
      const push = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          runner.kick();
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
          checkLocal(req);
          checkOrigin(req);
          // The studio tools for agents in the studio; the endpoint checks the turn's token and reads the body itself.
          if (url.pathname === '/mcp') return await endpoint.handle(req, res);
          if (req.method === 'GET' && url.pathname === '/queue') return send(res, 200, { requests: await queue.list() });
          if (req.method === 'GET' && url.pathname === '/agents') {
            return send(res, 200, { agents: [EXTERNAL, ...(await runner.statuses(url.searchParams.has('fresh')))] });
          }
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
          const id = parts[0] === 'requests' && parts.length >= 3 ? Number(parts[1]) : NaN;
          if (parts[0] === 'requests' && parts.length >= 3 && !Number.isInteger(id)) throw new HttpError(400, `Bad request id ${JSON.stringify(parts[1])}.`);
          // A turn's saved events, and the frames its agent rendered.
          if (req.method === 'GET' && Number.isInteger(id) && parts[2] === 'turns' && parts.length >= 5) {
            const turn = Number(parts[3]);
            if (!Number.isInteger(turn) || turn < 0) throw new HttpError(400, `Bad turn ${JSON.stringify(parts[3])}.`);
            const dir = join(queue.threadDir(id));
            if (parts[4] === 'events' && parts.length === 5) return send(res, 200, { events: await readTurnEvents(join(dir, `turn-${turn}.jsonl`)) });
            if (parts[4] === 'frames' && parts.length === 6 && FRAME_FILE.test(parts[5])) {
              const data = await readFile(join(dir, `turn-${turn}`, parts[5])).catch(() => null);
              if (!data) throw new HttpError(404, 'No such frame.');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'image/png');
              res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
              return res.end(data);
            }
          }
          if (req.method === 'POST' && Number.isInteger(id) && parts.length === 3) {
            const action = parts[2];
            if (action === 'reply') {
              const input = await json<Reply>(req);
              const problem = checkNewRequest(input, { reply: true });
              if (problem) throw new HttpError(400, problem);
              return send(res, 201, { request: await queue.reply(id, input) });
            }
            if (action === 'settle') return send(res, 200, { request: await queue.settle(id) });
            if (action === 'stop') {
              if (!(await runner.stop(id))) throw new HttpError(409, `No agent in the studio is working on request #${id}.`);
              return send(res, 200, { ok: true });
            }
            if (action === 'cancel') {
              // A studio agent working the turn is stopped first, so it can't write after the cancel.
              await runner.stop(id);
              return send(res, 200, { request: await queue.cancel(id) });
            }
            if (action === 'requeue') return send(res, 200, { request: await queue.requeue(id) });
            if (action === 'revert') {
              const input = await json<{ turn?: unknown } | null>(req);
              const turn = input?.turn;
              if (turn !== undefined && !(typeof turn === 'number' && Number.isInteger(turn) && turn >= 0)) throw new HttpError(400, 'turn must be a turn index');
              return send(res, 200, { request: turn === undefined ? await queue.revertAll(id) : await queue.revertTo(id, turn) });
            }
            if (action === 'retry') {
              const input = await json<{ prompt?: string; references?: string[]; settings?: TurnSettings } | null>(req);
              const problem = checkRetry(input);
              if (problem) throw new HttpError(400, problem);
              return send(res, 201, {
                request: await queue.retry(id, input?.prompt, {
                  ...(input?.references ? { references: input.references } : {}),
                  ...(input?.settings ? { settings: input.settings } : {}),
                }),
              });
            }
          }
          if (req.method === 'POST' && Number.isInteger(id) && parts[2] === 'approvals' && parts.length === 4) {
            const input = await json<{ decision?: unknown } | null>(req);
            const decision = input?.decision;
            if (decision !== 'accept' && decision !== 'decline') throw new HttpError(400, 'decision must be "accept" or "decline"');
            if (!runner.respond(id, parts[3], decision as ApprovalDecision)) throw new HttpError(409, 'That approval is no longer open.');
            return send(res, 200, { ok: true });
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
