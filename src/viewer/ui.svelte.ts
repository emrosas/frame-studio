// What the viewer's Svelte components show, as reactive state. The App class
// (app.ts) owns all the logic and writes here; components read it and call
// ViewerActions. Nothing here touches the canvas (ADR 0002).

import type { CheckReport } from '../export/check';
import type { AgentId, AgentStatus, ApprovalDecision, NewScene, NewVideo, QuestionAnswers, StudioRequest, TurnEvent, TurnSettings } from '../studio/protocol';
import type { OpenTarget, ProjectEntry, UpdateState } from './desktop';
import type { KeyLane, KeyMark, KeyTarget, SelectedKey } from './keyframes';
import { readPref } from './prefs';
import type { FrameRange } from './selection';
import type { ClipPlace, VisibleSpan } from './timeline';
import type { RequestAction } from './studio-client';
import type { VoiceLine } from './voice';
import type { SpokenWord } from '../engine/types';

export interface SceneOption {
  key: string;
  label: string;
  file: string;
  invalid: boolean;
  /** The older film it belongs to, in projects/ (M9); null for the project's own videos and scenes. Options group by it. */
  film: string | null;
  /** The film's name, shown as the option's group; null outside a film. */
  group: string | null;
  /** The film's main scene. */
  main: boolean;
  /** A scene draws; a composition arranges (ADR 0013). */
  kind: 'scene' | 'composition';
  /** For a folder scene, the compositions that place it, for "Used in". */
  usedIn: readonly string[];
  /** Its format, for the library's cards; null for an invalid file. */
  format: { size: readonly [number, number]; fps: number; seconds: number; pixel: boolean } | null;
}

/** A project, for New scene in it: the fps and size its scenes share, or null while its project.json has errors. */
export interface ProjectOption {
  id: string;
  name: string;
  fps: number | null;
  size: readonly [number, number] | null;
}

/** What the New dialog makes: a scene, in the folder or in an M9 project, or a video (a composition). */
export type NewWhat = { kind: 'scene'; project: ProjectOption | null } | { kind: 'video' };

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
  /** A valid scene with no layers yet, such as one just made with New scene, or a composition of only such scenes. */
  empty: boolean;
  /** A composition, as against a scene. */
  video: boolean;
  /** 9:16, so platform safe zones apply. */
  vertical: boolean;
}

/** A named moment on the ruler. */
export interface MarkerTick {
  frame: number;
  label: string;
  /** Its place in the scene's markers. */
  index?: number;
  /** It lands on a spoken word (ADR 0016). */
  anchored?: boolean;
}

/** A file in out/, for the library's Renders. */
export interface RenderItem {
  file: string;
  path: string;
  kind: 'video' | 'image' | 'page';
  bytes: number;
  modified: number;
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
  /** A sound file with no words yet can be timed (ADR 0016). */
  canTime?: boolean;
}

/** A timing job on screen (ADR 0016): asking to fetch the model first, working, or why it stopped. */
export type VoiceJob =
  | { status: 'ask'; cue: string; bytes: number; name: string }
  | { status: 'working'; cue: string; id: string | null; stage: string; done: number; total: number }
  | { status: 'error'; cue: string; message: string };

/** A layer's row on the timeline, in frames: its bar, its keys and its overrides. */
export interface LayerRow {
  id: string;
  /** Its key frames inside the scene, for snapping and X. */
  keys: readonly number[];
  overrides: readonly FrameRange[];
  /** It has an opacity track, so `bars` says when it shows. Without one the whole row is its bar. */
  faded: boolean;
  bars: readonly VisibleSpan[];
  /** The row's diamonds: every param's keys, by frame. */
  marks: readonly KeyMark[];
  /** One lane per animated param, shown when the row is selected. */
  lanes: readonly KeyLane[];
}

/** The menu a right-click on the canvas opens: the layers under the pointer, top first. */
export interface StackMenu {
  /** Client position of the click. */
  x: number;
  y: number;
  layers: readonly string[];
  /** The click in scene pixels, sent with the selection. */
  point: { x: number; y: number } | null;
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
  /** Where the clip sits, for dragging it, on a composition. */
  clip?: ClipPlace;
}

export interface TimelineReadout {
  frame: number;
  frameCount: number;
  timecode: string;
  endTimecode: string;
  /** "0:01.00" and the end the same way. */
  clock: string;
  endClock: string;
  /** Length in seconds. */
  seconds: number;
}

export interface SelectionState {
  /** Null when no valid scene is showing; the bar is then disabled. */
  sceneId: string | null;
  /** "bear › nose", or empty for no layer. */
  layer: string;
  /** The placed scene's id when the layer is a scene layer, for Open shot; null otherwise. */
  shot: string | null;
  range: FrameRange | null;
  /** The range in clock time, or the whole length without a range: "0:02–0:04". */
  when: string;
  /** The same in frames, for the tooltip. */
  whenTitle: string;
  /** The scene's rate, for showing other selections in clock time. */
  fps: number;
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

/** The Check panel: idle, running, or finished with a report on one scene. */
export interface CheckState {
  running: { id: string; stage: string; done: number; total: number } | null;
  report: CheckReport | null;
  error: string | null;
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
  /** Times a sound cue's words, asking first if that means a download (ADR 0016). */
  timeVoice(cueId: string): void;
  /** Yes to the download the card asks about. */
  confirmVoice(): void;
  /** Stops a timing job, or puts the card away. */
  cancelVoice(): void;
  /** Saves a cue's words after a drag or a text edit. Resolves false if it was refused. */
  saveWords(cueId: string, words: readonly SpokenWord[]): Promise<boolean>;
  /** Ties the selected key or marker to a spoken word. */
  anchorToWord(cueId: string, wordId: string): void;
  /** Marks a marker as what Delete, Anchor and the arrows would act on. */
  selectMarker(index: number | null): void;
  /** The loudest sample in each of `buckets` slices of seconds [from, to) of a file the scene plays, for its waveform. */
  waveform(file: string, from: number, to: number, buckets: number): Promise<Float32Array | null>;
  /** Creates an empty scene and shows it. Returns an error message, or null. */
  createScene(input: NewScene): Promise<string | null>;
  /** Creates a video, by default with its first scene on its track, and shows it. Returns an error message, or null. */
  createVideo(input: NewVideo): Promise<string | null>;
  /** Shows or hides the library over the stage. Playback stops while it shows. */
  showHome(on: boolean): void;
  /** Sets the frame range from a drag on the ruler; null covers every frame. */
  dragRange(range: FrameRange | null): void;
  /** Moves or trims a clip of the composition on screen. Says why not in the selection bar. Resolves to whether it saved. */
  moveClip(layerId: string, place: ClipPlace): Promise<boolean>;
  /** Starts a drag of keys or a bar. False when they can't move, and the selection bar says why. */
  startKeyDrag(target: KeyTarget): boolean;
  /** Shows the drag: a diamond's frame, or the frames a bar or fade moved. */
  dragKeys(to: number): void;
  /** Ends the drag, saving it or putting it back. */
  endKeyDrag(commit: boolean): void;
  /** Selects a diamond and its layer. */
  selectKey(key: SelectedKey | null): void;
  /** Removes a diamond's keys. */
  deleteKey(key: SelectedKey): void;
  /** Applies ui.layout.safeZones. */
  syncGuides(): void;
  /** Shows a file from out/ in Finder (the app only). */
  revealRender(path: string): void;
  /** Selects a layer from a row, a band or the @ list. `span` is what X marks, when a click landed on one. */
  selectLayer(layerId: string, span?: FrameRange): void;
  /** Sets the layer and the range together, from a drag on a row. A null layer leaves the layer as it was. */
  selectRange(layerId: string | null, range: FrameRange): void;
  /** Marks a sound cue's span for X. A cue isn't a layer, so the selection becomes the whole scene. */
  selectCue(id: string, span: FrameRange): void;
  /** Picks from the right-click menu. */
  pickStack(layerId: string): void;
  /** A row or band under the pointer lights up on the canvas too. */
  hoverLayer(layerId: string | null): void;
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
  /** Checks the whole scene on screen. Returns an error message, or null. */
  startCheck(loop: boolean): Promise<string | null>;
  cancelCheck(): void;
  /** The token's x: clears the layer and the range. */
  clearSelection(): void;
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
  /** Shows a thread in the panel, loading its turns' events; null goes to a new thread. */
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
  /** The recent projects with what they hold and their threads' status (ADR 0013); empty in a browser. */
  projects(): Promise<ProjectEntry[]>;
  /** Takes a recent project off the list. The folder is left alone. */
  forgetProject(path: string): Promise<void>;
  /** Shows the stage as opening `name`, then switches the app to that recent project, on `target` when given. Returns why it failed, or null. */
  openProject(path: string, name: string, target?: OpenTarget): Promise<string | null>;
  /** Makes a new project, asking for its name and place, and switches to it. Returns why it failed, or null. */
  newProject(): Promise<string | null>;
  /**
   * Converts a film in projects/, in this project or a listed one (`project`, its path), into a project folder
   * of its own (ADR 0013). The app asks where and switches to it; a browser writes it beside this folder.
   * Resolves to a message to show, or null.
   */
  convertFilm(id: string, project?: string): Promise<{ text: string; error: boolean } | null>;
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

export interface Layout {
  sidebar: boolean;
  panel: boolean;
  /** The dock's height when you've dragged it, else it fits what's on the timeline. */
  dock: number | null;
  /** How the clock reads: "0:01.00" or MM:SS:FF. */
  clock: 'time' | 'timecode';
  safeZones: boolean;
  /** What the sidebar lists. */
  side: 'footage' | 'threads';
}

function savedLayout(): Layout {
  const fallback: Layout = { sidebar: true, panel: true, dock: null, clock: 'time', safeZones: false, side: 'footage' };
  try {
    const saved = JSON.parse(readPref(LAYOUT_KEY) ?? '{}') as Partial<Layout>;
    return {
      sidebar: saved.sidebar !== false,
      panel: saved.panel !== false,
      dock: typeof saved.dock === 'number' ? saved.dock : null,
      clock: saved.clock === 'timecode' ? 'timecode' : 'time',
      safeZones: saved.safeZones === true,
      side: saved.side === 'threads' ? 'threads' : 'footage',
    };
  } catch {
    // storage unavailable or unreadable
    return fallback;
  }
}

/** Which finished turns you've looked at: the time of the newest turn seen, by thread (`seenKey`). */
export const SEEN_KEY = 'frame-studio:threads-seen';

function savedSeen(): Record<string, string> {
  try {
    return JSON.parse(readPref(SEEN_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export class ViewerUi {
  playing = $state(false);
  /** False without a valid scene; the play button is then disabled. */
  canPlay = $state(false);
  timeline = $state<TimelineReadout | null>(null);
  /** The scene's frame rate. */
  fps = $state<number | null>(null);
  sound = $state<SoundState | null>(null);
  scenes = $state<SceneOption[]>([]);
  projects = $state<ProjectOption[]>([]);
  /** The format project.json gives new scenes and compositions (ADR 0013), where it gives one. */
  format = $state<{ fps?: number; size?: readonly [number, number] }>({});
  /** The project has no scenes yet, so the library offers to start one. */
  emptyProject = $state(false);
  /** The New dialog, when it's open. */
  newRequest = $state<NewWhat | null>(null);
  /** The library shows over the stage. */
  home = $state(false);
  /** You came to the library from a scene, so it offers the way back. False when the project opened on it. */
  homeReturn = $state(false);
  /** Each scene's poster file under .frame-studio/thumbs/, or null until it has one. */
  thumbs = $state.raw<Record<string, string | null>>({});
  /** The files in out/, newest first. */
  renders = $state.raw<RenderItem[]>([]);
  /** The scene's and composition's named moments, on the ruler. */
  markers = $state.raw<MarkerTick[]>([]);
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
  /** The project the app is switching to, while the stage waits: its name, and the row or thread picked. */
  switching = $state<{ name: string; key: string | null; path: string; thread: number | null } | null>(null);
  /** The app's update, when it has one to offer or is installing it; null in a browser. */
  update = $state<UpdateState | null>(null);
  /** The frame range band on the scrubber. */
  band = $state<{ range: FrameRange; frameCount: number } | null>(null);
  /** Shot bands under the scrubber, on a scene that places shots. */
  shots = $state<{ bands: ShotBand[]; lanes: number; frameCount: number; locked: boolean } | null>(null);
  /** The scene a shot was opened from, for the link back. */
  back = $state<{ key: string; label: string } | null>(null);
  exporting = $state<ExportState>({ open: false, running: null, result: null, canReveal: false });
  checking = $state<CheckState>({ running: null, report: null, error: null });
  selection = $state<SelectionState>({ sceneId: null, layer: '', shot: null, range: null, when: '', whenTitle: '', fps: 1, frameCount: 0, notice: null });
  /** The selected layer's id. On its own, since ui.selection is replaced many times a second while playing. */
  layerId = $state<string | null>(null);
  /** The layer under the pointer, on the canvas or on a row. */
  hoverLayer = $state<string | null>(null);
  /** The sound cue clicked last, until the selection moves on. */
  cue = $state<string | null>(null);
  /** The diamond selected on the timeline. */
  selectedKey = $state.raw<SelectedKey | null>(null);
  /** Whether keys can be edited: on, locked while an agent works on the scene, or off where the timeline shows clips. */
  keyEdit = $state<'on' | 'locked' | 'off'>('off');
  /** The sound cues with words, as voice rows under the layers (ADR 0016). */
  voices = $state<readonly VoiceLine[]>([]);
  voiceJob = $state<VoiceJob | null>(null);
  /** Which marker is selected, by its place in `markers`. */
  selectedMarker = $state<number | null>(null);
  /** The rows of the scene on screen, top of the stack first, then the background. */
  layers = $state.raw<LayerRow[]>([]);
  /** The right-click menu, when it's open. */
  stackMenu = $state.raw<StackMenu | null>(null);
  /** The token shows its From and To fields. */
  rangeEditing = $state(false);
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
  /** Finished turns you've looked at (SEEN_KEY). Raw, and replaced when one is added. */
  threadsSeen = $state.raw(savedSeen());
  /** A request that just finished, with View to see it. */
  toast = $state<Toast | null>(null);
}
