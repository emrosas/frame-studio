// Claude, through Anthropic's Agent SDK, pointed at the user's own installed
// and signed-in `claude` (ADR 0006). The studio never offers a login and never
// sees a token: sign-in stays in the CLI, and an API key in the user's
// environment works the same way. One query per turn, resuming the thread's
// session. The studio tools run in this process as an SDK MCP server, so no
// token goes on the command line; every other tool the model wants goes
// through canUseTool, which asks the access rules. Node only.

import { relative } from 'node:path';
import { query, type CanUseTool, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentQuestion, TurnUsage } from '../../../src/studio/protocol.ts';
import { agentEnv, findExecutable, run } from './exec.ts';
import type { Action, AgentProvider, TurnCallbacks, TurnHandle, TurnInput, TurnOutcome } from './types.ts';

const MODELS = [
  { id: 'default', label: 'Default model' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The studio's MCP server name, so its tools are mcp__frame-studio__<tool>. */
const STUDIO = 'frame-studio';

/** Tools that only read, as the access rules see them. */
const READERS: Record<string, (input: Record<string, unknown>) => unknown> = {
  Read: (i) => i.file_path,
  Glob: (i) => i.path,
  Grep: (i) => i.path,
  LS: (i) => i.path,
  NotebookRead: (i) => i.notebook_path,
};
const WRITERS: Record<string, (input: Record<string, unknown>) => unknown> = {
  Write: (i) => i.file_path,
  Edit: (i) => i.file_path,
  MultiEdit: (i) => i.file_path,
  NotebookEdit: (i) => i.notebook_path,
};
/** Tools that need no say from the access rules: planning, subagents (whose own tools still ask), background shells a command started. */
const FREE = new Set(['TodoWrite', 'Task', 'Agent', 'BashOutput', 'KillShell', 'KillBash', 'ExitPlanMode', 'ToolSearch']);

/** What a tool call wants to do, for the access rules; null when nothing needs asking. */
export function claudeAction(tool: string, input: Record<string, unknown>, cwd: string): Action | null {
  if (tool.startsWith(`mcp__${STUDIO}__`) || FREE.has(tool)) return null;
  const read = READERS[tool]?.(input);
  if (tool in READERS) return { kind: 'read', path: typeof read === 'string' ? read : cwd };
  const written = WRITERS[tool]?.(input);
  if (tool in WRITERS) return { kind: 'write', paths: [typeof written === 'string' ? written : cwd] };
  if (tool === 'Bash') return { kind: 'command', command: String(input.command ?? '') };
  if (tool === 'WebFetch') return { kind: 'network', target: String(input.url ?? '') };
  if (tool === 'WebSearch') return { kind: 'network', target: `search "${String(input.query ?? '')}"` };
  return { kind: 'tool', name: tool, detail: JSON.stringify(input).slice(0, 300) };
}

/** A short line for a tool call in the transcript. */
export function claudeStepLabel(tool: string, input: Record<string, unknown>, cwd: string): string {
  const path = (v: unknown) => (typeof v === 'string' ? relative(cwd, v) || v : '');
  if (tool.startsWith(`mcp__${STUDIO}__`)) return `Studio: ${tool.slice(`mcp__${STUDIO}__`.length)}`;
  if (tool in READERS) return `Read ${path(READERS[tool](input)) || String(input.pattern ?? '')}`.trim();
  if (tool in WRITERS) return `Edit ${path(WRITERS[tool](input))}`;
  if (tool === 'Bash') return `Run ${String(input.command ?? '').split('\n')[0].slice(0, 120)}`;
  if (tool === 'WebFetch') return `Fetch ${String(input.url ?? '')}`;
  if (tool === 'WebSearch') return `Search the web for "${String(input.query ?? '')}"`;
  if (tool === 'Task' || tool === 'Agent') return `Subagent: ${String(input.description ?? '')}`;
  if (tool === 'TodoWrite') return 'Update the plan';
  if (tool === 'ToolSearch') return 'Look up tools';
  return tool;
}

/** The last line of the reply, which the instructions ask to be a one-line summary. */
export function summaryOf(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.length > 300 ? `${last.slice(0, 297)}…` : last;
}

export function claudeProvider(): AgentProvider {
  return {
    id: 'claude',
    label: 'Claude',
    async status() {
      const base = { models: MODELS, efforts: EFFORTS };
      const bin = await findExecutable('claude');
      if (!bin) return { ...base, ready: false, detail: 'the claude command is not installed', fix: 'npm install -g @anthropic-ai/claude-code' };
      try {
        const out = await run(bin, ['auth', 'status']);
        const status = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { loggedIn?: boolean; authMethod?: string };
        if (!status.loggedIn) return { ...base, ready: false, detail: 'claude is not signed in', fix: 'claude auth login' };
        return { ...base, ready: true, detail: status.authMethod === 'claude.ai' ? 'Signed in with your Claude account' : 'Signed in' };
      } catch (err) {
        return { ...base, ready: false, detail: `claude auth status failed: ${err instanceof Error ? err.message : String(err)}`, fix: 'claude auth login' };
      }
    },
    startTurn(input, cb) {
      const abort = new AbortController();
      let stopping = false;
      const done = runTurn(input, cb, abort).catch((err): TurnOutcome => {
        if (stopping || abort.signal.aborted) return { status: 'stopped', summary: '' };
        return { status: 'failed', summary: err instanceof Error ? err.message : String(err) };
      });
      const handle: TurnHandle = {
        done,
        stop: async () => {
          stopping = true;
          abort.abort();
        },
      };
      return handle;
    },
  };
}

/**
 * Claude's own AskUserQuestion, shown as the studio's question card (ADR 0011). The answers go back in the
 * tool's input, keyed by question text, multi-select answers joined with commas, which is how the tool
 * reports them to the model.
 */
async function askUser(toolInput: Record<string, unknown>, cb: TurnCallbacks): Promise<PermissionResult> {
  const raw = Array.isArray(toolInput.questions) ? (toolInput.questions as Record<string, unknown>[]) : [];
  const questions: AgentQuestion[] = raw.map((q, i) => ({
    id: String(i),
    header: String(q.header ?? ''),
    question: String(q.question ?? ''),
    options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map((o) => ({
      label: String(o.label ?? ''),
      ...(typeof o.description === 'string' ? { description: o.description } : {}),
      ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
    })),
    ...(q.multiSelect === true ? { multiSelect: true } : {}),
  }));
  const answers = await cb.ask(questions);
  if (!answers) return { behavior: 'deny', message: "The user didn't answer. Carry on with your best judgement and say what you chose, or end your turn and ask in your reply." };
  return { behavior: 'allow', updatedInput: { ...toolInput, answers: Object.fromEntries(questions.map((q) => [q.question, (answers[q.id] ?? []).join(', ')])) } };
}

async function runTurn(input: TurnInput, cb: TurnCallbacks, abort: AbortController): Promise<TurnOutcome> {
  const bin = await findExecutable('claude');
  if (!bin) throw new Error('The claude command is not installed.');
  const { cwd, settings } = input;
  const canUseTool: CanUseTool = async (tool, toolInput) => {
    if (tool === 'AskUserQuestion') return askUser(toolInput, cb);
    const action = claudeAction(tool, toolInput, cwd);
    if (!action || (await cb.decide(action))) return { behavior: 'allow', updatedInput: toolInput };
    return { behavior: 'deny', message: 'The user did not allow this. Carry on without it, or explain in your reply what you need.' };
  };

  const q = query({
    prompt: input.prompt,
    options: {
      pathToClaudeCodeExecutable: bin,
      cwd,
      env: agentEnv(),
      abortController: abort,
      ...(input.session ? { resume: input.session } : {}),
      ...(settings.model && settings.model !== 'default' ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      // No user or project settings: their hooks and permission rules must not bypass the studio's access rules.
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: input.instructions },
      permissionMode: 'default',
      // The studio tools are allowed through canUseTool too (claudeAction), rather than allowedTools, which would skip it.
      canUseTool,
      // Renders and exports can take minutes, so tool calls get ten. Only the studio's tools: none from the user's config.
      mcpServers: { [STUDIO]: { type: 'sdk', name: STUDIO, instance: input.mcp.server(), timeout: 10 * 60 * 1000 } },
      strictMcpConfig: true,
      includePartialMessages: true,
    },
  });

  let text = '';
  let billed = true;
  const steps = new Map<string, string>();
  let outcome: TurnOutcome | null = null;
  for await (const message of q as AsyncIterable<SDKMessage>) {
    if ('session_id' in message && message.session_id) cb.session(message.session_id);
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') billed = message.apiKeySource !== 'none';
        break;
      case 'stream_event': {
        if (message.parent_tool_use_id) break;
        const e = message.event as { type: string; delta?: { type: string; text?: string } };
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          text += e.delta.text;
          cb.emit({ type: 'text', text: e.delta.text });
        }
        if (e.type === 'message_start' && text && !text.endsWith('\n')) {
          text += '\n';
          cb.emit({ type: 'text', text: '\n' });
        }
        break;
      }
      case 'assistant':
        for (const block of message.message.content as { type: string; id?: string; name?: string; input?: Record<string, unknown> }[]) {
          if (block.type !== 'tool_use' || !block.id || !block.name) continue;
          const label = claudeStepLabel(block.name, block.input ?? {}, cwd);
          steps.set(block.id, label);
          cb.emit({ type: 'step', id: block.id, label, status: 'running' });
        }
        break;
      case 'user': {
        const content = (message.message as { content?: unknown }).content;
        if (!Array.isArray(content)) break;
        for (const block of content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id || !steps.has(block.tool_use_id)) continue;
          const detail = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          cb.emit({ type: 'step', id: block.tool_use_id, label: steps.get(block.tool_use_id)!, status: block.is_error ? 'failed' : 'done', detail: detail.slice(0, 500) });
        }
        break;
      }
      case 'result': {
        const usage: TurnUsage = {
          inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
          outputTokens: message.usage.output_tokens,
          // With a Claude account the SDK's cost is only an estimate of plan usage, so it is shown for API keys only.
          ...(billed ? { costUsd: message.total_cost_usd } : {}),
        };
        const reply = message.subtype === 'success' ? message.result : text;
        const failed = message.is_error || message.subtype !== 'success';
        outcome = {
          status: failed ? 'failed' : 'done',
          summary: summaryOf(reply) || (failed ? `Claude stopped: ${message.subtype.replace(/_/g, ' ')}` : ''),
          usage,
        };
        break;
      }
    }
  }
  if (abort.signal.aborted) return { status: 'stopped', summary: summaryOf(text), ...(outcome?.usage ? { usage: outcome.usage } : {}) };
  return outcome ?? { status: 'failed', summary: 'Claude ended the turn without a result.' };
}
