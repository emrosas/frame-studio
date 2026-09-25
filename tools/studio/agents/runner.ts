// Runs the agents that live inside the studio server (ADR 0006). It claims
// threads meant for them from the queue, one working thread per scene, and
// works each turn through a provider: it builds the prompt, hands the
// provider the studio tools over HTTP, logs and pushes everything the turn
// does, asks the user through approval cards when the access rules say so,
// and writes the outcome back to the queue. The queue files stay the source
// of truth; this only holds what can't be in a file: live processes and
// open approvals. Node only.

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  currentTurn,
  TURN_EVENT,
  type AgentId,
  type AgentStatus,
  type ApprovalDecision,
  type StudioRequest,
  type TurnEvent,
  type TurnEventBody,
  type TurnSettings,
} from '../../../src/studio/protocol.ts';
import type { ToolHooks } from '../../mcp/tools.ts';
import { describeThread, type SceneInfo } from '../describe.ts';
import type { McpEndpoint } from '../mcp-http.ts';
import type { StudioQueue } from '../queue.ts';
import { judge } from './access.ts';
import type { Action, AgentProvider, TurnHandle, TurnOutcome } from './types.ts';

/** Studio tools that write a scene, by the argument that names it. */
const SCENE_WRITERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  update_scene: (a) => a.id,
  apply_to_selection: (a) => (a.selection as { sceneId?: unknown } | undefined)?.sceneId,
};

const STATUS_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
/** How often the runner looks for work even without a queue change, e.g. after an agent signs in. */
const KICK_MS = 30_000;

/** True when the process that made studio session `session` ("studio-<pid>-<time>") is still running. */
function sessionAlive(session: string): boolean {
  const pid = Number(/^studio-(\d+)-/.exec(session)?.[1]);
  if (!Number.isInteger(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RunnerOptions {
  queue: StudioQueue;
  providers: readonly AgentProvider[];
  root: string;
  endpoint: McpEndpoint;
  /** The studio tools' URL, or null until the server is listening. */
  mcpUrl: () => string | null;
  /** Sends an event to every open viewer. */
  push: (event: string, data: unknown) => void;
  /** Standing instructions for every turn. */
  instructions: () => Promise<string>;
  /** What the viewer's library knows about a scene: its file, timecodes, and the base rig ids it draws with. */
  sceneInfo: (sceneId: string) => Promise<SceneInfo & { rigs?: string[] }>;
}

/** A turn's events on disk (NNNN/turn-K.jsonl) and on the way to the viewer. Text deltas are joined for up to 80 ms. */
export class TurnLog {
  readonly file: string;
  readonly framesDir: string;
  private seq = 0;
  private writes: Promise<void> = Promise.resolve();
  private text = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onEvent: (event: TurnEvent) => void;

  constructor(threadDir: string, turn: number, onEvent: (event: TurnEvent) => void) {
    this.file = join(threadDir, `turn-${turn}.jsonl`);
    this.framesDir = join(threadDir, `turn-${turn}`);
    this.onEvent = onEvent;
  }

  /** Picks up numbering after events an earlier process wrote for the same turn. */
  async resume(): Promise<void> {
    this.seq = (await readTurnEvents(this.file)).reduce((max, e) => Math.max(max, e.seq), 0);
  }

  append(body: TurnEventBody): void {
    if (body.type === 'text') {
      this.text += body.text;
      this.timer ??= setTimeout(() => this.flushText(), 80);
      return;
    }
    this.flushText();
    this.write(body);
  }

  private flushText(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.text) return;
    const text = this.text;
    this.text = '';
    this.write({ type: 'text', text });
  }

  private write(body: TurnEventBody): void {
    const event = { ...body, seq: ++this.seq, at: new Date().toISOString() } as TurnEvent;
    this.onEvent(event);
    this.writes = this.writes.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(event)}\n`);
    });
  }

  /** Waits for everything appended so far to reach the disk. */
  async flush(): Promise<void> {
    this.flushText();
    await this.writes.catch(() => {});
  }
}

/** A turn's events as saved, in order. A missing log is an empty one. */
export async function readTurnEvents(file: string): Promise<TurnEvent[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: TurnEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TurnEvent);
    } catch {
      // A line cut short by a crash.
    }
  }
  return out;
}

interface Running {
  thread: number;
  turn: number;
  handle: TurnHandle | null;
  token: string;
  log: TurnLog;
  approvals: Map<string, (decision: ApprovalDecision) => void>;
  stopping: boolean;
  /** Stopped because the studio server is closing, not by the user. */
  interrupted: boolean;
  /** The turn is over; tool calls still queued must not run. */
  ended: boolean;
}

export class AgentRunner {
  /** Claims made by this process; a claim by any other studio process is from before a restart. */
  readonly session = `studio-${process.pid}-${Date.now().toString(36)}`;
  private readonly options: RunnerOptions;
  private readonly providers: Map<AgentId, AgentProvider>;
  private readonly running = new Map<number, Running>();
  private readonly statusCache = new Map<AgentId, { at: number; status: AgentStatus }>();
  private ticking: Promise<void> | null = null;
  private again = false;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly refreshing = new Map<AgentId, Promise<AgentStatus>>();

  constructor(options: RunnerOptions) {
    this.options = options;
    this.providers = new Map(options.providers.map((p) => [p.id, p]));
  }

  /**
   * Marks turns an earlier studio server left working as interrupted, clears claims a crash left
   * behind, then starts taking threads. A turn another studio server that is still running holds is
   * left alone.
   */
  async start(): Promise<void> {
    await this.options.queue.clearOrphanClaims().catch(() => {});
    for (const thread of await this.options.queue.list()) {
      const turn = currentTurn(thread);
      if (thread.status !== 'working' || thread.agent === 'external' || !turn.claimedBy?.startsWith('studio-') || turn.claimedBy === this.session) continue;
      if (sessionAlive(turn.claimedBy)) continue;
      const k = thread.turns.length - 1;
      const log = new TurnLog(this.options.queue.threadDir(thread.id), k, (e) => this.pushEvent(thread.id, k, e));
      await log.resume();
      log.append({ type: 'status', message: 'The studio server stopped during this turn.' });
      await log.flush();
      await this.options.queue.endTurn(thread.id, 'interrupted', undefined, {}, { session: turn.claimedBy, turn: k }).catch(() => {});
    }
    this.timer = setInterval(() => this.kick(), KICK_MS);
    this.timer.unref?.();
    this.kick();
  }

  /**
   * Every provider's status. A cached status is returned at once, and one older than a minute is
   * checked again in the background; `fresh` waits for a new check.
   */
  async statuses(fresh = false): Promise<AgentStatus[]> {
    return Promise.all([...this.providers.values()].map((p) => this.status(p, fresh)));
  }

  private async status(provider: AgentProvider, fresh = false): Promise<AgentStatus> {
    const cached = this.statusCache.get(provider.id);
    if (!fresh && cached) {
      if (Date.now() - cached.at >= STATUS_TTL_MS) void this.check(provider);
      return cached.status;
    }
    return this.check(provider);
  }

  /** Asks a provider for its status, at most once at a time, giving up after 20 s. */
  private check(provider: AgentProvider): Promise<AgentStatus> {
    const running = this.refreshing.get(provider.id);
    if (running) return running;
    const failed = (detail: string): AgentStatus => ({ id: provider.id, label: provider.label, ready: false, detail, models: [], efforts: [] });
    const timeout = new Promise<AgentStatus>((resolve) => setTimeout(() => resolve(failed('checking it took too long')), STATUS_TIMEOUT_MS).unref?.());
    const work = Promise.race([
      provider.status().then(
        (s): AgentStatus => ({ id: provider.id, label: provider.label, ...s }),
        (err: unknown) => failed(err instanceof Error ? err.message : String(err)),
      ),
      timeout,
    ]).then((status) => {
      const was = this.statusCache.get(provider.id)?.status.ready;
      this.statusCache.set(provider.id, { at: Date.now(), status });
      this.refreshing.delete(provider.id);
      // An agent that just became ready may have threads waiting for it.
      if (status.ready && was === false) this.kick();
      return status;
    });
    this.refreshing.set(provider.id, work);
    return work;
  }

  /** Looks for threads to start. Cheap to call on every queue change; calls while a look is running are folded into one more. */
  kick(): void {
    if (this.disposed) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = this.tick()
      .catch((err) => console.error('[frame-studio] agent runner:', err))
      .finally(() => {
        this.ticking = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  private async tick(): Promise<void> {
    if (this.options.mcpUrl() === null) return;
    const waiting = (await this.options.queue.list()).filter((r) => r.status === 'pending' && this.providers.has(r.agent));
    if (waiting.length === 0) return;
    const ready: AgentId[] = [];
    for (const id of new Set(waiting.map((r) => r.agent))) {
      if ((await this.status(this.providers.get(id)!)).ready) ready.push(id);
    }
    for (;;) {
      const claimed = await this.options.queue.claimNext(this.session, ready);
      if (!claimed) return;
      void this.run(claimed);
    }
  }

  private pushEvent(id: number, turn: number, event: TurnEvent): void {
    this.options.push(TURN_EVENT, { id, turn, event });
  }

  private async run(thread: StudioRequest): Promise<void> {
    const { queue } = this.options;
    const k = thread.turns.length - 1;
    const turn = thread.turns[k];
    const settings: TurnSettings = turn.settings ?? { access: 'studio' };
    const log = new TurnLog(queue.threadDir(thread.id), k, (e) => this.pushEvent(thread.id, k, e));
    await log.resume();
    const provider = this.providers.get(thread.agent)!;
    const running: Running = { thread: thread.id, turn: k, handle: null, token: '', log, approvals: new Map(), stopping: false, interrupted: false, ended: false };
    const hooks = this.toolHooks(thread, settings, running);
    running.token = this.options.endpoint.issue(hooks);
    this.running.set(thread.id, running);

    let outcome: TurnOutcome;
    try {
      const url = this.options.mcpUrl();
      if (!url) throw new Error('The studio server is not listening yet.');
      const info = await this.options.sceneInfo(thread.sceneId);
      if (thread.session) log.append({ type: 'status', message: `Resuming the ${provider.label} session` });
      const handle = provider.startTurn(
        {
          thread,
          // The whole thread even when resuming: the session doesn't know what the user reverted since.
          prompt: describeThread(thread, info, { agent: 'studio' }),
          instructions: await this.options.instructions(),
          settings,
          ...(thread.session ? { session: thread.session } : {}),
          cwd: this.options.root,
          mcp: { url, token: running.token, server: () => this.options.endpoint.server(hooks) },
        },
        {
          emit: (event) => log.append(event),
          decide: (action) => this.decide(thread, settings, running, action),
          session: (id) => void queue.setSession(thread.id, id).catch(() => {}),
        },
      );
      running.handle = handle;
      if (running.stopping) void handle.stop();
      outcome = await handle.done;
    } catch (err) {
      outcome = { status: 'failed', summary: err instanceof Error ? err.message : String(err) };
      log.append({ type: 'error', message: outcome.summary });
    } finally {
      running.ended = true;
      this.options.endpoint.revoke(running.token);
      for (const resolve of running.approvals.values()) resolve('decline');
      if (this.running.get(thread.id) === running) this.running.delete(thread.id);
    }
    if (outcome.usage) log.append({ type: 'usage', usage: outcome.usage });
    await log.flush();
    const extra = outcome.usage ? { usage: outcome.usage } : {};
    // Only this run's own turn: if the user cancelled and a newer turn started, that one isn't ours to end.
    const owner = { session: this.session, turn: k };
    try {
      if (running.interrupted) await queue.endTurn(thread.id, 'interrupted', outcome.summary || undefined, extra, owner);
      else if (outcome.status === 'stopped' || running.stopping) await queue.endTurn(thread.id, 'stopped', outcome.summary || undefined, extra, owner);
      else await queue.complete(thread.id, outcome.status, outcome.summary.trim() || (outcome.status === 'done' ? 'Done.' : 'The agent stopped without saying why.'), extra, owner);
    } catch {
      // The turn was cancelled from the viewer while it ran; the queue already says so.
    }
    this.kick();
  }

  /** The studio tools' hooks for one turn: access rules for writes to other scenes, and frame thumbnails. */
  private toolHooks(thread: StudioRequest, settings: TurnSettings, running: Running): ToolHooks {
    let frames = 0;
    // Unique per run, so a requeued turn's thumbnails never reuse (cached) names.
    const run = Date.now().toString(36);
    return {
      active: () => !running.ended && !running.stopping,
      before: async (name, args) => {
        const sceneId = SCENE_WRITERS[name]?.(args);
        if (typeof sceneId !== 'string' || sceneId === thread.sceneId) return;
        if (!(await this.decide(thread, settings, running, { kind: 'scene', sceneId, tool: name }))) {
          throw new Error(`Not allowed: this request is about scene "${thread.sceneId}", and changing "${sceneId}" was declined.`);
        }
      },
      after: async (name, _args, result) => {
        if (name !== 'render_frame' || result.isError) return;
        const image = result.content.find((c) => c.type === 'image');
        const caption = result.content.find((c) => c.type === 'text');
        if (!image || image.type !== 'image') return;
        const frame = Number(/frame (\d+)/.exec(caption && caption.type === 'text' ? caption.text : '')?.[1] ?? NaN);
        const file = `frame-${run}-${String(++frames).padStart(3, '0')}.png`;
        await mkdir(running.log.framesDir, { recursive: true });
        await writeFile(join(running.log.framesDir, file), Buffer.from(image.data, 'base64'));
        running.log.append({ type: 'frame', file, sceneId: thread.sceneId, frame: Number.isFinite(frame) ? frame : -1 });
      },
    };
  }

  /** The access rules, then the user through an approval card when they say to ask. */
  private async decide(thread: StudioRequest, settings: TurnSettings, running: Running, action: Action): Promise<boolean> {
    if (running.stopping) return false;
    const all = await this.options.queue.list();
    const busyScenes = [...new Set(all.filter((r) => r.id !== thread.id && r.status === 'working').map((r) => r.sceneId))];
    const busyRigs: string[] = [];
    for (const sceneId of busyScenes) busyRigs.push(...((await this.options.sceneInfo(sceneId).catch(() => ({}) as { rigs?: string[] })).rigs ?? []));
    const verdict = judge(action, { access: settings.access, root: this.options.root, sceneId: thread.sceneId, busyScenes, busyRigs: [...new Set(busyRigs)] });
    if (verdict.allow) return true;
    if (!verdict.ask) {
      running.log.append({ type: 'status', message: verdict.reason });
      return false;
    }
    const id = randomBytes(6).toString('hex');
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      running.approvals.set(id, resolve);
      running.log.append({ type: 'approval', id, kind: action.kind, summary: verdict.summary, ...(verdict.detail ? { detail: verdict.detail } : {}) });
    });
    running.approvals.delete(id);
    running.log.append({ type: 'approval-resolved', id, decision });
    return decision === 'accept';
  }

  /** The user's answer to an approval card. False when there is no such open card. */
  respond(thread: number, approval: string, decision: ApprovalDecision): boolean {
    const resolve = this.running.get(thread)?.approvals.get(approval);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  /** True while this process runs a turn of the thread. */
  isRunning(thread: number): boolean {
    return this.running.has(thread);
  }

  /** Stops a thread's working turn, keeping its edits. Open approvals are declined. */
  async stop(thread: number): Promise<boolean> {
    const running = this.running.get(thread);
    if (!running) return false;
    running.stopping = true;
    for (const resolve of running.approvals.values()) resolve('decline');
    await running.handle?.stop();
    return true;
  }

  /** Stops every turn, e.g. when the dev server closes. Their threads show as interrupted after a restart. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const running of this.running.values()) {
      running.interrupted = true;
      running.log.append({ type: 'status', message: 'The studio server stopped during this turn.' });
    }
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}
