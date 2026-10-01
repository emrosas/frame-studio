// The provider seam for agents the studio runs itself (ADR 0006), cut down
// from T3 Code's ProviderAdapter to what the studio needs: start a turn,
// stream what happens, ask before anything the thread's access doesn't cover,
// and stop. Each provider launches the user's own signed-in CLI; none of them
// sees a token. Node only.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentId, AgentQuestion, AgentStatus, QuestionAnswers, StudioRequest, TurnEventBody, TurnSettings, TurnUsage } from '../../../src/studio/protocol.ts';

/** Something an agent wants to do, in the terms the access rules decide on. */
export type Action =
  | { kind: 'read'; path: string }
  | { kind: 'write'; paths: string[] }
  | { kind: 'command'; command: string }
  | { kind: 'network'; target: string }
  /** A studio tool that writes a scene other than the thread's. */
  | { kind: 'scene'; sceneId: string; tool: string }
  /** An edit to a project's project.json, by a studio tool or to the file (ADR 0007). */
  | { kind: 'project'; projectId: string; tool: string }
  /** Any other tool the provider offers. */
  | { kind: 'tool'; name: string; detail?: string };

export interface TurnInput {
  thread: StudioRequest;
  /** The thread described for the agent (describe.ts), for this turn. */
  prompt: string;
  /** Standing instructions: what the studio is and how to work in it. */
  instructions: string;
  settings: TurnSettings;
  /** The provider's session to resume, from an earlier turn. */
  session?: string;
  /** The repo root. */
  cwd: string;
  /**
   * The studio tools: over HTTP with this turn's bearer token, for a provider that runs as another
   * process; or as an in-process server, for one that can host it, which needs no token at all.
   */
  mcp: { url: string; token: string; server: () => McpServer };
}

export interface TurnCallbacks {
  emit(event: TurnEventBody): void;
  /** Asks the access rules, and the user through an approval card when they say to. Resolves true when allowed. */
  decide(action: Action): Promise<boolean>;
  /**
   * Shows the user a question card and waits for the answers, by question id (ADR 0011). Null when the
   * turn stops first, or the user skips: the agent should then carry on with its best guess, or end its turn.
   */
  ask(questions: AgentQuestion[]): Promise<QuestionAnswers | null>;
  /** The provider's session id, as soon as it is known, so a later turn can resume it. */
  session(id: string): void;
}

export interface TurnOutcome {
  status: 'done' | 'failed' | 'stopped';
  /** The agent's last words, shown as the turn's summary. */
  summary: string;
  usage?: TurnUsage;
}

export interface TurnHandle {
  done: Promise<TurnOutcome>;
  /** Stops the turn. `done` then settles with status stopped. */
  stop(): Promise<void>;
}

export interface AgentProvider {
  id: AgentId;
  label: string;
  /** Installed and signed in? Cheap enough to call every few seconds; callers cache it. */
  status(): Promise<Omit<AgentStatus, 'id' | 'label'>>;
  startTurn(input: TurnInput, callbacks: TurnCallbacks): TurnHandle;
}
