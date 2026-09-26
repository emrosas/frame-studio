// Codex, through the user's own installed and signed-in `codex app-server`
// (ADR 0006), speaking its JSON-RPC over stdio. Codex owns sign-in; the studio
// only reads whether it is signed in. Each turn starts an app-server with the
// studio tools configured as an MCP server, starts or resumes the thread's
// Codex thread, and answers Codex's approval requests through the access
// rules. Written against codex-cli 0.156 (`codex app-server generate-ts`);
// the protocol is marked experimental, so pin and re-check on upgrades.
// Node only.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { TurnUsage } from '../../../src/studio/protocol.ts';
import { summaryOf } from './claude.ts';
import { agentEnv, findExecutable, run } from './exec.ts';
import type { AgentProvider, TurnCallbacks, TurnHandle, TurnInput, TurnOutcome } from './types.ts';

/** The studio tools' server name in Codex, apart from any frame-studio entry in the user's own Codex config. */
const STUDIO = 'frame-studio-agent';
const TOKEN_ENV = 'FRAME_STUDIO_MCP_TOKEN';
const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_TIMEOUT_MS = 15_000;

class Stopped extends Error {
  constructor() {
    super('Stopped');
  }
}

type Json = Record<string, unknown>;

/** A JSON-RPC connection to `codex app-server` over stdio: requests out, and notifications and requests in. */
class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private stderr = '';
  /** Settles when the process exits, with what it said on stderr. */
  readonly exited: Promise<string>;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (method: string, params: Json) => Promise<Json> = async () => ({});

  constructor(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(bin, ['app-server', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    this.exited = new Promise((resolve) => this.child.on('close', () => resolve(this.stderr.trim())));
    void this.exited.then((why) => {
      for (const { reject } of this.pending.values()) reject(new Error(`codex app-server exited${why ? `: ${why}` : ''}`));
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
  }

  private receive(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      const id = msg.id;
      this.onRequest(msg.method, (msg.params ?? {}) as Json).then(
        (result) => this.send({ id, result }),
        (err) => this.send({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }),
      );
    } else if (typeof msg.method === 'string') {
      this.onNotification(msg.method, (msg.params ?? {}) as Json);
    } else if (typeof msg.id === 'number') {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!waiter) return;
      if (msg.error) waiter.reject(new Error(String((msg.error as { message?: unknown }).message ?? 'codex error')));
      else waiter.resolve((msg.result ?? {}) as Json);
    }
  }

  private send(msg: Json): void {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  /** initialize, then initialized, as every client must. */
  async open(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'frame_studio', title: 'Frame Studio', version: '0.1.0' }, capabilities: null });
    this.notify('initialized');
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Codex's sandbox and approval policy for an access mode. */
export function codexPolicy(access: 'studio' | 'full'): { approvalPolicy: string; sandbox: string } {
  // Studio: every file change and every command that isn't known to be safe asks, and the access rules answer.
  return access === 'full' ? { approvalPolicy: 'never', sandbox: 'danger-full-access' } : { approvalPolicy: 'untrusted', sandbox: 'read-only' };
}

export function codexProvider(): AgentProvider {
  let models: { at: number; list: { id: string; label: string }[]; efforts: string[] } | null = null;

  async function listModels(bin: string): Promise<{ list: { id: string; label: string }[]; efforts: string[] }> {
    if (models && Date.now() - models.at < MODELS_TTL_MS) return models;
    const server = new AppServer(bin, [], agentEnv(), process.cwd());
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('codex model/list took too long')), MODELS_TIMEOUT_MS).unref?.());
    try {
      await Promise.race([server.open(), timeout]);
      const { data } = (await Promise.race([server.request('model/list', {}), timeout])) as { data: { id: string; displayName: string; hidden: boolean; isDefault: boolean; supportedReasoningEfforts: { reasoningEffort: string }[] }[] };
      const shown = data.filter((m) => !m.hidden).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      const efforts = (shown.find((m) => m.isDefault) ?? shown[0])?.supportedReasoningEfforts.map((e) => e.reasoningEffort) ?? [];
      models = { at: Date.now(), list: shown.map((m) => ({ id: m.id, label: m.displayName })), efforts };
      return models;
    } finally {
      server.close();
    }
  }

  return {
    id: 'codex',
    label: 'Codex',
    async status() {
      const bin = await findExecutable('codex');
      if (!bin) return { ready: false, detail: 'the codex command is not installed', fix: 'npm install -g @openai/codex', models: [], efforts: [] };
      let detail: string;
      try {
        detail = (await run(bin, ['login', 'status'])).trim();
      } catch (err) {
        return { ready: false, detail: `codex is not signed in (${err instanceof Error ? err.message : String(err)})`, fix: 'codex login', models: [], efforts: [] };
      }
      if (!/logged in/i.test(detail) || /not logged in/i.test(detail)) return { ready: false, detail: 'codex is not signed in', fix: 'codex login', models: [], efforts: [] };
      const { list, efforts } = await listModels(bin).catch(() => ({ list: [], efforts: [] }));
      return { ready: true, detail: detail.replace(/^Logged in using /, 'Signed in with '), models: list, efforts };
    },
    startTurn(input, cb) {
      // Stop works from the first moment: before Codex starts, during setup, and mid-turn.
      const abort = new AbortController();
      const done = runTurn(input, cb, abort.signal).catch((err): TurnOutcome => {
        if (abort.signal.aborted || err instanceof Stopped) return { status: 'stopped', summary: '' };
        return { status: 'failed', summary: err instanceof Error ? err.message : String(err) };
      });
      const handle: TurnHandle = { done, stop: async () => abort.abort() };
      return handle;
    },
  };
}

interface ItemView {
  type: string;
  id: string;
  command?: string;
  changes?: { path: string }[];
  server?: string;
  tool?: string;
  status?: string;
  text?: string;
  query?: string;
}

async function runTurn(input: TurnInput, cb: TurnCallbacks, signal: AbortSignal): Promise<TurnOutcome> {
  const stopped = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Stopped());
    signal.addEventListener('abort', () => reject(new Stopped()), { once: true });
  });
  stopped.catch(() => {});
  const bin = await findExecutable('codex');
  if (!bin) throw new Error('The codex command is not installed.');
  if (signal.aborted) throw new Stopped();
  const { cwd, settings } = input;
  const server = new AppServer(
    bin,
    ['-c', `mcp_servers.${STUDIO}.url=${JSON.stringify(input.mcp.url)}`, '-c', `mcp_servers.${STUDIO}.bearer_token_env_var=${JSON.stringify(TOKEN_ENV)}`],
    agentEnv({ [TOKEN_ENV]: input.mcp.token }),
    cwd,
  );
  const items = new Map<string, ItemView>();
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0 };
  let text = '';
  let threadId = '';
  let turnId = '';
  let finish: (outcome: TurnOutcome) => void = () => {};
  const finished = new Promise<TurnOutcome>((resolve) => (finish = resolve));

  const label = (item: ItemView): string | null => {
    switch (item.type) {
      case 'commandExecution':
        return `Run ${(item.command ?? '').split('\n')[0].slice(0, 120)}`;
      case 'fileChange':
        return `Edit ${(item.changes ?? []).map((c) => relative(cwd, c.path) || c.path).join(', ')}`;
      case 'mcpToolCall':
        return item.server === STUDIO ? `Studio: ${item.tool}` : `${item.server}: ${item.tool}`;
      case 'webSearch':
        return `Search the web${item.query ? ` for "${item.query}"` : ''}`;
      default:
        return null;
    }
  };

  server.onNotification = (method, params) => {
    if (method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      text += delta;
      cb.emit({ type: 'text', text: delta });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as ItemView;
      items.set(item.id, item);
      if (item.type === 'agentMessage' && method === 'item/started' && text && !text.endsWith('\n')) {
        text += '\n';
        cb.emit({ type: 'text', text: '\n' });
      }
      const line = label(item);
      if (!line) return;
      const failed = item.status === 'failed' || item.status === 'declined';
      cb.emit({ type: 'step', id: item.id, label: line, status: method === 'item/started' ? 'running' : failed ? 'failed' : 'done' });
    } else if (method === 'thread/tokenUsage/updated') {
      const last = (params.tokenUsage as { last?: { inputTokens: number; outputTokens: number } }).last;
      if (last) {
        usage.inputTokens! += last.inputTokens;
        usage.outputTokens! += last.outputTokens;
      }
    } else if (method === 'error') {
      const error = params.error as { message?: string } | undefined;
      if (!params.willRetry) cb.emit({ type: 'error', message: error?.message ?? 'Codex reported an error.' });
    } else if (method === 'turn/completed') {
      const turn = params.turn as { status: string; error: { message?: string } | null };
      const status = turn.status === 'completed' ? 'done' : turn.status === 'interrupted' ? 'stopped' : 'failed';
      finish({ status, summary: summaryOf(text) || (turn.error?.message ?? ''), usage });
    }
  };

  server.onRequest = async (method, params) => {
    if (method === 'item/commandExecution/requestApproval') {
      const allowed = await cb.decide({ kind: 'command', command: String(params.command ?? params.reason ?? 'a command') });
      return { decision: allowed ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval') {
      const item = items.get(String(params.itemId));
      const paths = (item?.changes ?? []).map((c) => c.path);
      const allowed = await cb.decide({ kind: 'write', paths: paths.length > 0 ? paths : [String(params.grantRoot ?? cwd)] });
      return { decision: allowed ? 'accept' : 'decline' };
    }
    if (method === 'item/permissions/requestApproval') {
      const allowed = await cb.decide({ kind: 'tool', name: 'more permissions', detail: String(params.reason ?? '') });
      return { permissions: allowed ? params.permissions : {}, scope: 'turn' };
    }
    if (method === 'mcpServer/elicitation/request') {
      // Codex asks before an MCP tool call through an elicitation. The studio's own tools are allowed here,
      // since the studio's tool hooks apply the access rules to them; other servers' tools ask the user.
      const meta = (params._meta ?? {}) as { codex_approval_kind?: string; tool_title?: string };
      if (meta.codex_approval_kind === 'mcp_tool_call') {
        const allowed = params.serverName === STUDIO || (await cb.decide({ kind: 'tool', name: `${String(params.serverName)}: ${meta.tool_title ?? 'a tool'}` }));
        return { action: allowed ? 'accept' : 'decline', content: allowed ? {} : null, _meta: null };
      }
      // Anything else a server asks the user is declined rather than shown half-understood.
      return { action: 'decline', content: null, _meta: null };
    }
    if (method === 'item/tool/requestUserInput') return { answers: {} };
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const command = Array.isArray(params.command) ? (params.command as string[]).join(' ') : '';
      const allowed =
        method === 'execCommandApproval'
          ? await cb.decide({ kind: 'command', command })
          : await cb.decide({ kind: 'write', paths: Object.keys((params.fileChanges as Json | undefined) ?? {}) });
      return { decision: allowed ? 'approved' : { denied: { rejection: 'The user did not allow this.' } } };
    }
    throw new Error(`Frame Studio does not handle ${method}.`);
  };

  // Mid-turn, Stop asks Codex to interrupt, and gives it three seconds to say the turn ended.
  signal.addEventListener(
    'abort',
    () => {
      if (threadId && turnId) void server.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      setTimeout(() => finish({ status: 'stopped', summary: summaryOf(text), usage }), 3000);
    },
    { once: true },
  );
  const exited = server.exited.then((why) => Promise.reject(new Error(`codex app-server stopped${why ? `: ${why}` : ''}`)));
  exited.catch(() => {});
  /** A setup step, which Stop or the app-server exiting cuts short. */
  const step = <T>(p: Promise<T>) => Promise.race([p, stopped, exited]);

  try {
    await step(server.open());
    const policy = codexPolicy(settings.access);
    const model = settings.model ? { model: settings.model } : {};
    const thread = input.session
      ? await step(server.request('thread/resume', { threadId: input.session, cwd, ...policy, ...model, developerInstructions: input.instructions }))
      : await step(server.request('thread/start', { cwd, ...policy, ...model, developerInstructions: input.instructions, serviceName: 'frame_studio' }));
    threadId = String((thread.thread as { id: string }).id);
    cb.session(threadId);
    const started = await step(
      server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        ...(settings.effort ? { effort: settings.effort } : {}),
      }),
    );
    turnId = String((started.turn as { id: string }).id);
    return await Promise.race([finished, exited]);
  } finally {
    server.close();
  }
}
