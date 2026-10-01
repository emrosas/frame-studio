// A scripted agent for tests (ADR 0006): it needs no sign-in and costs
// nothing, but it goes through the same seams as Claude and Codex. It calls
// the real studio tools over the studio server's MCP endpoint, asks the
// access rules before writes and commands, and streams text and steps.
//
// It is only offered when FRAME_STUDIO_FAKE_AGENT=1. Scripts live in
// <studio dir>/fake-agent.json:
//   { "scripts": [ { "match": "make it red", "steps": [ ... ] } ] }
// The first script whose match appears in the turn's prompt runs. Steps:
//   { "say": "text" }                     streamed reply text
//   { "tool": "apply_to_selection", "args": { ... } }   a studio tool call
//   { "write": { "path": "src/rigs/x.ts", "content": "..." } }   a file edit
//   { "command": "npm test" }             a shell command (never run)
//   { "wait": 500 }                       a pause that Stop cuts short
//   { "ask": [ { "id", "header", "question", "options": [ { "label" } ] } ] }
//                                         a question card; says the answers back
//   { "fail": "why" }                     ends the turn as failed
//   { "summary": "text" }                 the turn's summary (default: the last say)
// Node only.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { currentTurn, type AgentQuestion } from '../../../src/studio/protocol.ts';
import type { AgentProvider, TurnCallbacks, TurnHandle, TurnInput, TurnOutcome } from './types.ts';

type Step =
  | { say: string }
  | { tool: string; args?: Record<string, unknown> }
  | { write: { path: string; content: string } }
  | { command: string }
  | { wait: number }
  | { ask: AgentQuestion[] }
  | { fail: string }
  | { summary: string };

interface Script {
  match: string;
  steps: Step[];
}

export function fakeProvider(studioDir: string): AgentProvider {
  const scriptsFile = resolve(studioDir, 'fake-agent.json');

  async function scriptFor(prompt: string): Promise<Script | null> {
    try {
      const { scripts } = JSON.parse(await readFile(scriptsFile, 'utf8')) as { scripts: Script[] };
      return scripts.find((s) => prompt.includes(s.match)) ?? null;
    } catch {
      return null;
    }
  }

  return {
    id: 'fake',
    label: 'Test agent',
    async status() {
      return { ready: true, detail: 'Scripted, for tests', models: [{ id: 'scripted', label: 'Scripted' }], efforts: [] };
    },
    startTurn(input: TurnInput, cb: TurnCallbacks): TurnHandle {
      const abort = new AbortController();
      const done = run(input, cb, abort.signal).catch(
        (err): TurnOutcome =>
          abort.signal.aborted ? { status: 'stopped', summary: '' } : { status: 'failed', summary: err instanceof Error ? err.message : String(err) },
      );
      return {
        done,
        stop: async () => abort.abort(),
      };
    },
  };

  async function run(input: TurnInput, cb: TurnCallbacks, signal: AbortSignal): Promise<TurnOutcome> {
    const session = input.session ?? `fake-${input.thread.id}`;
    cb.session(session);
    if (input.session) cb.emit({ type: 'status', message: `Fake agent resumed ${input.session}` });
    const prompt = currentTurn(input.thread).ask.prompt;
    const script = await scriptFor(prompt);
    if (!script) {
      cb.emit({ type: 'text', text: `No fake-agent script matches "${prompt}".` });
      return { status: 'failed', summary: 'No script for this prompt.' };
    }
    const client = new Client({ name: 'frame-studio-fake-agent', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(input.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${input.mcp.token}` } },
    });
    await client.connect(transport);
    let said = '';
    let summary: string | null = null;
    let n = 0;
    const stopped = (): TurnOutcome | null => (signal.aborted ? { status: 'stopped', summary: said.trim() } : null);
    try {
      for (const step of script.steps) {
        const halt = stopped();
        if (halt) return halt;
        const id = `step-${++n}`;
        if ('say' in step) {
          for (const word of step.say.split(/(?<= )/)) cb.emit({ type: 'text', text: word });
          said = step.say;
        } else if ('tool' in step) {
          cb.emit({ type: 'step', id, label: `Studio: ${step.tool}`, status: 'running' });
          const result = (await client.callTool({ name: step.tool, arguments: step.args ?? {} })) as { isError?: boolean; content: { type: string; text?: string }[] };
          const text = result.content.find((c) => c.type === 'text')?.text ?? '';
          cb.emit({ type: 'step', id, label: `Studio: ${step.tool}`, status: result.isError ? 'failed' : 'done', detail: text.slice(0, 500) });
        } else if ('write' in step) {
          const label = `Edit ${step.write.path}`;
          cb.emit({ type: 'step', id, label, status: 'running' });
          if (await cb.decide({ kind: 'write', paths: [resolve(input.cwd, step.write.path)] })) {
            const path = resolve(input.cwd, step.write.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, step.write.content);
            cb.emit({ type: 'step', id, label, status: 'done' });
          } else {
            cb.emit({ type: 'step', id, label, status: 'failed', detail: 'Declined' });
          }
        } else if ('command' in step) {
          const label = `Run ${step.command}`;
          cb.emit({ type: 'step', id, label, status: 'running' });
          const allowed = await cb.decide({ kind: 'command', command: step.command });
          cb.emit({ type: 'step', id, label, status: allowed ? 'done' : 'failed', ...(allowed ? {} : { detail: 'Declined' }) });
        } else if ('wait' in step) {
          await new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, step.wait);
            signal.addEventListener('abort', () => (clearTimeout(timer), resolveWait()), { once: true });
          });
        } else if ('ask' in step) {
          const answers = await cb.ask(step.ask);
          const text = answers ? `You chose: ${step.ask.map((q) => `${q.header} ${(answers[q.id] ?? []).join(' + ')}`).join('; ')}. ` : 'No answer, so I picked for you. ';
          cb.emit({ type: 'text', text });
          said = text;
        } else if ('fail' in step) {
          cb.emit({ type: 'text', text: step.fail });
          return { status: 'failed', summary: step.fail, usage: { inputTokens: 100, outputTokens: 20 } };
        } else if ('summary' in step) {
          summary = step.summary;
        }
      }
      return stopped() ?? { status: 'done', summary: summary ?? said.trim(), usage: { inputTokens: 100, outputTokens: 20 } };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
