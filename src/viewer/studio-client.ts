// The viewer's side of the studio server protocol (ADR 0001, ADR 0003, ADR
// 0006, ADR 0008): HTTP calls to /__studio/, and what the server pushes on its
// event stream, the queue and the live events of turns. The viewer always
// comes from a studio server, and pairs with it before it boots.

import { studioEvents } from './studio-events';
import {
  EXPORT_EVENT,
  QUEUE_EVENT,
  TURN_EVENT,
  type AgentStatus,
  type ApprovalDecision,
  type CurrentSelection,
  type NewProject,
  type NewRequest,
  type NewScene,
  type Reply,
  type StudioRequest,
  type TurnEvent,
  type TurnSettings,
} from '../studio/protocol';

const BASE = '/__studio';

export type RequestAction = 'cancel' | 'requeue' | 'settle' | 'stop';

/** What the viewer asks the studio server to export (ADR 0008). */
export interface ExportInput {
  scene: string;
  target: 'mp4' | 'gif' | 'html';
  from?: number;
  to?: number;
  silent?: boolean;
}

/** An export's progress, or its end: the file written, or why it failed. */
export type ExportEvent =
  | { id: string; stage: string; done: number; total: number }
  | { id: string; done: true; file: string }
  | { id: string; error: string };

/** A turn's event as pushed: which thread and turn it belongs to. */
export interface PushedTurnEvent {
  id: number;
  turn: number;
  event: TurnEvent;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The studio server answered ${res.status}.`);
  return data;
}

const jsonBody = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

export class StudioClient {
  /** The viewer is served by the studio server and paired before it boots, so the server is there. */
  readonly available = true;

  async queue(): Promise<StudioRequest[]> {
    return (await call<{ requests: StudioRequest[] }>('/queue')).requests;
  }

  /** Calls `listener` with the whole queue whenever it changes on disk. Returns an unsubscribe function. */
  onQueue(listener: (requests: StudioRequest[]) => void): () => void {
    return this.on(QUEUE_EVENT, (data: { requests: StudioRequest[] }) => listener(data.requests));
  }

  /** Calls `listener` with every event of every turn an agent in the studio works, as it happens. */
  onTurnEvent(listener: (pushed: PushedTurnEvent) => void): () => void {
    return this.on(TURN_EVENT, listener);
  }

  private on<T>(event: string, handler: (data: T) => void): () => void {
    return studioEvents.on(event, handler);
  }

  /** The agents a thread can go to, with whether each is ready. `fresh` skips the server's short cache. */
  async agents(fresh = false): Promise<AgentStatus[]> {
    return (await call<{ agents: AgentStatus[] }>(`/agents${fresh ? '?fresh' : ''}`)).agents;
  }

  async create(request: NewRequest): Promise<StudioRequest> {
    return (await call<{ request: StudioRequest }>('/requests', jsonBody(request))).request;
  }

  /** Creates an empty scene; returns its id as the library keys it. */
  async createScene(scene: NewScene): Promise<string> {
    return (await call<{ id: string }>('/scenes', jsonBody(scene))).id;
  }

  /** Creates a project with an empty main scene; returns the main scene's id. */
  async createProject(project: NewProject): Promise<string> {
    return (await call<{ main: string }>('/projects', jsonBody(project))).main;
  }

  async reply(id: number, reply: Reply): Promise<StudioRequest> {
    return (await call<{ request: StudioRequest }>(`/requests/${id}/reply`, jsonBody(reply))).request;
  }

  async act(id: number, action: RequestAction): Promise<void> {
    await call(`/requests/${id}/${action}`, jsonBody({}));
  }

  /** Try again: reverts the newest turn and asks again, with an edited prompt, references and settings. */
  async retry(id: number, change: { prompt: string; references?: string[]; settings?: TurnSettings }): Promise<void> {
    await call(`/requests/${id}/retry`, jsonBody(change));
  }

  /** "Revert to here" on a turn, or with no turn, the whole thread. */
  async revert(id: number, turn?: number): Promise<void> {
    await call(`/requests/${id}/revert`, jsonBody(turn === undefined ? {} : { turn }));
  }

  async respond(id: number, approval: string, decision: ApprovalDecision): Promise<void> {
    await call(`/requests/${id}/approvals/${encodeURIComponent(approval)}`, jsonBody({ decision }));
  }

  async turnEvents(id: number, turn: number): Promise<TurnEvent[]> {
    return (await call<{ events: TurnEvent[] }>(`/requests/${id}/turns/${turn}/events`)).events;
  }

  frameUrl(id: number, turn: number, file: string): string {
    return `${BASE}/requests/${id}/turns/${turn}/frames/${encodeURIComponent(file)}`;
  }

  async clearFinished(): Promise<number> {
    return (await call<{ removed: number }>('/requests/clear', jsonBody({}))).removed;
  }

  async setSelection(selection: Omit<CurrentSelection, 'updatedAt'> | null): Promise<void> {
    await call('/selection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection) });
  }

  /** Starts an export on the studio server; progress and the outcome come as export events. Returns its id. */
  async startExport(input: ExportInput): Promise<string> {
    return (await call<{ id: string }>('/export', jsonBody(input))).id;
  }

  async cancelExport(id: string): Promise<void> {
    await call(`/export/${encodeURIComponent(id)}/cancel`, jsonBody({}));
  }

  /** Calls `listener` with every export event: progress, then done with the file, or an error. */
  onExport(listener: (event: ExportEvent) => void): () => void {
    return this.on(EXPORT_EVENT, listener);
  }

  /** Copies an image into references/ and returns its repo-relative path. */
  async uploadReference(file: File): Promise<string> {
    const path = `/references?name=${encodeURIComponent(file.name || 'pasted.png')}`;
    return (await call<{ path: string }>(path, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })).path;
  }
}
