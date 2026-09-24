// The viewer's side of the studio server protocol (ADR 0001, ADR 0003): HTTP
// calls to /__studio/ and the queue the server pushes over Vite's websocket.
// Under a build with no studio server (the static viewer), `available` is
// false and the request panel says why.

import { QUEUE_EVENT, type CurrentSelection, type NewRequest, type StudioRequest } from '../studio/protocol';

const BASE = '/__studio';

export type RequestAction = 'cancel' | 'requeue' | 'revert' | 'retry';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The studio server answered ${res.status}.`);
  return data;
}

const jsonBody = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

export class StudioClient {
  /** The studio server exists only under the dev server, which is also what provides import.meta.hot. */
  readonly available = import.meta.hot !== undefined;

  async queue(): Promise<StudioRequest[]> {
    return (await call<{ requests: StudioRequest[] }>('/queue')).requests;
  }

  /** Calls `listener` with the whole queue whenever it changes on disk. Returns an unsubscribe function. */
  onQueue(listener: (requests: StudioRequest[]) => void): () => void {
    const hot = import.meta.hot;
    if (!hot) return () => {};
    const handler = (data: { requests: StudioRequest[] }) => listener(data.requests);
    hot.on(QUEUE_EVENT, handler);
    return () => hot.off(QUEUE_EVENT, handler);
  }

  async create(request: NewRequest): Promise<StudioRequest> {
    return (await call<{ request: StudioRequest }>('/requests', jsonBody(request))).request;
  }

  async act(id: number, action: RequestAction, prompt?: string): Promise<StudioRequest> {
    return (await call<{ request: StudioRequest }>(`/requests/${id}/${action}`, jsonBody(action === 'retry' ? { prompt } : {}))).request;
  }

  async clearFinished(): Promise<number> {
    return (await call<{ removed: number }>('/requests/clear', jsonBody({}))).removed;
  }

  async setSelection(selection: Omit<CurrentSelection, 'updatedAt'> | null): Promise<void> {
    await call('/selection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection) });
  }

  /** Copies an image into references/ and returns its repo-relative path. */
  async uploadReference(file: File): Promise<string> {
    const path = `/references?name=${encodeURIComponent(file.name || 'pasted.png')}`;
    return (await call<{ path: string }>(path, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })).path;
  }
}
