// The selection handoff between the viewer and the agents (ADR 0003, ADR
// 0006): the shapes of .frame-studio/selection.json and the request files, and
// the rules every side shares. Pure and import-free, so the viewer, the studio
// server and the MCP server (running as TypeScript in Node) all use this one
// module.
//
// A request is a thread. You ask, an agent works a turn, you reply, and so on
// until you settle it. Each turn keeps its own checkpoint of the scene.

/** What the user picked: one layer, or with no layerId the whole frame range. */
export interface RequestSelection {
  sceneId: string;
  layerId?: string;
  partId?: string;
  /** First frame, included. */
  from: number;
  /** Last frame, excluded. */
  to: number;
}

/** .frame-studio/selection.json: the viewer's current selection, for get_selection and the @-mention. */
export interface CurrentSelection extends RequestSelection {
  /** The frame on screen. */
  frame: number;
  /** Where the user clicked, in scene pixels, when the selection came from a click. */
  point?: { x: number; y: number };
  updatedAt: string;
}

/** Who works a thread. External is any agent that claims through MCP; the rest run inside the studio (M8). */
export type AgentId = 'external' | 'claude' | 'codex' | 'fake';
export const AGENT_IDS: readonly AgentId[] = ['external', 'claude', 'codex', 'fake'];

/** Studio: the studio tools plus writes in scenes/, src/rigs/ and src/audio/, and approval for the rest. Full: no prompts. */
export type AccessMode = 'studio' | 'full';

/** Per-turn settings for an agent in the studio. */
export interface TurnSettings {
  model?: string;
  effort?: string;
  access: AccessMode;
}

/** One message from the user: the prompt and what it points at. */
export interface Ask {
  prompt: string;
  /** Repo-relative paths under references/. */
  references: string[];
  selection: RequestSelection;
  /** The frame on screen when it was sent. */
  frame: number;
  point?: { x: number; y: number };
  at: string;
}

/**
 * pending: waiting for an agent. working: claimed. done or failed: the agent
 * finished. stopped: the user pressed Stop. interrupted: the studio server
 * went away mid-turn. cancelled: withdrawn before an agent took it. reverted:
 * undone by Revert.
 */
export type TurnStatus = 'pending' | 'working' | 'done' | 'failed' | 'stopped' | 'interrupted' | 'cancelled' | 'reverted';

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** A user's ask and the agent's work on it. */
export interface Turn {
  ask: Ask;
  status: TurnStatus;
  /** For agents in the studio. */
  settings?: TurnSettings;
  claimedAt?: string;
  /** Which session claimed it: an MCP server's process id, or the studio server's. */
  claimedBy?: string;
  completedAt?: string;
  /** The agent's account of what it did, or why it failed. */
  summary?: string;
  /** When the scene was copied to this turn's checkpoint file, at claim time. It stays put across a requeue. */
  checkpointAt?: string;
  /**
   * True when the scene's project.json changed while the turn worked (ADR 0007). Its checkpoint then
   * holds project.json too, and Revert to here restores both.
   */
  projectChanged?: boolean;
  usage?: TurnUsage;
  /** 2 or more when asked again with Try again. */
  attempt?: number;
}

/**
 * pending: its newest turn waits for an agent. working: an agent has it.
 * your_turn: the agent finished a turn and waits for you. settled: you closed
 * it. cancelled: withdrawn before any agent worked on it.
 */
export type ThreadStatus = 'pending' | 'working' | 'your_turn' | 'settled' | 'cancelled';

/** A request file, .frame-studio/requests/NNNN.json: one thread. */
export interface StudioRequest {
  id: number;
  createdAt: string;
  status: ThreadStatus;
  agent: AgentId;
  /** Every turn shares the scene the thread started on. */
  sceneId: string;
  turns: Turn[];
  /** The provider's own session id, so a reply resumes the same conversation. */
  session?: string;
  settledAt?: string;
}

/** What the viewer sends to start a thread. */
export interface NewRequest {
  selection: RequestSelection;
  frame: number;
  point?: { x: number; y: number };
  prompt: string;
  references: string[];
  agent?: AgentId;
  settings?: TurnSettings;
}

/** What the viewer sends to reply in a thread. The selection must stay on the thread's scene. */
export type Reply = Omit<NewRequest, 'agent'>;

/** Something that happened during a turn of an agent in the studio, as the viewer's transcript shows it (ADR 0006). */
export type TurnEventBody =
  /** More of the agent's reply. Consecutive texts join up. */
  | { type: 'text'; text: string }
  /** One step: a tool call, a file edit, a command. The same id updates it. */
  | { type: 'step'; id: string; label: string; status: 'running' | 'done' | 'failed'; detail?: string }
  /** A frame the agent rendered to check its work, saved next to the thread. `file` is the name inside the turn's folder. */
  | { type: 'frame'; file: string; sceneId: string; frame: number }
  /** The agent wants to do something the thread's access doesn't cover. */
  | { type: 'approval'; id: string; kind: ApprovalKind; summary: string; detail?: string }
  | { type: 'approval-resolved'; id: string; decision: ApprovalDecision }
  | { type: 'usage'; usage: TurnUsage }
  /** A notice from the studio, e.g. "Resuming the session". */
  | { type: 'status'; message: string }
  | { type: 'error'; message: string };

export type TurnEvent = TurnEventBody & { seq: number; at: string };
export type ApprovalKind = 'write' | 'command' | 'network' | 'read' | 'scene' | 'project' | 'tool';
export type ApprovalDecision = 'accept' | 'decline';

/** An agent the studio can run, as the agent picker shows it. */
export interface AgentStatus {
  id: AgentId;
  label: string;
  /** Installed and signed in, so a thread for it will start. */
  ready: boolean;
  /** "Signed in", or what is wrong. */
  detail: string;
  /** The command that fixes it, e.g. "claude auth login". */
  fix?: string;
  models: { id: string; label: string }[];
  efforts: string[];
}

/** A turn working longer than this for an external agent shows as stalled, with Requeue and Cancel. */
export const STALL_MS = 10 * 60 * 1000;

/** The event the studio server pushes the whole queue on, over Vite's websocket. */
export const QUEUE_EVENT = 'frame-studio:queue';
/** The event the studio server pushes a turn's live events on (ADR 0006). */
export const TURN_EVENT = 'frame-studio:turn';

/** Pushed when scene, project, rig or generator files change: the page loads its library again. */
export const LIBRARY_EVENT = 'frame-studio:library';

/** Pushed as a viewer export goes: progress, then done with the file, or an error. */
export const EXPORT_EVENT = 'frame-studio:export';

/** Reference image types the studio accepts, with the extension each is saved under. */
export const REFERENCE_TYPES: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

export type RequestFileKind = 'request' | 'claim';

export function requestFileName(id: number, kind: RequestFileKind = 'request'): string {
  const stem = String(id).padStart(4, '0');
  return kind === 'request' ? `${stem}.json` : `${stem}.claim`;
}

/** Turn k's checkpoint. Turn 0 keeps the name requests had before threads, so old checkpoints still work. */
export function checkpointFileName(id: number, turn: number): string {
  const stem = String(id).padStart(4, '0');
  return turn === 0 ? `${stem}.before.json` : `${stem}.${turn}.before.json`;
}

/** Where a turn on a project scene keeps its copy of project.json: NNNN.project.before.json, then NNNN.K.project.before.json. */
export function projectCheckpointFileName(id: number, turn: number): string {
  return checkpointFileName(id, turn).replace(/\.before\.json$/, '.project.before.json');
}

/** The project of a qualified scene id ("bears-story/shot-1"), or null for a loose scene (ADR 0007). */
export function projectOf(sceneId: string): string | null {
  const m = /^([^/]+)\/[^/]+$/.exec(sceneId);
  return m && !sceneId.endsWith('.json') ? m[1] : null;
}

/** The folder beside a request that holds its turns' event logs and frame thumbnails. */
export function threadDirName(id: number): string {
  return String(id).padStart(4, '0');
}

export function currentTurn(request: StudioRequest): Turn {
  return request.turns[request.turns.length - 1];
}

/** The selection the thread now points at: its newest turn's. */
export function currentSelection(request: StudioRequest): RequestSelection {
  return currentTurn(request).ask.selection;
}

/** A turn that ended, one way or another. */
export function isFinished(turn: Turn): boolean {
  return turn.status !== 'pending' && turn.status !== 'working';
}

const LEGACY_STATUS: Record<string, { thread: ThreadStatus; turn: TurnStatus }> = {
  pending: { thread: 'pending', turn: 'pending' },
  in_progress: { thread: 'working', turn: 'working' },
  done: { thread: 'your_turn', turn: 'done' },
  failed: { thread: 'your_turn', turn: 'failed' },
  cancelled: { thread: 'cancelled', turn: 'cancelled' },
  reverted: { thread: 'your_turn', turn: 'reverted' },
};

/**
 * A request file as a thread. Files written before threads (M6) had one ask
 * and one status; they read as one-turn threads for the external agent.
 */
export function normalizeRequest(raw: unknown): StudioRequest {
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.turns)) return r as unknown as StudioRequest;
  const legacy = r as {
    id: number;
    createdAt: string;
    status: string;
    selection: RequestSelection;
    frame: number;
    point?: { x: number; y: number };
    prompt: string;
    references: string[];
    attempt?: number;
    claimedAt?: string;
    claimedBy?: string;
    completedAt?: string;
    summary?: string;
    checkpoint?: boolean;
    checkpointAt?: string;
  };
  const status = LEGACY_STATUS[legacy.status] ?? LEGACY_STATUS.pending;
  const turn: Turn = {
    ask: {
      prompt: legacy.prompt,
      references: legacy.references ?? [],
      selection: legacy.selection,
      frame: legacy.frame,
      ...(legacy.point ? { point: legacy.point } : {}),
      at: legacy.createdAt,
    },
    status: status.turn,
    ...(legacy.claimedAt ? { claimedAt: legacy.claimedAt } : {}),
    ...(legacy.claimedBy ? { claimedBy: legacy.claimedBy } : {}),
    ...(legacy.completedAt ? { completedAt: legacy.completedAt } : {}),
    ...(legacy.summary ? { summary: legacy.summary } : {}),
    ...(legacy.checkpoint ? { checkpointAt: legacy.checkpointAt ?? legacy.claimedAt ?? legacy.createdAt } : {}),
    ...(legacy.attempt ? { attempt: legacy.attempt } : {}),
  };
  return {
    id: legacy.id,
    createdAt: legacy.createdAt,
    status: status.thread,
    agent: 'external',
    sceneId: legacy.selection.sceneId,
    turns: [turn],
  };
}

export type DisplayStatus = ThreadStatus | 'stalled';

/** The status to show: an external agent's turn working longer than STALL_MS reads as stalled. */
export function displayStatus(request: StudioRequest, now: number): DisplayStatus {
  const turn = currentTurn(request);
  if (request.status === 'working' && request.agent === 'external' && turn.claimedAt && now - Date.parse(turn.claimedAt) > STALL_MS) {
    return 'stalled';
  }
  return request.status;
}

/** "layer pip › mouth", "layer pip", or "all layers" for a whole-range selection. */
export function describeTarget(selection: RequestSelection): string {
  if (selection.layerId === undefined) return 'all layers';
  return `layer ${selection.layerId}${selection.partId ? ` › ${selection.partId}` : ''}`;
}

/** The line "Send to agent" copies: enough for any agent to find the request and work it. */
export function clipboardLine(request: StudioRequest): string {
  const turn = currentTurn(request);
  const s = turn.ask.selection;
  const extras = [
    `${s.sceneId}, ${describeTarget(s)}, frames [${s.from}, ${s.to})`,
    ...(turn.ask.references.length > 0 ? [`${turn.ask.references.length} reference image${turn.ask.references.length === 1 ? '' : 's'}`] : []),
    ...(request.turns.length > 1 ? [`reply ${request.turns.length - 1} in the thread`] : []),
  ].join(', ');
  const prompt = turn.ask.prompt.replace(/\s+/g, ' ').trim();
  return (
    `Frame Studio request #${request.id}: "${prompt}" (${extras}). ` +
    `Read it with the frame-studio MCP tool get_request (id ${request.id}), then call complete_request when you are done.`
  );
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : -Infinity);

/**
 * "Revert to here" on turn k restores the scene as it was before that turn's
 * agent started, and marks turn k and every later turn reverted. It is
 * offered only when turn k has a checkpoint, no turn of the thread is still
 * pending or working, and restoring can't discard anyone else's work: no
 * other thread on the scene is working, or had a turn claimed or finished
 * after turn k's checkpoint. It goes by time, not id, since two sessions can
 * overlap and a requeued turn keeps its old checkpoint. Turns that were never
 * claimed, or were cancelled or already reverted, don't count, so undo can
 * step back one turn at a time.
 */
export function canRevert(request: StudioRequest, turn: number, all: readonly StudioRequest[]): boolean {
  const target = request.turns[turn];
  if (!target || !target.checkpointAt || target.status === 'reverted' || target.status === 'cancelled') return false;
  if (request.turns.some((t) => !isFinished(t))) return false;
  const since = time(target.checkpointAt);
  /** A turn that works now, or worked after the checkpoint, and still counts. */
  const later = (t: Turn) =>
    t.claimedAt !== undefined &&
    t.status !== 'reverted' &&
    t.status !== 'cancelled' &&
    (t.status === 'working' || time(t.claimedAt) > since || time(t.completedAt) > since);
  // Restoring project.json touches every scene in the project, like editing it: nothing else there may be working,
  // or have changed it since. A turn cancelled while it worked may have changed it too, so those count here.
  const project = projectOf(request.sceneId);
  const changedProject = (t: Turn) => t.projectChanged === true && t.status !== 'reverted';
  const restoresProject = project !== null && request.turns.slice(turn).some(changedProject);
  const changedProjectSince = (t: Turn) =>
    changedProject(t) && t.claimedAt !== undefined && (t.status === 'working' || time(t.claimedAt) > since || time(t.completedAt) > since);
  return !all.some(
    (r) =>
      r.id !== request.id &&
      ((r.sceneId === request.sceneId && r.turns.some(later)) ||
        (restoresProject && projectOf(r.sceneId) === project && r.turns.some((t) => t.status === 'working' || changedProjectSince(t)))),
  );
}

/** The newest turn that can be reverted to, or null: what Revert on a settled thread or Try again use. */
export function firstRevertableTurn(request: StudioRequest, all: readonly StudioRequest[]): number | null {
  for (let k = 0; k < request.turns.length; k++) {
    if (request.turns[k].status !== 'reverted' && request.turns[k].status !== 'cancelled' && request.turns[k].checkpointAt) {
      return canRevert(request, k, all) ? k : null;
    }
  }
  return null;
}

const REFERENCE_PATH = /^references\/[^/\\]+\.(png|jpe?g|webp)$/i;

/** A reference path as uploads return them: an image directly in references/. */
export function isReferencePath(path: unknown): path is string {
  return typeof path === 'string' && REFERENCE_PATH.test(path);
}

/** Why a Try again body is malformed, or null: an optional prompt, references and settings. */
export function checkRetry(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (!isObject(input)) return 'a retry must be a JSON object';
  for (const key of Object.keys(input)) if (!['prompt', 'references', 'settings'].includes(key)) return `unknown field "${key}"`;
  if (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 8000)) return 'prompt must be text';
  if (input.references !== undefined && (!Array.isArray(input.references) || !input.references.every(isReferencePath))) {
    return 'references must be paths of images directly in references/, as uploads return them';
  }
  if (input.settings !== undefined) return checkSettings(input.settings);
  return null;
}
const NEW_REQUEST_FIELDS = new Set(['selection', 'frame', 'point', 'prompt', 'references', 'agent', 'settings']);
const SELECTION_FIELDS = new Set(['sceneId', 'layerId', 'partId', 'from', 'to']);
const SETTINGS_FIELDS = new Set(['model', 'effort', 'access']);
const isInt = (v: unknown, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why `settings` are not well-formed TurnSettings, or null when they are. */
export function checkSettings(settings: unknown): string | null {
  if (!isObject(settings)) return 'settings must be an object';
  for (const key of Object.keys(settings)) if (!SETTINGS_FIELDS.has(key)) return `unknown settings field "${key}"`;
  if (settings.access !== 'studio' && settings.access !== 'full') return 'settings.access must be "studio" or "full"';
  for (const key of ['model', 'effort'] as const) {
    const v = settings[key];
    if (v !== undefined && (typeof v !== 'string' || v === '' || v.length > 100)) return `settings.${key} must be a short name`;
  }
  return null;
}

/**
 * Why `input` is not a well-formed NewRequest (or, with reply set, a Reply),
 * or null when it is. The studio server checks every request it is sent.
 */
export function checkNewRequest(input: unknown, options: { reply?: boolean } = {}): string | null {
  if (!isObject(input)) return 'a request must be a JSON object';
  for (const key of Object.keys(input)) {
    if (!NEW_REQUEST_FIELDS.has(key) || (options.reply && key === 'agent')) return `unknown field "${key}"`;
  }
  const s = input.selection;
  if (!isObject(s)) return 'selection must be an object';
  for (const key of Object.keys(s)) if (!SELECTION_FIELDS.has(key)) return `unknown selection field "${key}"`;
  if (typeof s.sceneId !== 'string' || s.sceneId === '') return 'selection.sceneId must be a scene id';
  if (s.layerId !== undefined && (typeof s.layerId !== 'string' || s.layerId === '')) return 'selection.layerId must be a layer id';
  if (s.partId !== undefined && (typeof s.partId !== 'string' || s.layerId === undefined)) return 'selection.partId needs a layerId';
  if (!isInt(s.from, 0) || !isInt(s.to, 1) || (s.from as number) >= (s.to as number)) return 'selection needs integer frames with 0 <= from < to';
  if (!isInt(input.frame, 0)) return 'frame must be a whole frame number';
  const point = input.point;
  if (point !== undefined && !(isObject(point) && Number.isFinite(point.x) && Number.isFinite(point.y))) return 'point must be { x, y }';
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return 'a request needs a prompt';
  if (input.prompt.length > 8000) return 'the prompt is over 8000 characters';
  if (!Array.isArray(input.references) || !input.references.every(isReferencePath)) {
    return 'references must be paths of images directly in references/, as uploads return them';
  }
  if (input.agent !== undefined && !AGENT_IDS.includes(input.agent as AgentId)) return `agent must be one of ${AGENT_IDS.join(', ')}`;
  if (input.settings !== undefined) return checkSettings(input.settings);
  return null;
}

/**
 * A new, empty scene: paper and no layers. A loose one, in scenes/, needs its own fps and size; one in a
 * project takes the project's, so it leaves them out.
 */
export interface NewScene {
  id: string;
  project?: string;
  fps?: number;
  size?: [number, number];
  duration: number;
}

/** A new project: project.json with a name, fps and size, and an empty main scene, "main". */
export interface NewProject {
  id: string;
  name: string;
  fps: number;
  size: [number, number];
  duration: number;
}

/** The main scene a new project starts with. */
export const NEW_PROJECT_MAIN = 'main';

const NEW_SCENE_FIELDS = new Set(['id', 'project', 'fps', 'size', 'duration']);
const NEW_PROJECT_FIELDS = new Set(['id', 'name', 'fps', 'size', 'duration']);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A scene or project id from a name as typed: "Bears' Story 2" becomes "bears-story-2". Empty when nothing is left. */
export function toId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

function checkId(id: unknown, what: string): string | null {
  if (typeof id !== 'string' || id === '') return `${what} needs a name`;
  if (id.length > 64 || !ID_PATTERN.test(id)) return `${what} id must be lowercase letters, digits and single hyphens, like "opening-shot", got "${String(id)}"`;
  return null;
}

function checkFormat(input: Record<string, unknown>): string | null {
  if (!isInt(input.fps, 1) || (input.fps as number) > 120) return 'fps must be a whole number from 1 to 120';
  const size = input.size;
  if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => isInt(n, 16) && n <= 8192)) return 'size must be [width, height], whole pixels from 16 to 8192';
  return null;
}

function checkDuration(duration: unknown): string | null {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= 3600 ? null : 'duration must be a number of seconds, above 0 and at most 3600';
}

/** Why `input` is not a well-formed NewScene, or null when it is. */
export function checkNewScene(input: unknown): string | null {
  if (!isObject(input)) return 'a new scene must be a JSON object';
  for (const key of Object.keys(input)) if (!NEW_SCENE_FIELDS.has(key)) return `unknown field "${key}"`;
  const problem = checkId(input.id, 'a scene');
  if (problem) return problem;
  if (input.project !== undefined) {
    const inProject = checkId(input.project, 'the project');
    if (inProject) return inProject;
    if (input.id === 'project') return 'a scene in a project can\'t be called "project"; project.json is taken';
    if (input.fps !== undefined || input.size !== undefined) return "a scene in a project takes the project's fps and size; leave them out";
  } else {
    const format = checkFormat(input);
    if (format) return format;
  }
  return checkDuration(input.duration);
}

/** Why `input` is not a well-formed NewProject, or null when it is. */
export function checkNewProject(input: unknown): string | null {
  if (!isObject(input)) return 'a new project must be a JSON object';
  for (const key of Object.keys(input)) if (!NEW_PROJECT_FIELDS.has(key)) return `unknown field "${key}"`;
  const problem = checkId(input.id, 'a project');
  if (problem) return problem;
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) return 'a project needs a name of at most 100 characters';
  return checkFormat(input) ?? checkDuration(input.duration);
}
