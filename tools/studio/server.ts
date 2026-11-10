// The studio server (ADR 0001, ADR 0008): one local Node server for
// everything that needs the machine. It serves the viewer, pairs pages and
// tools with a token, and under /__studio/ it serves the scene files, the rig
// and generator modules, the request queue, reference uploads, agents in the
// studio and their MCP tools, the render worker's jobs, and exports. Pushes go
// over one event stream per page. The app starts it in a utility process;
// `npm run dev`, the CLI and the MCP shim start it in Node. Node only.

import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import {
  checkClipEdit,
  checkLayerEdit,
  checkNewComposition,
  checkNewRequest,
  checkNewScene,
  checkNewVideo,
  checkRetry,
  checkSettings,
  CHECK_EVENT,
  checkPlacedVoice,
  EXPORT_EVENT,
  LIBRARY_EVENT,
  MAX_REFERENCE_BYTES,
  QUEUE_EVENT,
  REFERENCE_TYPES,
  SPEECH_EVENT,
  THUMB_EVENT,
  VOICE_EVENT,
  type AgentStatus,
  type ApprovalDecision,
  type ClipEdit,
  type CurrentSelection,
  type LayerChange,
  type LayerEdit,
  type NewComposition,
  type NewRequest,
  type NewScene,
  type NewVideo,
  type PlacedVoice,
  type QuestionAnswers,
  type Reply,
  type StudioRequest,
  type TurnSettings,
} from '../../src/studio/protocol.ts';
import { checkTimelineEdit, placeClip, type TimelineEdit, type TimelineFile } from '../../src/studio/timeline-edit.ts';
import { buildEmbed } from '../bundle/embed.ts';
import { kokoro } from '../voice/kokoro.ts';
import { saveVoiceFile } from '../voice/save.ts';
import { listMedia, mediaInfo, saveMedia, serveMedia } from './media.ts';
import { listRenders, serveRender } from './renders.ts';
import { Thumbs } from './thumbs.ts';
import { createSerial } from '../mcp/tools.ts';
import { withoutId, type Workspace } from '../mcp/workspace.ts';
import { entryPath, loadModules, readSceneFiles, sceneLibrary, writeFileAtomic } from '../scene-files.ts';
import { voiceStatus } from '../voice/align.ts';
import { runCheck } from './check.ts';
import { STUDIO_INSTRUCTIONS } from './agents/instructions.ts';
import { createProviders } from './agents/providers.ts';
import { AgentRunner, readTurnEvents } from './agents/runner.ts';
import { CodeHost, withheldCode } from './code.ts';
import { convertFilm } from './convert.ts';
import { EventHub } from './events.ts';
import type { StudioFolder } from './folder.ts';
import { body, checkLocal, checkOrigin, HttpError, json, send } from './http.ts';
import { McpEndpoint } from './mcp-http.ts';
import { MODULES_PATH, ModuleService } from './modules.ts';
import { Pairing } from './pairing.ts';
import { isImportable } from './project-code.ts';
import { electronWorker } from './electron-worker.ts';
import { exportVideoFile } from './export-video.ts';
import { RenderPool } from './render-pool.ts';
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
/** The port the server tries first, so a page's storage survives restarts. */
export const DEFAULT_PORT = 4753;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

export interface StudioServerOptions {
  folder: StudioFolder;
  /** The pairing token. */
  token: string;
  /** The port to try first; 0 for any free port. The server falls back to a free port when it's taken. */
  port?: number;
  /** Where the viewer comes from: the built files, or Vite's dev middleware on the repo. */
  viewer: { kind: 'static'; dir: string } | { kind: 'vite'; hmr?: boolean };
  /** Run the agents in the studio (ADR 0006). Only the server the viewer uses should. */
  agents?: boolean;
  /** Render posters for the viewer's library in the background. On by default; tests that don't look at them turn it off. */
  thumbs?: boolean;
  /**
   * Who opens the render worker: 'electron' launches Electron in worker-only mode when a job arrives and none
   * is connected; 'app' waits for the app, which opens it in a hidden window.
   */
  worker: 'electron' | 'app';
  /** Write .frame-studio/server.json, so tools reuse this server. */
  discovery?: boolean;
  /** Print a line for each problem the server hits while running. */
  log?: (line: string) => void;
}

export interface StudioServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly folder: StudioFolder;
  readonly pool: RenderPool;
  readonly code: CodeHost;
  readonly queue: StudioQueue;
  /** The workspace the MCP tools work in, started on first use. */
  workspace(): Promise<Workspace>;
  /** Bumps the file generation, after a write the watcher may not have seen yet. Returns the new generation. */
  touch(): number;
  close(): Promise<void>;
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

async function listen(server: Server, port: number): Promise<number> {
  const attempt = (p: number) =>
    new Promise<number>((done, fail) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        fail(err);
      };
      const onListening = () => {
        server.off('error', onError);
        done((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });
  try {
    return await attempt(port);
  } catch (err) {
    if (port === 0 || (err as { code?: string }).code !== 'EADDRINUSE') throw err;
    return attempt(0);
  }
}

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const { folder } = options;
  const log = options.log ?? ((line: string) => console.error(`[frame-studio] ${line}`));
  const pairing = new Pairing(options.token);
  const events = new EventHub();
  const modules = new ModuleService(folder);
  const code = new CodeHost(folder);
  let generation = 1;
  const touch = () => ++generation;

  const sceneFile = async (sceneId: string) => {
    const mods = await loadModules(code);
    const entry = mods.library.findEntry(await sceneLibrary(mods, folder), sceneId);
    if (!entry) throw new HttpError(404, `No scene "${sceneId}".`);
    return entryPath(entry, folder);
  };
  const queue = new StudioQueue(folder.studio, sceneFile);

  const http = createServer();
  let url = '';
  let pool: RenderPool;

  // The studio tools for agents, over one workspace, started when a tool is first called.
  let workspace: Promise<Workspace> | null = null;
  const ws = () =>
    (workspace ??= import('../mcp/workspace.ts')
      .then(({ Workspace }) => new Workspace({ folder, code, pool, queue, touch, generation: () => generation }))
      .catch((err) => {
        workspace = null;
        throw err;
      }));
  // The MCP tools and the viewer's New scene and New project take turns on the scene files.
  const serial = createSerial();
  const endpoint = new McpEndpoint(ws, serial, options.token, queue);
  /** Runs a create in turn with the tools. What it refuses, such as a taken name, goes back to the viewer as a 409. */
  const created = <T>(fn: () => Promise<T>): Promise<T> =>
    serial(async () => {
      try {
        return await fn();
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    });
  // No trust, no agents: an agent can write the code the user just declined to run (ADR 0017).
  const agents = (options.agents ?? false) && !folder.untrusted;
  const AGENTS_OFF = "You opened this project without its code, so the studio's agents are off. Trust the project to turn them on.";
  const agentsOff = () => (folder.untrusted && options.agents ? AGENTS_OFF : null);
  /** Refuses a turn for a studio agent while they're off. */
  const needAgents = (agent: unknown) => {
    if (folder.untrusted && agent !== undefined && agent !== 'external') throw new HttpError(409, AGENTS_OFF);
  };
  const runner = new AgentRunner({
    queue,
    providers: agents ? createProviders(folder.studio) : [],
    root: folder.root,
    endpoint,
    mcpUrl: () => (url ? `${url}/__studio/mcp` : null),
    push: (event, data) => events.send(event, data),
    instructions: async () => STUDIO_INSTRUCTIONS,
    enabled: () => !folder.untrusted,
    sceneInfo: async (sceneId) => {
      const mods = await loadModules(code);
      const entry = mods.library.findEntry(await sceneLibrary(mods, folder), sceneId);
      if (!entry) return {};
      const scene = entry.scene;
      if (!scene) return { file: entry.file };
      // Cast members' rigs and the rigs of every scene it places count too (ADR 0007).
      const rigs = [...new Set(mods.engine.rigIdsUsed(scene, entry.world).map((id) => mods.engine.baseRigId(id)))];
      return { file: entry.file, timecode: (f: number) => mods.engine.formatTimecode(f, scene.fps), rigs };
    },
  });

  // ---- files: watch the folder, and tell pages what changed ----

  const watchers: FSWatcher[] = [];
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let codeChanged = false;
  const changed = (isCode: boolean) => {
    codeChanged ||= isCode;
    if (changeTimer) clearTimeout(changeTimer);
    // Wait out the several steps an atomic write takes.
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (codeChanged) {
        code.invalidate();
        modules.invalidate();
      }
      codeChanged = false;
      events.send(LIBRARY_EVENT, { generation: touch() });
    }, 100);
  };
  const relevant = (base: string, file: string): 'files' | 'code' | null => {
    const rel = relative(base, file).split(sep).join('/');
    if (/^(scenes|compositions)\/[^/]+\.json$/.test(rel) || rel === 'project.json' || /^projects\/[^/]+\/[^/]+\.json$/.test(rel) || /^media\//.test(rel)) return 'files';
    if (isImportable(rel) && (/^(rigs|audio)\//.test(rel) || /^projects\/[^/]+\/rigs\//.test(rel))) return 'code';
    return null;
  };
  try {
    watchers.push(
      watch(folder.root, { recursive: true, persistent: false }, (_event, name) => {
        if (!name) return;
        const kind = relevant(folder.root, join(folder.root, name.toString()));
        if (kind) changed(kind === 'code');
      }),
    );
  } catch (err) {
    log(`could not watch ${folder.root}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The built-ins change in the repo; the app's are read-only, so watching them costs nothing there.
  {
    try {
      watchers.push(
        watch(folder.builtins, { recursive: true, persistent: false }, (_event, name) => {
          if (name && /^(engine|rigs|audio)[/\\].*\.ts$/.test(name.toString())) changed(true);
        }),
      );
    } catch {
      // No built-ins to watch.
    }
  }

  /** Threads as pages see them: a pending turn the runner may not take says so. The field is never read from a file. */
  const shownThreads = (requests: StudioRequest[]) =>
    requests.map(({ held: _, ...thread }) => (thread.status === 'pending' && thread.agent !== 'external' && !runner.isAllowed(thread) ? { ...thread, held: true } : thread));

  // Push the queue when .frame-studio/requests changes.
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  const pushQueue = () => {
    if (queueTimer) clearTimeout(queueTimer);
    queueTimer = setTimeout(async () => {
      queueTimer = null;
      runner.kick();
      try {
        events.send(QUEUE_EVENT, { requests: shownThreads(await queue.list()) });
      } catch {
        // The next change pushes again.
      }
    }, 100);
  };
  await mkdir(queue.requestsDir, { recursive: true });
  watchers.push(watch(queue.requestsDir, { persistent: false }, pushQueue));

  // ---- posters for the library ----

  const thumbs = new Thumbs({
    dir: join(folder.studio, 'thumbs'),
    enabled: options.thumbs !== false,
    entries: async () => {
      const mods = await loadModules(code);
      const library = await sceneLibrary(mods, folder);
      return { entries: library.entries, shared: await modules.manifest(), media: await listMedia(folder) };
    },
    render: (key, frame, path, maxWidth) => withSink(path, (sink) => pool.call(key, 'writePng', [frame, sink, { maxWidth }], { low: true, release: true })),
    push: (key, file) => events.send(THUMB_EVENT, { key, file }),
  });

  /** Runs `write` with a sink that lands in a temporary file, which becomes `path` when it succeeds. */
  async function withSink<T>(path: string, write: (sink: string) => Promise<T>): Promise<T> {
    const partial = `${path}.partial`;
    const sink = await pool.openSink(partial);
    try {
      const result = await write(sink);
      await pool.closeSink(sink);
      await rename(partial, path);
      return result;
    } finally {
      await pool.closeSink(sink);
      await rm(partial, { force: true });
    }
  }

  // ---- exports from the viewer ----

  const exports = new Map<string, AbortController>();
  let exportCount = 0;
  const pad = (n: number) => String(n).padStart(5, '0');
  async function runExport(id: string, input: { scene: string; target: 'mp4' | 'gif' | 'html'; from?: number; to?: number; silent?: boolean; media?: boolean }, signal: AbortSignal) {
    const progress = (stage: string, done: number, total: number) => events.send(EXPORT_EVENT, { id, stage, done, total });
    if (input.target === 'html') {
      progress('bundling', 0, 1);
      const embed = await buildEmbed(input.scene, { folder, code, silent: input.silent, media: input.media });
      if (signal.aborted) throw new Error('Cancelled.');
      const path = join(folder.out, embed.out, `${embed.scene.id}.html`);
      await writeFileAtomic(path, embed.html);
      const left = embed.mediaLeftOut;
      const note = left.length > 0 ? `Left out ${left.length === 1 ? 'the sound file' : `${left.length} sound files`}: ${left.join(', ')}. Tick Include sound files to carry them.` : undefined;
      return { file: path, bytes: embed.bytes.total, ...(note ? { note } : {}) };
    }
    const info = (await pool.call(input.scene, 'info', [], {})) as { scene: { id: string; out: string; frameCount: number } | null; errors: string[] };
    if (!info.scene) throw new Error(info.errors.join('\n') || `Scene "${input.scene}" cannot render.`);
    const ranged = input.from !== undefined || input.to !== undefined;
    const suffix = ranged ? `-${pad(input.from ?? 0)}-${pad(input.to ?? info.scene.frameCount)}` : '';
    const path = join(folder.out, info.scene.out, `${info.scene.id}${suffix}.${input.target}`);
    const result = await exportVideoFile(pool, input.scene, path, {
      target: input.target,
      from: input.from,
      to: input.to,
      silent: input.silent,
      signal,
      onProgress: (p) => progress(p.stage, p.done, p.total),
    });
    return { file: path, ...result };
  }

  // ---- creating from the viewer ----

  /** create_scene, then the pixel stage it has no argument for yet. A stage the scene refuses takes the new file back out. */
  async function makeScene(input: NewScene) {
    const w = await ws();
    const { pixel, ...plain } = input;
    const made = await w.createScene(plain);
    if (!pixel) return made;
    try {
      return { ...made, ...(await w.updateScene(made.id, { pixel })) };
    } catch (err) {
      await rm(join(folder.root, made.file), { force: true });
      throw err;
    }
  }

  /** A composition, with its first empty scene placed on its track unless asked for none. */
  async function makeVideo(input: NewVideo) {
    const w = await ws();
    const { pixel, scene, ...composition } = input;
    if (scene === false) return w.createComposition(composition);
    const first = await makeScene({ id: `${input.id}-1`, duration: input.duration, ...(input.fps !== undefined ? { fps: input.fps } : {}), ...(input.size ? { size: input.size } : {}), ...(pixel ? { pixel } : {}) });
    let made: Awaited<ReturnType<typeof w.createComposition>> | null = null;
    try {
      made = await w.createComposition(composition);
      await w.updateScene(made.id, { tracks: [{ id: 'V1', clips: [{ id: 'clip-1', scene: first.id }] }] });
      return made;
    } catch (err) {
      await rm(join(folder.root, first.file), { force: true });
      if (made) await rm(join(folder.root, made.file), { force: true });
      throw err;
    }
  }

  /** Sets a clip's start and trim through the same validation as update_scene. Returns the clip on either side, for undo. */
  async function moveClip(id: string, edit: ClipEdit): Promise<LayerChange> {
    const w = await ws();
    const { scene } = await w.getScene(id);
    const { tracks, fps, duration } = scene as unknown as TimelineFile;
    const clip = tracks?.flatMap((t) => t.clips).find((c) => c.id === edit.clip);
    if (!tracks || !clip) throw new Error(`Composition "${id}" has no clip "${edit.clip}".`);
    const before = structuredClone(clip);
    placeClip(clip, edit, { fps, duration });
    await w.updateScene(id, { tracks });
    return { before: withoutId(before), after: withoutId(clip) };
  }

  /** Whether an agent has a turn running on this scene or composition. Hand edits wait for it (ADR 0015). */
  async function agentWorks(id: string): Promise<boolean> {
    return (await queue.list()).some((r) => r.sceneId === id && r.status === 'working');
  }

  const checks = new Map<string, AbortController>();
  let checkCount = 0;
  const voices = new Map<string, AbortController>();
  let voiceCount = 0;

  // ---- static files for the viewer ----

  let vite: ViteDevServer | null = null;
  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (options.viewer.kind !== 'static') return;
    const dir = resolve(options.viewer.dir);
    const wanted = pathname === '/' ? '/index.html' : pathname;
    const file = resolve(dir, `.${decodeURIComponent(wanted)}`);
    if (!file.startsWith(dir + sep)) throw new HttpError(404, 'Not found.');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, 'Not found.');
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
    // Built assets carry a hash in their names; the pages themselves must be fresh.
    res.setHeader('Cache-Control', wanted.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (extname(file) === '.html') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'");
    }
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  }

  // ---- routes ----

  async function studio(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.slice('/__studio'.length) || '/';
    const parts = path.split('/').filter(Boolean);
    checkLocal(req);
    if (req.method === 'GET' && path === '/health') {
      const authorized = pairing.allows(req);
      return send(res, 200, { ok: true, ...(authorized ? { folder: folder.root, pid: process.pid, untrusted: folder.untrusted === true } : {}) });
    }
    checkOrigin(req);
    if (req.method === 'POST' && path === '/pair') {
      const input = await json<{ token?: unknown } | null>(req);
      if (typeof input?.token !== 'string' || !pairing.isToken(input.token)) throw new HttpError(403, 'That pairing token is not this server’s.');
      pairing.setCookie(res);
      return send(res, 200, { ok: true });
    }
    // The studio tools for agents; the endpoint checks its own tokens, per turn or the pairing token.
    if (path === '/mcp') return endpoint.handle(req, res);
    if (!pairing.allows(req)) throw new HttpError(401, 'Not paired with this studio server. Open the link the server printed, or the app.');

    if (req.method === 'GET' && path === '/events') {
      events.open(req, res);
      // What the page may have missed between loading its library and opening the stream.
      res.write(`event: ${LIBRARY_EVENT}\ndata: ${JSON.stringify({ generation })}\n\n`);
      return;
    }
    if (req.method === 'GET' && path === '/files') {
      return send(res, 200, { generation, folder: folder.root, files: await readSceneFiles(folder), media: await listMedia(folder), withheldCode: await withheldCode(folder) });
    }
    // Sound files (ADR 0012): the list with lengths, a file's bytes, and uploads streamed to media/.
    if (req.method === 'GET' && path === '/media') return send(res, 200, { media: await mediaInfo(folder) });
    if (req.method === 'GET' && path.startsWith('/media/')) return serveMedia(folder, decodeURIComponent(path.slice(1)), res);
    if (req.method === 'POST' && path === '/media') {
      // A sound type or raw bytes, neither of which a form on another site can send without a preflight it fails.
      const type = String(req.headers['content-type'] ?? '');
      if (!type.startsWith('audio/') && !type.startsWith('application/octet-stream')) throw new HttpError(415, 'Send the sound file as audio/* or application/octet-stream.');
      const saved = await saveMedia(folder, url.searchParams.get('name') ?? 'sound', req);
      return send(res, 201, { file: saved });
    }
    // Kokoro (ADR 0017): is it here, fetch it, speak. No route here ever sees a key; those stay in the app's main process.
    if (req.method === 'GET' && path === '/speech') return send(res, 200, { kokoro: kokoro.status() });
    if (req.method === 'POST' && path === '/speech/install') {
      kokoro
        .install((done, total) => events.send(SPEECH_EVENT, { done, total }))
        .then(() => events.send(SPEECH_EVENT, { finished: true }))
        .catch((err: unknown) => events.send(SPEECH_EVENT, { error: err instanceof Error ? err.message : String(err) }));
      return send(res, 202, { kokoro: kokoro.status() });
    }
    if (req.method === 'POST' && path === '/speech/generate') {
      const input = await json<{ text?: unknown; lang?: unknown; voice?: unknown }>(req);
      if (typeof input?.text !== 'string' || typeof input.lang !== 'string' || (input.voice !== undefined && typeof input.voice !== 'string')) throw new HttpError(400, 'Send { text, lang, voice? }.');
      const { text, lang, voice } = input;
      const bytes = await Promise.resolve()
        .then(() => kokoro.speak(text, lang, voice))
        .catch((err: unknown) => {
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        });
      return send(res, 201, { file: await saveVoiceFile(folder.root, 'kokoro', '.wav', bytes) });
    }
    // Posters: where each scene's stands, starting any that are missing, and the files themselves, named by content.
    if (req.method === 'GET' && path === '/thumbs') return send(res, 200, { thumbs: await thumbs.list() });
    if (req.method === 'GET' && parts[0] === 'thumbs' && parts.length === 2) return thumbs.serve(parts[1], res);
    // What's in out/, newest first, and a file from there to play or open.
    if (req.method === 'GET' && path === '/renders') return send(res, 200, { renders: await listRenders(folder) });
    if (req.method === 'GET' && path.startsWith('/renders/')) return serveRender(folder, decodeURIComponent(path.slice('/renders/'.length)), req, res);
    if (req.method === 'GET' && path === '/modules') return send(res, 200, { generation, modules: await modules.manifest() });
    if (req.method === 'GET' && url.pathname.startsWith(MODULES_PATH)) {
      return modules.serve(url.pathname.slice(MODULES_PATH.length), url.searchParams.get('h'), res);
    }

    // The render worker.
    if (parts[0] === 'worker') {
      if (req.method === 'GET' && parts[1] === 'stream') {
        const slot = Number(url.searchParams.get('slot') ?? 0);
        if (!Number.isInteger(slot) || slot < 0 || slot > 64) throw new HttpError(400, 'slot must be a whole number from 0 to 64');
        return pool.attach(req, res, slot);
      }
      if (req.method === 'POST' && parts[1] === 'jobs' && parts.length === 3) {
        const answer = await json<{ ok: true; value: unknown } | { ok: false; error: string }>(req);
        return send(res, 200, { ok: pool.result(parts[2], answer) });
      }
      if (req.method === 'POST' && parts[1] === 'jobs' && parts[3] === 'progress') {
        const p = await json<{ stage: string; done: number; total: number }>(req);
        return send(res, 200, { go: pool.progress(parts[2], p) });
      }
      if (req.method === 'POST' && parts[1] === 'sinks' && parts.length === 3) {
        const position = Number(url.searchParams.get('position'));
        if (!Number.isInteger(position) || position < 0) throw new HttpError(400, 'position must be a byte offset');
        await pool.write(parts[2], position, await body(req, MAX_CHUNK_BYTES));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[1] === 'sinks' && parts[3] === 'close') {
        await pool.closeSink(parts[2]);
        return send(res, 200, { ok: true });
      }
    }

    // Rendering for tools in other processes: the CLI reusing this server.
    if (req.method === 'POST' && path === '/render/call') {
      const input = await json<{ scene: string; method: string; args?: unknown[] }>(req);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-store');
      // Headers now, and a blank line now and then, so a call queued behind a long export doesn't time out.
      res.flushHeaders();
      const keepAlive = setInterval(() => res.write('\n'), 15_000);
      const abort = new AbortController();
      res.on('close', () => {
        clearInterval(keepAlive);
        if (!res.writableFinished) abort.abort();
      });
      try {
        const value = await pool.call(input.scene, input.method, input.args ?? [], {
          signal: abort.signal,
          onProgress: (p) => res.write(`${JSON.stringify({ progress: p })}\n`),
        });
        res.end(`${JSON.stringify({ ok: true, value })}\n`);
      } catch (err) {
        res.end(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
      } finally {
        clearInterval(keepAlive);
      }
      return;
    }
    // Exports for tools in other processes, split across workers when that helps (ADR 0019).
    if (req.method === 'POST' && path === '/render/export') {
      const input = await json<{ scene?: unknown; path?: unknown; target?: unknown; from?: unknown; to?: unknown; silent?: unknown; workers?: unknown }>(req);
      if (typeof input.scene !== 'string') throw new HttpError(400, 'scene must be a scene id');
      if (typeof input.path !== 'string' || !input.path.startsWith('/')) throw new HttpError(400, 'path must be absolute');
      if (input.target !== 'mp4' && input.target !== 'gif') throw new HttpError(400, 'target must be mp4 or gif');
      const whole = (v: unknown, name: string, min: number) => {
        if (v === undefined || v === null) return undefined;
        if (!Number.isInteger(v) || (v as number) < min) throw new HttpError(400, `${name} must be a whole number, ${min} or more`);
        return v as number;
      };
      const job = { target: input.target as 'mp4' | 'gif', from: whole(input.from, 'from', 0), to: whole(input.to, 'to', 0), silent: input.silent === true, workers: whole(input.workers, 'workers', 1) };
      const target = input.path;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
      const keepAlive = setInterval(() => res.write('\n'), 15_000);
      const abort = new AbortController();
      res.on('close', () => {
        clearInterval(keepAlive);
        if (!res.writableFinished) abort.abort();
      });
      try {
        const value = await exportVideoFile(pool, input.scene, target, { ...job, signal: abort.signal, onProgress: (p) => res.write(`${JSON.stringify({ progress: p })}\n`) });
        res.end(`${JSON.stringify({ ok: true, value })}\n`);
      } catch (err) {
        res.end(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
      } finally {
        clearInterval(keepAlive);
      }
      return;
    }
    if (req.method === 'POST' && path === '/render/sinks') {
      const input = await json<{ path?: unknown }>(req);
      if (typeof input.path !== 'string' || !input.path.startsWith('/')) throw new HttpError(400, 'path must be absolute');
      return send(res, 201, { sink: await pool.openSink(input.path) });
    }
    if (req.method === 'POST' && parts[0] === 'render' && parts[1] === 'sinks' && parts[3] === 'close') {
      await pool.closeSink(parts[2]);
      return send(res, 200, { ok: true });
    }

    const frame = (v: unknown, name: string) => {
      if (v === undefined || v === null) return undefined;
      if (!Number.isInteger(v) || (v as number) < 0) throw new HttpError(400, `${name} must be a frame number`);
      return v as number;
    };

    // Exports from the viewer.
    if (req.method === 'POST' && path === '/export') {
      const input = await json<{ scene?: unknown; target?: unknown; from?: unknown; to?: unknown; silent?: unknown; media?: unknown }>(req);
      if (typeof input.scene !== 'string') throw new HttpError(400, 'scene must be a scene id');
      if (input.target !== 'mp4' && input.target !== 'gif' && input.target !== 'html') throw new HttpError(400, 'target must be mp4, gif or html');
      const job = { scene: input.scene, target: input.target as 'mp4' | 'gif' | 'html', from: frame(input.from, 'from'), to: frame(input.to, 'to'), silent: input.silent === true, media: input.media === true };
      if (job.target === 'html' && (job.from !== undefined || job.to !== undefined)) throw new HttpError(400, 'html exports the whole scene');
      const id = `export-${++exportCount}`;
      const abort = new AbortController();
      exports.set(id, abort);
      runExport(id, job, abort.signal)
        .then((result) => events.send(EXPORT_EVENT, { id, done: true, ...result }))
        .catch((err: unknown) => events.send(EXPORT_EVENT, { id, error: abort.signal.aborted ? 'Cancelled.' : err instanceof Error ? err.message : String(err) }))
        .finally(() => exports.delete(id));
      return send(res, 202, { id });
    }
    if (req.method === 'POST' && parts[0] === 'export' && parts[2] === 'cancel') {
      exports.get(parts[1])?.abort();
      return send(res, 200, { ok: true });
    }

    // Checks from the viewer, the same job as the MCP tool.
    if (req.method === 'POST' && path === '/check') {
      const input = await json<{ scene?: unknown; from?: unknown; to?: unknown; loop?: unknown }>(req);
      if (typeof input.scene !== 'string') throw new HttpError(400, 'scene must be a scene id');
      const job = { from: frame(input.from, 'from'), to: frame(input.to, 'to'), loop: input.loop === true };
      const id = `check-${++checkCount}`;
      const abort = new AbortController();
      checks.set(id, abort);
      runCheck({ pool, folder }, input.scene, job, { signal: abort.signal, onProgress: (p) => events.send(CHECK_EVENT, { id, ...p }) })
        .then(({ report }) => events.send(CHECK_EVENT, { id, report }))
        .catch((err: unknown) => events.send(CHECK_EVENT, { id, error: abort.signal.aborted ? 'Cancelled.' : err instanceof Error ? err.message : String(err) }))
        .finally(() => checks.delete(id));
      return send(res, 202, { id });
    }
    if (req.method === 'POST' && parts[0] === 'check' && parts[2] === 'cancel') {
      checks.get(parts[1])?.abort();
      return send(res, 200, { ok: true });
    }

    // New scenes and compositions from the viewer, the same operations as create_scene and create_composition.
    if (req.method === 'POST' && path === '/scenes') {
      const input = await json<NewScene>(req);
      const problem = checkNewScene(input);
      if (problem) throw new HttpError(400, problem);
      return send(res, 201, await created(() => makeScene(input)));
    }
    if (req.method === 'POST' && path === '/videos') {
      const input = await json<NewVideo>(req);
      const problem = checkNewVideo(input);
      if (problem) throw new HttpError(400, problem);
      return send(res, 201, await created(() => makeVideo(input)));
    }
    // Moving or trimming a clip from the timeline: the checked edit path, like update_scene, refused while an agent works there.
    const clipping = /^\/compositions\/([^/]+)\/clip$/.exec(path);
    if (req.method === 'POST' && clipping) {
      const id = decodeURIComponent(clipping[1]);
      const input = await json<ClipEdit>(req);
      const problem = checkClipEdit(input);
      if (problem) throw new HttpError(400, problem);
      if (await agentWorks(id)) throw new HttpError(409, 'An agent is working on this composition, so its clips stay put until it finishes.');
      return send(res, 200, await created(() => moveClip(id, input)));
    }
    // The timeline as an editor (ADR 0018): adding, splitting, duplicating and deleting clips and sound, tracks, fades and transitions.
    if (req.method === 'POST' && path === '/timeline') {
      const input = await json<{ scene?: unknown; edit?: unknown }>(req);
      if (typeof input?.scene !== 'string' || input.scene === '') throw new HttpError(400, 'Send { scene, edit }.');
      const problem = checkTimelineEdit(input.edit);
      if (problem) throw new HttpError(400, problem);
      const { scene } = input;
      if (await agentWorks(scene)) throw new HttpError(409, 'An agent is working on this scene, so it stays put until the agent finishes.');
      return send(res, 200, await created(() => ws().then((w) => w.editTimeline(scene, input.edit as TimelineEdit))));
    }
    // Moving a voice out of a video into a scene of its own, with captions (ADR 0018).
    if (req.method === 'POST' && path === '/voice-scene') {
      const input = await json<{ scene?: unknown; cue?: unknown }>(req);
      if (typeof input?.scene !== 'string' || typeof input.cue !== 'string') throw new HttpError(400, 'Send { scene, cue }.');
      const { scene, cue } = input;
      if (await agentWorks(scene)) throw new HttpError(409, 'An agent is working on this scene, so it stays put until the agent finishes.');
      return send(res, 200, await created(() => ws().then((w) => w.moveCueToScene(scene, cue))));
    }
    // A hand edit of a layer from the timeline or the canvas, or undoing one (ADR 0015). The same lock as a clip's.
    if (req.method === 'POST' && path === '/layers') {
      const input = await json<LayerEdit>(req);
      const problem = checkLayerEdit(input);
      if (problem) throw new HttpError(400, problem);
      if (await agentWorks(input.scene)) throw new HttpError(409, 'An agent is working on this scene, so it stays put until the agent finishes.');
      return send(res, 200, await created(() => ws().then((w) => w.editLayer(input.scene, input.layer, input.set))));
    }
    // Timing a voice (ADR 0016): the same job as align_voice, and the model it may need first.
    if (req.method === 'GET' && path === '/voice') return send(res, 200, await voiceStatus(folder.builtins));
    if (req.method === 'POST' && path === '/voice') {
      const input = await json<{ scene?: unknown; cue?: unknown; script?: unknown }>(req);
      const { scene, cue, script } = input ?? {};
      if (typeof scene !== 'string' || typeof cue !== 'string' || (script !== undefined && typeof script !== 'string')) throw new HttpError(400, 'Send { scene, cue, script? }.');
      if (await agentWorks(scene)) throw new HttpError(409, 'An agent is working on this scene, so it stays put until the agent finishes.');
      const id = `voice-${++voiceCount}`;
      const abort = new AbortController();
      voices.set(id, abort);
      ws()
        .then((w) => w.alignVoice(scene, cue, { script, signal: abort.signal, onProgress: (p) => events.send(VOICE_EVENT, { id, ...p }) }))
        .then((result) => events.send(VOICE_EVENT, { id, words: result.words }))
        .catch((err: unknown) => events.send(VOICE_EVENT, { id, error: abort.signal.aborted ? 'Cancelled.' : err instanceof Error ? err.message : String(err) }))
        .finally(() => voices.delete(id));
      return send(res, 202, { id });
    }
    if (req.method === 'POST' && parts[0] === 'voice' && parts[2] === 'cancel') {
      voices.get(parts[1])?.abort();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/sounds') {
      // Add at playhead: a cue playing a sound file, from the viewer's Media list (ADR 0012).
      const input = await json<{ scene?: unknown; file?: unknown; start?: unknown; voice?: unknown }>(req);
      if (typeof input?.scene !== 'string' || typeof input.file !== 'string' || typeof input.start !== 'number' || !Number.isFinite(input.start)) {
        throw new HttpError(400, 'Send { scene, file, start, voice? }.');
      }
      const { scene, file, start, voice } = input;
      const problem = voice === undefined ? null : checkPlacedVoice(voice);
      if (problem) throw new HttpError(400, problem);
      return send(res, 201, await created(() => ws().then((w) => w.placeSound(scene, file, start, voice as PlacedVoice | undefined))));
    }
    // Converting an M9 film into a project folder of its own (ADR 0013), beside this one unless `to` says where.
    const converting = /^\/projects\/([^/]+)\/convert$/.exec(path);
    if (req.method === 'POST' && converting) {
      const id = decodeURIComponent(converting[1]);
      const input = (await json<{ to?: unknown } | null>(req)) ?? {};
      if (input.to !== undefined && (typeof input.to !== 'string' || !isAbsolute(input.to))) throw new HttpError(400, 'Send { to } as an absolute path, or nothing.');
      const source = join(folder.projects, id);
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(id) || !(await stat(join(source, 'project.json')).catch(() => null))) throw new HttpError(404, `No film "${id}" in projects/.`);
      let to = typeof input.to === 'string' ? input.to : join(dirname(folder.root), id);
      if (input.to === undefined) for (let n = 2; await stat(to).catch(() => null); n++) to = join(dirname(folder.root), `${id}-${n}`);
      await convertFilm(source, to, folder.root).catch((err: unknown) => {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      });
      return send(res, 201, { path: to });
    }
    if (req.method === 'POST' && path === '/compositions') {
      const input = await json<NewComposition>(req);
      const problem = checkNewComposition(input);
      if (problem) throw new HttpError(400, problem);
      return send(res, 201, await created(() => ws().then((w) => w.createComposition(input))));
    }

    // The request queue (ADR 0003, ADR 0006).
    if (req.method === 'GET' && path === '/queue') return send(res, 200, { requests: shownThreads(await queue.list()) });
    if (req.method === 'GET' && path === '/agents') {
      const off = agentsOff();
      return send(res, 200, { agents: [EXTERNAL, ...(await runner.statuses(url.searchParams.has('fresh')))], ...(off ? { agentsOff: off } : {}) });
    }
    if (req.method === 'GET' && path === '/selection') return send(res, 200, { selection: await queue.readSelection() });
    if (req.method === 'PUT' && path === '/selection') {
      const selection = await json<Omit<CurrentSelection, 'updatedAt'> | null>(req);
      if (selection !== null) {
        // The same checks as a request's selection, frame and point, with a stand-in prompt.
        const problem = checkNewRequest({ selection: { sceneId: selection.sceneId, layerId: selection.layerId, partId: selection.partId, from: selection.from, to: selection.to }, frame: selection.frame, point: selection.point, prompt: '-', references: [] });
        if (problem) throw new HttpError(400, problem);
      }
      await queue.writeSelection(selection);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/requests') {
      const input = await json<NewRequest>(req);
      const problem = checkNewRequest(input);
      if (problem) throw new HttpError(400, problem);
      needAgents(input.agent);
      const request = await queue.create(input);
      runner.allow(request);
      return send(res, 201, { request });
    }
    if (req.method === 'POST' && path === '/requests/clear') return send(res, 200, { removed: await queue.clearFinished() });
    const id = parts[0] === 'requests' && parts.length >= 3 ? Number(parts[1]) : NaN;
    if (parts[0] === 'requests' && parts.length >= 3 && !Number.isInteger(id)) throw new HttpError(400, `Bad request id ${JSON.stringify(parts[1])}.`);
    // A turn's saved events, and the frames its agent rendered.
    if (req.method === 'GET' && Number.isInteger(id) && parts[2] === 'turns' && parts.length >= 5) {
      const turn = Number(parts[3]);
      if (!Number.isInteger(turn) || turn < 0) throw new HttpError(400, `Bad turn ${JSON.stringify(parts[3])}.`);
      const dir = queue.threadDir(id);
      if (parts[4] === 'events' && parts.length === 5) return send(res, 200, { events: await readTurnEvents(join(dir, `turn-${turn}.jsonl`)) });
      if (parts[4] === 'frames' && parts.length === 6 && FRAME_FILE.test(parts[5])) {
        const data = await readFile(join(dir, `turn-${turn}`, parts[5])).catch(() => null);
        if (!data) throw new HttpError(404, 'No such frame.');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        return void res.end(data);
      }
    }
    if (req.method === 'POST' && Number.isInteger(id) && parts.length === 3) {
      const action = parts[2];
      if (action === 'reply') {
        const input = await json<Reply>(req);
        const problem = checkNewRequest(input, { reply: true });
        if (problem) throw new HttpError(400, problem);
        needAgents((await queue.get(id)).agent);
        const request = await queue.reply(id, input);
        runner.allow(request);
        return send(res, 201, { request });
      }
      if (action === 'settle') return send(res, 200, { request: await queue.settle(id) });
      if (action === 'start') {
        // A click on a turn found on disk (ADR 0017). Access is the click's: the file's never counts.
        const input = await json<{ settings?: TurnSettings } | null>(req);
        const settings = input?.settings ?? { access: 'studio' as const };
        const problem = checkSettings(settings);
        if (problem) throw new HttpError(400, problem);
        const { agent } = await queue.get(id);
        needAgents(agent);
        if (!runner.runs(agent)) throw new HttpError(409, `No agent here can work request #${id}.`);
        const request = await queue.startHeld(id, settings).catch((err: unknown) => {
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        });
        runner.allow(request);
        return send(res, 200, { request });
      }
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
        needAgents((await queue.get(id)).agent);
        const request = await queue.retry(id, input?.prompt, {
          ...(input?.references ? { references: input.references } : {}),
          ...(input?.settings ? { settings: input.settings } : {}),
        });
        runner.allow(request);
        return send(res, 201, { request });
      }
    }
    if (req.method === 'POST' && Number.isInteger(id) && parts[2] === 'approvals' && parts.length === 4) {
      const input = await json<{ decision?: unknown } | null>(req);
      const decision = input?.decision;
      if (decision !== 'accept' && decision !== 'decline') throw new HttpError(400, 'decision must be "accept" or "decline"');
      if (!runner.respond(id, parts[3], decision as ApprovalDecision)) throw new HttpError(409, 'That approval is no longer open.');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && Number.isInteger(id) && parts[2] === 'questions' && parts.length === 4) {
      // A question card's answers, by question id, or { answers: null } to skip it (ADR 0011).
      const input = await json<{ answers?: unknown } | null>(req);
      const answers = input?.answers;
      if (answers !== null && (typeof answers !== 'object' || answers === undefined)) throw new HttpError(400, 'answers must be an object of question id to answers, or null to skip');
      let open: boolean;
      try {
        open = runner.answer(id, parts[3], answers as QuestionAnswers | null);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      if (!open) throw new HttpError(409, 'Those questions are no longer open.');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/references') {
      const name = url.searchParams.get('name') ?? 'reference';
      const saved = await saveReference(folder, name, String(req.headers['content-type'] ?? ''), await body(req, MAX_REFERENCE_BYTES));
      return send(res, 201, { path: saved });
    }
    throw new HttpError(404, `No studio route ${req.method} ${url.pathname}.`);
  }

  http.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://studio');
    const handle = async () => {
      if (url.pathname === '/__studio' || url.pathname.startsWith('/__studio/')) return studio(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'The viewer takes GET only.');
      checkLocal(req);
      if (options.viewer.kind === 'vite') {
        // Only what the viewer's code needs: the pages, src/, and Vite's own paths. The rest of the repo,
        // .frame-studio/ and its tokens above all, isn't Vite's to serve.
        const allowed = /^\/(index\.html|render\.html|favicon\.ico|boot-guard\.js)?$/.test(url.pathname) || /^\/(src|node_modules|@vite|@id|@fs|__vite)/.test(url.pathname);
        if (!allowed || url.pathname.split('/').some((part) => part.startsWith('.') && part !== '.vite')) throw new HttpError(404, 'Not found.');
        if (!vite) throw new HttpError(503, 'The viewer is still starting.');
      }
      if (vite) return new Promise<void>((done) => vite!.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end();
        done();
      }));
      return serveStatic(req, res, url.pathname);
    };
    handle().catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`${req.method} ${url.pathname}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  pool = new RenderPool(null, () => generation);
  // Vite first, so no page request arrives before it can answer.
  if (options.viewer.kind === 'vite') {
    const { createServer: createVite } = await import('vite');
    const { REPO } = await import('./folder.ts');
    const hmr = options.viewer.hmr !== false;
    vite = await createVite({
      root: REPO,
      configFile: join(REPO, 'vite.config.ts'),
      logLevel: 'error',
      appType: 'mpa',
      server: {
        middlewareMode: true,
        // Hot reload over this server's own port; without it, no socket at all, where Vite would open one on every interface.
        ...(hmr ? { hmr: { server: http } } : { hmr: false, ws: false, watch: null }),
        fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.frame-studio/**'] },
      },
    });
  }
  const port = await listen(http, options.port ?? DEFAULT_PORT);
  url = `http://127.0.0.1:${port}`;
  pairing.setPort(port);
  if (options.worker === 'electron') pool.setLauncher(electronWorker(url, options.token, log));

  const discovery = join(folder.studio, 'server.json');
  if (options.discovery) {
    // Readable only by you from the start: it holds the token.
    await writeFileAtomic(discovery, `${JSON.stringify({ url, token: options.token, pid: process.pid, folder: folder.root }, null, 2)}\n`, 0o600);
  }
  if (agents) runner.start().catch((err: unknown) => log(`agent runner: ${err instanceof Error ? err.message : String(err)}`));

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    token: options.token,
    folder,
    get pool() {
      return pool;
    },
    code,
    queue,
    workspace: ws,
    touch,
    close() {
      closing ??= (async () => {
        if (changeTimer) clearTimeout(changeTimer);
        if (queueTimer) clearTimeout(queueTimer);
        for (const w of watchers) w.close();
        for (const abort of [...exports.values(), ...checks.values()]) abort.abort();
        thumbs.close();
        await runner.dispose();
        await (await workspace?.catch(() => null))?.close();
        await pool.close();
        events.close();
        await vite?.close();
        if (options.discovery) {
          // Only our own: another server may have taken over the folder since.
          const text = await readFile(discovery, 'utf8').catch(() => '');
          if (text.includes(`"pid": ${process.pid},`) && text.includes(url)) await rm(discovery, { force: true });
        }
        await new Promise<void>((done) => {
          http.close(() => done());
          http.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}

/** Saves an uploaded image as references/<date>-<slug>.<ext>, numbering it if the name is taken. Returns the folder-relative path. */
async function saveReference(folder: StudioFolder, name: string, type: string, data: Buffer): Promise<string> {
  const ext = REFERENCE_TYPES[type];
  if (!ext) throw new HttpError(415, 'References must be PNG, JPEG or WebP images.');
  if (data.length === 0) throw new HttpError(400, 'The image is empty.');
  await mkdir(folder.references, { recursive: true });
  const stem = `${new Date().toISOString().slice(0, 10)}-${slug(name)}`;
  for (let n = 1; ; n++) {
    const file = `${stem}${n === 1 ? '' : `-${n}`}${ext}`;
    const path = join(folder.references, file);
    try {
      await stat(path);
    } catch {
      await writeFileAtomic(path, data);
      return `references/${file}`;
    }
  }
}
