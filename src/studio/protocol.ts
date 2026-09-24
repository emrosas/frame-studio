// The selection handoff between the viewer and the agent (ADR 0003): the
// shapes of .frame-studio/selection.json and the request files, and the rules
// both sides share. Pure and import-free, so the viewer, the studio server
// and the MCP server (running as TypeScript in Node) all use this one module.

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

export type RequestStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'cancelled' | 'reverted';

/** A request file, .frame-studio/requests/NNNN.json. */
export interface StudioRequest {
  id: number;
  createdAt: string;
  status: RequestStatus;
  selection: RequestSelection;
  frame: number;
  point?: { x: number; y: number };
  prompt: string;
  /** Repo-relative paths under references/. */
  references: string[];
  /** 2 or more when made with Try again. */
  attempt?: number;
  /** The first request of a Try again chain. */
  retryOf?: number;
  claimedAt?: string;
  /** Which agent session claimed it: the MCP server's process id. */
  claimedBy?: string;
  completedAt?: string;
  /** The agent's one-line account of what it did, or why it failed. */
  summary?: string;
  /** True once the scene was copied to NNNN.before.json at claim time. */
  checkpoint?: boolean;
  /** When that copy was taken. It stays put across a requeue. */
  checkpointAt?: string;
}

/** What the viewer sends to make a request; the queue fills in the rest. */
export type NewRequest = Pick<StudioRequest, 'selection' | 'frame' | 'point' | 'prompt' | 'references' | 'attempt' | 'retryOf'>;

/** A request in progress longer than this shows as stalled, with Requeue and Cancel. */
export const STALL_MS = 10 * 60 * 1000;

/** The event the studio server pushes the whole queue on, over Vite's websocket. */
export const QUEUE_EVENT = 'frame-studio:queue';

/** Reference image types the studio accepts, with the extension each is saved under. */
export const REFERENCE_TYPES: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

export function requestFileName(id: number, kind: 'request' | 'before' | 'claim' = 'request'): string {
  const stem = String(id).padStart(4, '0');
  return kind === 'request' ? `${stem}.json` : kind === 'before' ? `${stem}.before.json` : `${stem}.claim`;
}

/** The status to show: in progress for longer than STALL_MS reads as stalled. */
export function displayStatus(request: StudioRequest, now: number): RequestStatus | 'stalled' {
  if (request.status === 'in_progress' && request.claimedAt && now - Date.parse(request.claimedAt) > STALL_MS) return 'stalled';
  return request.status;
}

/** "layer pip › mouth", "layer pip", or "all layers" for a whole-range selection. */
export function describeTarget(selection: RequestSelection): string {
  if (selection.layerId === undefined) return 'all layers';
  return `layer ${selection.layerId}${selection.partId ? ` › ${selection.partId}` : ''}`;
}

/** The line "Send to agent" copies: enough for any agent to find the request and finish it. */
export function clipboardLine(request: StudioRequest): string {
  const { selection: s } = request;
  const extras = [
    `${s.sceneId}, ${describeTarget(s)}, frames [${s.from}, ${s.to})`,
    ...(request.references.length > 0 ? [`${request.references.length} reference image${request.references.length === 1 ? '' : 's'}`] : []),
  ].join(', ');
  const attempt = request.attempt && request.attempt > 1 ? `; attempt ${request.attempt} of #${request.retryOf ?? request.id}` : '';
  const prompt = request.prompt.replace(/\s+/g, ' ').trim();
  return (
    `Frame Studio request #${request.id}: "${prompt}" (${extras}${attempt}). ` +
    `Read it with the frame-studio MCP tool get_request (id ${request.id}), then call complete_request when you are done.`
  );
}

const CLAIMED: readonly RequestStatus[] = ['in_progress', 'done', 'failed'];

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : -Infinity);

/**
 * Revert and Try again are offered on a finished request (done or failed)
 * with a checkpoint, only when restoring that checkpoint can't discard anyone
 * else's work: no other request on the scene is in progress, or was claimed or
 * finished after the checkpoint was taken. It goes by time, not id, since two
 * sessions can overlap and a requeued request keeps its old checkpoint.
 * Requests that were never claimed, were cancelled or were already reverted
 * don't count, so undo can step back one request at a time.
 */
export function canRevert(request: StudioRequest, all: readonly StudioRequest[]): boolean {
  if (!request.checkpoint || (request.status !== 'done' && request.status !== 'failed')) return false;
  const since = time(request.checkpointAt ?? request.claimedAt ?? request.createdAt);
  return !all.some(
    (r) =>
      r.id !== request.id &&
      r.selection.sceneId === request.selection.sceneId &&
      CLAIMED.includes(r.status) &&
      (r.status === 'in_progress' || time(r.claimedAt) > since || time(r.completedAt) > since),
  );
}

const REFERENCE_PATH = /^references\/[^/\\]+\.(png|jpe?g|webp)$/i;
const NEW_REQUEST_FIELDS = new Set(['selection', 'frame', 'point', 'prompt', 'references', 'attempt', 'retryOf']);
const SELECTION_FIELDS = new Set(['sceneId', 'layerId', 'partId', 'from', 'to']);
const isInt = (v: unknown, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why `input` is not a well-formed NewRequest, or null when it is. The studio server checks every request it is sent. */
export function checkNewRequest(input: unknown): string | null {
  if (!isObject(input)) return 'a request must be a JSON object';
  for (const key of Object.keys(input)) if (!NEW_REQUEST_FIELDS.has(key)) return `unknown field "${key}"`;
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
  if (!Array.isArray(input.references) || input.references.some((r) => typeof r !== 'string' || !REFERENCE_PATH.test(r))) {
    return 'references must be paths of images directly in references/, as uploads return them';
  }
  if (input.attempt !== undefined && !isInt(input.attempt, 2)) return 'attempt must be 2 or more';
  if (input.retryOf !== undefined && !isInt(input.retryOf, 1)) return 'retryOf must be a request id';
  return null;
}
