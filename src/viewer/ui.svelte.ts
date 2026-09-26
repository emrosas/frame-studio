// What the viewer's Svelte components show, as reactive state. The App class
// (app.ts) owns all the logic and writes here; components read it and call
// ViewerActions. Nothing here touches the canvas (ADR 0002).

import type { AgentId, AgentStatus, ApprovalDecision, StudioRequest, TurnEvent, TurnSettings } from '../studio/protocol';
import type { FrameRange, RangeText } from './selection';
import type { RequestAction } from './studio-client';

export interface SceneOption {
  key: string;
  label: string;
  file: string;
  invalid: boolean;
  /** The project's id for a project scene; null for a loose scene. Options group by it. */
  project: string | null;
  /** The project's name, shown as the option's group; null for a loose scene. */
  group: string | null;
  /** The project's main scene. */
  main: boolean;
}

/** A shot on the scrubber: a scene layer's span in the scene on screen (ADR 0007). */
export interface ShotBand {
  layerId: string;
  /** The placed scene's id. */
  label: string;
  from: number;
  to: number;
  /** Row under the track, so overlapping shots (a crossfade) both show. */
  lane: number;
  selected: boolean;
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
  /** The placed scene's id when the layer is a scene layer, for Open shot; null otherwise. */
  shot: string | null;
  range: FrameRange | null;
  rangeText: RangeText | null;
  frameCount: number;
  /** A message about the selection, e.g. a layer that vanished in a hot edit. */
  notice: string | null;
}

/** The Export panel (ADR 0008): closed, set up, running, or finished. */
export interface ExportState {
  open: boolean;
  /** The export running now, with its progress. */
  running: { id: string; stage: string; done: number; total: number } | null;
  /** How the last export ended. */
  result: { file: string } | { error: string } | null;
  /** True in the app, where the finished file can be shown in Finder. */
  canReveal: boolean;
}

/** The scene's sound, for the mute button. Null for a silent scene. */
export interface SoundState {
  /** rendering: the audio is being rendered. locked: the browser waits for a click or key first. */
  status: 'rendering' | 'ready' | 'locked' | 'failed';
  muted: boolean;
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
  toggleMute(): void;
  scrubStart(): void;
  scrub(frame: number): void;
  scrubEnd(): void;
  selectScene(key: string): void;
  /** Selects a shot's scene layer and its span, from its band on the scrubber. */
  selectShot(layerId: string): void;
  /** Opens a shot (the selected one by default) at the matching frame. */
  openShot(layerId?: string): void;
  /** Back to the scene a shot was opened from. */
  back(): void;
  /** Shows or hides the Export panel. */
  toggleExport(open?: boolean): void;
  /** Exports the scene on screen, or only the selected range. */
  startExport(target: 'mp4' | 'gif' | 'html', options: { range: boolean; sound: boolean }): Promise<string | null>;
  cancelExport(): void;
  /** Shows the last export's file in Finder (the app only). */
  revealExport(): void;
  clearLayer(): void;
  clearRange(): void;
  /** Applies a typed range end. Returns an error message and changes nothing when the text is invalid. */
  editRange(end: 'from' | 'to', text: string): string | null;
  /**
   * Starts a thread about the current selection, uploading reference images
   * first. For the external agent it also copies a line to paste into it.
   */
  sendRequest(
    prompt: string,
    files: File[],
    agent: AgentId,
    settings?: TurnSettings,
  ): Promise<{ ok: true; id: number; copied: boolean } | { ok: false; error: string }>;
  /** Replies in a thread, about the current selection when it is on the thread's scene, else the thread's own. */
  reply(id: number, prompt: string, files: File[], settings?: TurnSettings): Promise<string | null>;
  /** Cancel, requeue, settle or stop. Returns an error message, or null. */
  requestAction(id: number, action: RequestAction): Promise<string | null>;
  /** Try again: reverts the newest turn and asks again, with an edited prompt, new images and settings. */
  retry(id: number, prompt: string, files: File[], settings?: TurnSettings): Promise<string | null>;
  /** "Revert to here" on a turn, or with no turn, the whole thread. Returns an error message, or null. */
  revert(id: number, turn?: number): Promise<string | null>;
  /** Answers an approval card. Returns an error message, or null. */
  respond(id: number, approval: string, decision: ApprovalDecision): Promise<string | null>;
  clearFinished(): Promise<void>;
  /** Shows a thread in the panel, loading its turns' events; null goes back to the list. */
  openThread(id: number | null): void;
  /** Brings back a request's selection on the canvas. */
  restoreRequest(id: number): void;
  /** Restores a request's selection and loops its range. */
  viewRequest(id: number): void;
  /** Shows frame n of a thread's scene. */
  showFrame(id: number, frame: number): void;
  /** Asks the studio server again which agents are ready. */
  refreshAgents(): void;
  dismissToast(): void;
}

export interface StudioState {
  /** False without a studio server (a static build); the panel says so. */
  available: boolean;
  requests: StudioRequest[];
  /** Updated every 30 s so stalled requests show up. */
  now: number;
  error: string | null;
  /** The external agent and the agents the studio runs, as the picker offers them. */
  agents: AgentStatus[];
  /** The thread open in the panel, or null for the list. */
  open: number | null;
}

export interface Toast {
  id: number;
  status: 'done' | 'failed' | 'interrupted';
  text: string;
}

export class ViewerUi {
  playing = $state(false);
  /** False without a valid scene; the play button is then disabled. */
  canPlay = $state(false);
  timeline = $state<TimelineReadout | null>(null);
  fps = $state<{ scene: number; measured: number | null } | null>(null);
  sound = $state<SoundState | null>(null);
  scenes = $state<SceneOption[]>([]);
  selectedScene = $state<string | null>(null);
  /** The frame range band on the scrubber. */
  band = $state<{ range: FrameRange; frameCount: number } | null>(null);
  /** Shot bands under the scrubber, on a scene that places shots. */
  shots = $state<{ bands: ShotBand[]; lanes: number; frameCount: number } | null>(null);
  /** The scene a shot was opened from, for the link back. */
  back = $state<{ key: string; label: string } | null>(null);
  exporting = $state<ExportState>({ open: false, running: null, result: null, canReveal: false });
  selection = $state<SelectionState>({ sceneId: null, layer: '', shot: null, range: null, rangeText: null, frameCount: 0, notice: null });
  errors = $state<ErrorBlock[]>([]);
  studio = $state<StudioState>({ available: false, requests: [], now: Date.now(), error: null, agents: [], open: null });
  /**
   * Each turn's events so far, keyed "id:turn": pushed ones for every thread, and saved ones for threads
   * opened. Raw, and replaced rather than changed, since a long turn has thousands of events.
   */
  turnEvents = $state.raw<Record<string, TurnEvent[]>>({});
  /** A request that just finished, with View to see it. */
  toast = $state<Toast | null>(null);
}
