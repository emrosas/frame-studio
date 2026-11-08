// The viewer's side of the studio server protocol (ADR 0001, ADR 0003, ADR
// 0006, ADR 0008): HTTP calls to /__studio/, and what the server pushes on its
// event stream, the queue and the live events of turns. The viewer always
// comes from a studio server, and pairs with it before it boots.

import type { CheckReport } from '../export/check';
import { studioEvents } from './studio-events';
import type { RenderItem } from './ui.svelte';
import {
  CHECK_EVENT,
  EXPORT_EVENT,
  QUEUE_EVENT,
  SPEECH_EVENT,
  THUMB_EVENT,
  TURN_EVENT,
  VOICE_EVENT,
  type VoiceEvent,
  type VoiceStatus,
  type AgentStatus,
  type ApprovalDecision,
  type ClipEdit,
  type LayerChange,
  type LayerEdit,
  type CurrentSelection,
  type KokoroStatus,
  type NewRequest,
  type NewScene,
  type NewVideo,
  type PlacedVoice,
  type QuestionAnswers,
  type Reply,
  type StudioRequest,
  type TurnEvent,
  type TurnSettings,
} from '../studio/protocol';
import type { TimelineEdit, TimelineResult } from '../studio/timeline-edit';

const BASE = '/__studio';

export type RequestAction = 'cancel' | 'requeue' | 'settle' | 'stop';

/** What the viewer asks the studio server to export (ADR 0008). */
export interface ExportInput {
  scene: string;
  target: 'mp4' | 'gif' | 'html';
  from?: number;
  to?: number;
  silent?: boolean;
  /** For HTML: inline the sound files its cues play (ADR 0012). */
  media?: boolean;
}

/** An export's progress, or its end: the file written, or why it failed. */
export type ExportEvent =
  | { id: string; stage: string; done: number; total: number }
  | { id: string; done: true; file: string; note?: string }
  | { id: string; error: string };

export interface CheckInput {
  scene: string;
  from?: number;
  to?: number;
  loop?: boolean;
}

/** A check's progress, or its end: the report, or why it failed. */
export type CheckEvent = { id: string; stage: string; done: number; total: number } | { id: string; report: CheckReport } | { id: string; error: string };

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
  async agents(fresh = false): Promise<{ agents: AgentStatus[]; agentsOff?: string }> {
    return call<{ agents: AgentStatus[]; agentsOff?: string }>(`/agents${fresh ? '?fresh' : ''}`);
  }

  async create(request: NewRequest): Promise<StudioRequest> {
    return (await call<{ request: StudioRequest }>('/requests', jsonBody(request))).request;
  }

  /** The studio folder's sound files with their lengths (ADR 0012). */
  async mediaList(): Promise<{ file: string; bytes: number; duration?: number }[]> {
    return (await call<{ media: { file: string; bytes: number; duration?: number }[] }>('/media')).media;
  }

  /** Uploads a sound file into media/; returns its path for cues. */
  async uploadMedia(file: File): Promise<string> {
    const type = file.type.startsWith('audio/') ? file.type : 'application/octet-stream';
    return (await call<{ file: string }>(`/media?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': type }, body: file })).file;
  }

  /** Adds a cue that plays a sound file in a scene, from `start` seconds, and returns it. A generated voice brings its script and any words. */
  placeSound(scene: string, file: string, start: number, voice?: PlacedVoice): Promise<{ cue: { id: string; words?: unknown[] }; change: LayerChange }> {
    return call('/sounds', jsonBody({ scene, file, start, voice }));
  }

  /** Creates an empty scene; returns its id as the library keys it. */
  async createScene(scene: NewScene): Promise<string> {
    return (await call<{ id: string }>('/scenes', jsonBody(scene))).id;
  }

  /** Converts film `id` in projects/ into a project folder beside this one (ADR 0013); returns its path. */
  async convertFilm(id: string): Promise<string> {
    return (await call<{ path: string }>(`/projects/${encodeURIComponent(id)}/convert`, jsonBody({}))).path;
  }

  /** Creates a video: a composition (ADR 0013), by default with a first scene on its track. Returns the composition's id. */
  async createVideo(video: NewVideo): Promise<string> {
    return (await call<{ id: string }>('/videos', jsonBody(video))).id;
  }

  /** A timeline edit (ADR 0018). Resolves to the file's length, tracks and sound on either side, for undo, and what it made. */
  editTimeline(scene: string, edit: TimelineEdit): Promise<LayerChange & TimelineResult> {
    return call('/timeline', jsonBody({ scene, edit }));
  }

  /** Moves a sound on a video into a scene of its own with captions (ADR 0018). Resolves as editTimeline does. */
  moveCueToScene(scene: string, cue: string): Promise<LayerChange & TimelineResult> {
    return call('/voice-scene', jsonBody({ scene, cue }));
  }

  /** Moves or trims a clip, through the checked edit path. Resolves to the clip on either side, for undo. */
  moveClip(composition: string, edit: ClipEdit): Promise<LayerChange> {
    return call<LayerChange>(`/compositions/${encodeURIComponent(composition)}/clip`, jsonBody(edit));
  }

  /** A hand edit of one layer or clip, through the same check (ADR 0015). */
  editLayer(edit: LayerEdit): Promise<LayerChange> {
    return call<LayerChange>('/layers', jsonBody(edit));
  }

  /** Each scene's poster file, or null while it renders; those arrive through onThumb. */
  async thumbs(): Promise<Record<string, string | null>> {
    return (await call<{ thumbs: Record<string, string | null> }>('/thumbs')).thumbs;
  }

  /** Calls `listener` when a poster finishes in the background. */
  onThumb(listener: (thumb: { key: string; file: string }) => void): () => void {
    return this.on(THUMB_EVENT, listener);
  }

  /** The files in out/, newest first. */
  async renders(): Promise<RenderItem[]> {
    return (await call<{ renders: RenderItem[] }>('/renders')).renders;
  }

  /** Answers a question card in a working turn, or skips it with null (ADR 0011). */
  async answer(id: number, card: string, answers: QuestionAnswers | null): Promise<void> {
    await call(`/requests/${id}/questions/${encodeURIComponent(card)}`, jsonBody({ answers }));
  }

  async reply(id: number, reply: Reply): Promise<StudioRequest> {
    return (await call<{ request: StudioRequest }>(`/requests/${id}/reply`, jsonBody(reply))).request;
  }

  async act(id: number, action: RequestAction): Promise<void> {
    await call(`/requests/${id}/${action}`, jsonBody({}));
  }

  /** Starts a turn found on disk (ADR 0017), at the settings the user chose here. */
  async start(id: number, settings: TurnSettings): Promise<void> {
    await call(`/requests/${id}/start`, jsonBody({ settings }));
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

  /** Starts a check of a scene on the studio server; progress and the report come as check events. Returns its id. */
  async startCheck(input: CheckInput): Promise<string> {
    return (await call<{ id: string }>('/check', jsonBody(input))).id;
  }

  async cancelCheck(id: string): Promise<void> {
    await call(`/check/${encodeURIComponent(id)}/cancel`, jsonBody({}));
  }

  /** Calls `listener` with every check event: progress, then the report, or an error. */
  onCheck(listener: (event: CheckEvent) => void): () => void {
    return this.on(CHECK_EVENT, listener);
  }

  /** Whether a timing job can run now, or needs the model first (ADR 0016). */
  voiceStatus(): Promise<VoiceStatus> {
    return call<VoiceStatus>('/voice');
  }

  async startVoice(job: { scene: string; cue: string; script?: string }): Promise<string> {
    return (await call<{ id: string }>('/voice', jsonBody(job))).id;
  }

  async cancelVoice(id: string): Promise<void> {
    await call(`/voice/${encodeURIComponent(id)}/cancel`, jsonBody({}));
  }

  /** Calls `listener` with every timing event: progress, then the word count, or an error. */
  onVoice(listener: (event: VoiceEvent) => void): () => void {
    return this.on(VOICE_EVENT, listener);
  }

  /** Kokoro on this computer (ADR 0017). */
  async speechStatus(): Promise<KokoroStatus> {
    return (await call<{ kokoro: KokoroStatus }>('/speech')).kokoro;
  }

  /** Starts Kokoro's download; progress and the outcome come as speech events. */
  async installSpeech(): Promise<KokoroStatus> {
    return (await call<{ kokoro: KokoroStatus }>('/speech/install', jsonBody({}))).kokoro;
  }

  /** Speaks with Kokoro into media/. Returns the file's path for cues. */
  async generateSpeech(text: string, lang: string, voice: string): Promise<string> {
    return (await call<{ file: string }>('/speech/generate', jsonBody({ text, lang, voice }))).file;
  }

  /** Calls `listener` with Kokoro's download progress, then how it ended. */
  onSpeech(listener: (event: { done?: number; total?: number; finished?: boolean; error?: string }) => void): () => void {
    return this.on(SPEECH_EVENT, listener);
  }

  /** Copies an image into references/ and returns its repo-relative path. */
  async uploadReference(file: File): Promise<string> {
    const path = `/references?name=${encodeURIComponent(file.name || 'pasted.png')}`;
    return (await call<{ path: string }>(path, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })).path;
  }
}
