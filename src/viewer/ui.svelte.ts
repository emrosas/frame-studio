// What the viewer's Svelte components show, as reactive state. The App class
// (app.ts) owns all the logic and writes here; components read it and call
// ViewerActions. Nothing here touches the canvas (ADR 0002).

import type { StudioRequest } from '../studio/protocol';
import type { FrameRange, RangeText } from './selection';
import type { RequestAction } from './studio-client';

export interface SceneOption {
  key: string;
  label: string;
  file: string;
  invalid: boolean;
}

export interface TimelineReadout {
  frame: number;
  frameCount: number;
  timecode: string;
  endTimecode: string;
}

export interface SelectionState {
  /** Null when no valid scene is showing; the bar is then disabled. */
  sceneId: string | null;
  /** "bear › nose", or empty for no layer. */
  layer: string;
  range: FrameRange | null;
  rangeText: RangeText | null;
  frameCount: number;
  /** A message about the selection, e.g. a layer that vanished in a hot edit. */
  notice: string | null;
}

export interface ErrorBlock {
  source: string;
  title: string;
  lines: readonly string[];
  /** Optional preformatted detail (a stack or code frame). */
  detail?: string;
}

/** What the components can ask the App to do. */
export interface ViewerActions {
  togglePlay(): void;
  scrubStart(): void;
  scrub(frame: number): void;
  scrubEnd(): void;
  selectScene(key: string): void;
  clearLayer(): void;
  clearRange(): void;
  /** Applies a typed range end. Returns an error message and changes nothing when the text is invalid. */
  editRange(end: 'from' | 'to', text: string): string | null;
  /** Queues a request about the current selection, uploading reference images first, and copies its line for the agent. */
  sendRequest(prompt: string, files: File[]): Promise<{ ok: true; id: number; copied: boolean } | { ok: false; error: string }>;
  /** Cancel, requeue, revert or try again. Returns an error message, or null. */
  requestAction(id: number, action: RequestAction, prompt?: string): Promise<string | null>;
  clearFinished(): Promise<void>;
  /** Brings back a request's selection on the canvas. */
  restoreRequest(id: number): void;
  /** Restores a request's selection and loops its range. */
  viewRequest(id: number): void;
  dismissToast(): void;
}

export interface StudioState {
  /** False without a studio server (a static build); the panel says so. */
  available: boolean;
  requests: StudioRequest[];
  /** Updated every 30 s so stalled requests show up. */
  now: number;
  error: string | null;
}

export interface Toast {
  id: number;
  status: 'done' | 'failed';
  text: string;
}

export class ViewerUi {
  playing = $state(false);
  /** False without a valid scene; the play button is then disabled. */
  canPlay = $state(false);
  timeline = $state<TimelineReadout | null>(null);
  fps = $state<{ scene: number; measured: number | null } | null>(null);
  scenes = $state<SceneOption[]>([]);
  selectedScene = $state<string | null>(null);
  /** The frame range band on the scrubber. */
  band = $state<{ range: FrameRange; frameCount: number } | null>(null);
  selection = $state<SelectionState>({ sceneId: null, layer: '', range: null, rangeText: null, frameCount: 0, notice: null });
  errors = $state<ErrorBlock[]>([]);
  studio = $state<StudioState>({ available: false, requests: [], now: Date.now(), error: null });
  /** A request that just finished, with View to see it. */
  toast = $state<Toast | null>(null);
}
