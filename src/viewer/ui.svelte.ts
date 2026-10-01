// What the viewer's Svelte components show, as reactive state. The App class
// (app.ts) owns all the logic and writes here; components read it and call
// ViewerActions. Nothing here touches the canvas (ADR 0002).

import type { AgentId, AgentStatus, ApprovalDecision, NewProject, NewScene, QuestionAnswers, StudioRequest, TurnEvent, TurnSettings } from '../studio/protocol';
import type { UpdateState } from './desktop';
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

/** A project, for New scene in it: the fps and size its scenes share, or null while its project.json has errors. */
export interface ProjectOption {
  id: string;
  name: string;
  fps: number | null;
  size: readonly [number, number] | null;
}

/** What the New dialog makes: a scene, loose or in a project, or a project. */
export type NewWhat = { kind: 'scene'; project: ProjectOption | null } | { kind: 'project' };

/** The scene on screen, for the header: its name in its project, and its format. */
export interface SceneHeader {
  key: string;
  /** The scene's name without its project, e.g. "film". */
  name: string;
  /** The project's name, or null for a loose scene. */
  project: string | null;
  size: readonly [number, number] | null;
  fps: number | null;
  /** Length in frames; 0 for an invalid scene. */
  frames: number;
  /** A valid scene with no layers yet, such as one just made with New scene. */
  empty: boolean;
}

/** A sound file in the studio folder, for the Media list (ADR 0012). */
export interface MediaItem {
  file: string;
  /** The file's name without media/. */
  name: string;
  /** Seconds, when its header says. */
  duration?: number;
}

/** A sound cue of the scene on screen, on the timeline under the shots (ADR 0012). */
export interface SoundBand {
  id: string;
  /** The file's name, or the generator's id. */
  label: string;
  from: number;
  to: number;
  lane: number;
  /** For a sound file: the file, and the seconds of it the cue plays, for its waveform. */
  file?: { path: string; from: number; to: number };
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
  result: { file: string; note?: string } | { error: string } | null;
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
  /** Uploads sound files into media/ (ADR 0012). Returns an error message, or null. */
  importMedia(files: File[]): Promise<string | null>;
  /** Places a sound file at the playhead of the scene on screen. Returns an error message, or null. */
  placeSound(file: string): Promise<string | null>;
  /** The loudest sample in each of `buckets` slices of seconds [from, to) of a file the scene plays, for its waveform. */
  waveform(file: string, from: number, to: number, buckets: number): Promise<Float32Array | null>;
  /** Creates an empty scene and shows it. Returns an error message, or null. */
  createScene(input: NewScene): Promise<string | null>;
  /** Creates a project with an empty main scene and shows that scene. Returns an error message, or null. */
  createProject(input: NewProject): Promise<string | null>;
  /** Selects a shot's scene layer and its span, from its band on the scrubber. */
  selectShot(layerId: string): void;
  /** Opens a shot (the selected one by default) at the matching frame. */
  openShot(layerId?: string): void;
  /** Back to the scene a shot was opened from. */
  back(): void;
  /** Shows or hides the Export panel. */
  toggleExport(open?: boolean): void;
  /** Exports the scene on screen, or only the selected range. */
  startExport(target: 'mp4' | 'gif' | 'html', options: { range: boolean; sound: boolean; media?: boolean }): Promise<string | null>;
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
  /** Answers a question card, or skips it with null. Returns an error message, or null. */
  answer(id: number, card: string, answers: QuestionAnswers | null): Promise<string | null>;
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
  /** Switches the app to another studio folder (the app only). */
  openFolder(): void;
  /** Downloads and installs the update on offer, then restarts (the app only). */
  installUpdate(): void;
  /** Checks for an update now (the app only). */
  checkForUpdate(): void;
  /** Opens the update's release notes (the app only). */
  openUpdateNotes(): void;
}

export interface StudioState {
  requests: StudioRequest[];
  /** Updated every 30 s so stalled requests show up. */
  now: number;
  error: string | null;
  /** The external agent and the agents the studio runs, as the picker offers them. */
  agents: AgentStatus[];
  /** The thread open in the agent panel, or null for a new thread. */
  open: number | null;
}

export interface Toast {
  id: number;
  /** A turn ended, or one waits on the user: a question card or an approval (ADR 0011). */
  status: 'done' | 'failed' | 'interrupted' | 'asking';
  text: string;
}

/** Where the layout is saved between visits. */
export const LAYOUT_KEY = 'frame-studio:layout';

function savedLayout(): { sidebar: boolean; panel: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as { sidebar?: unknown; panel?: unknown };
    return { sidebar: saved.sidebar !== false, panel: saved.panel !== false };
  } catch {
    // storage unavailable or unreadable; both columns show
    return { sidebar: true, panel: true };
  }
}

export class ViewerUi {
  playing = $state(false);
  /** False without a valid scene; the play button is then disabled. */
  canPlay = $state(false);
  timeline = $state<TimelineReadout | null>(null);
  fps = $state<{ scene: number; measured: number | null } | null>(null);
  sound = $state<SoundState | null>(null);
  scenes = $state<SceneOption[]>([]);
  projects = $state<ProjectOption[]>([]);
  /** The studio folder's sound files (ADR 0012). */
  media = $state<MediaItem[]>([]);
  /** What the last import or Add at playhead did, for the Media list. */
  mediaNote = $state<{ text: string; error: boolean } | null>(null);
  /** The scene on screen plays sound files, so the HTML export can offer to carry them. */
  usesMedia = $state(false);
  /** The scene's sound cues on the timeline, or null without any. */
  sounds = $state<{ bands: SoundBand[]; lanes: number; frameCount: number } | null>(null);
  selectedScene = $state<string | null>(null);
  /** The scene on screen, for the header. */
  header = $state<SceneHeader | null>(null);
  /** The studio folder: its path, and whether the app can switch it. */
  folder = $state<{ path: string; canSwitch: boolean } | null>(null);
  /** The app's update, when it has one to offer or is installing it; null in a browser. */
  update = $state<UpdateState | null>(null);
  /** The frame range band on the scrubber. */
  band = $state<{ range: FrameRange; frameCount: number } | null>(null);
  /** Shot bands under the scrubber, on a scene that places shots. */
  shots = $state<{ bands: ShotBand[]; lanes: number; frameCount: number } | null>(null);
  /** The scene a shot was opened from, for the link back. */
  back = $state<{ key: string; label: string } | null>(null);
  exporting = $state<ExportState>({ open: false, running: null, result: null, canReveal: false });
  selection = $state<SelectionState>({ sceneId: null, layer: '', shot: null, range: null, rangeText: null, frameCount: 0, notice: null });
  errors = $state<ErrorBlock[]>([]);
  studio = $state<StudioState>({ requests: [], now: Date.now(), error: null, agents: [], open: null });
  /**
   * Which side columns show, as last left (Viewer.svelte saves it). The App reads it, so a thread that ends while
   * the agent panel is hidden still gets its notice.
   */
  layout = $state(savedLayout());
  /**
   * Each turn's events so far, keyed "id:turn": pushed ones for every thread, and saved ones for threads
   * opened. Raw, and replaced rather than changed, since a long turn has thousands of events.
   */
  turnEvents = $state.raw<Record<string, TurnEvent[]>>({});
  /** A request that just finished, with View to see it. */
  toast = $state<Toast | null>(null);
}
