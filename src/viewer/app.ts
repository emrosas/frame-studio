// Viewer controller: owns the selected scene, the playback clock, the canvas,
// the selection (layer, part, frame range) and the HTML overlay. Renders only
// when the frame, the scene, or the canvas size changes.

// The audio modules without the generators, so a generator edit hot-swaps through ./scenes like a rig edit.
import { LivePlayback } from '../audio/live';
import { mediaUsed } from '../audio/media';
import { audioKey, generatorsUsed, hasAudio, renderSceneAudio, sameGenerators } from '../audio/render';
import { mediaUrl, MediaStore } from './media';
import { PictureStore } from '../export/pictures';
import type { AudioGenerator } from '../audio/types';
import {
  formatTimecode,
  frameCount as countFrames,
  hitTest,
  isImageFile,
  picturesAt,
  render,
  sceneLayerSpan,
  sceneLayers,
  shotFrame,
  timeToFrame,
  type HitResult,
  type PictureRequest,
  type HitTestOptions,
  type SceneLayerSpan,
} from '../engine';
import type { Layer, Scene, World } from '../engine/types';
import { createSurfaces } from '../embed/surfaces';
import { CanvasView } from './canvas';
import { PlaybackClock } from './clock';
import { dragDelta, dragScale, landValue, lockAxis, movable, snapCentre, stageCentre, withinBounds, withLayers, writePosition, type DragMoment, type DragScale, type Movable, type Position } from './drag';
import { deleteKeys, keyLanes, keyMarks, keysAt, moveTarget, type KeyTarget, type SelectedKey } from './keyframes';
import { formatClock, visibleSpans, type ClipPlace } from './timeline';
import { ErrorLog, errorText } from './errors';
import { focusKeepsKey, keyAction } from './keys';
import { findEntry, openingEntry, type SceneEntry, type SceneLibrary } from './library';
import { SelectionOverlay } from './overlay';
import { clientToScene, isDrag, type Point } from './pointer';
import { SafeZoneGuide } from './safe-zones';
import {
  editRangeEnd,
  isRepeatClick,
  layerLabel,
  markIn,
  markOut,
  nextCandidate,
  rangeError,
  resolveSelectionParams,
  sceneShape,
  spanLabel,
  spanTitle,
  type ClickMemo,
  type FrameRange,
  type SceneShape,
  type SelectionParams,
} from './selection';
import {
  clipboardLine,
  currentSelection,
  currentTurn,
  type AgentId,
  type CurrentSelection,
  type RequestSelection,
  type StudioRequest,
  type TurnEvent,
  type TurnSettings,
} from '../studio/protocol';
import { desktop } from './desktop';
import { readPref, writePref } from './prefs';
import { StudioClient } from './studio-client';
import type { LayerRow, SceneOption, ShotBand, SoundBand, ViewerActions, ViewerUi } from './ui.svelte';
import { asLayer, EditHistory, layerKey, layerSet, sceneState } from './undo';
import { parseFrameParam, RELOAD_KEY, reloadRecord, UrlSync, type UrlPosition } from './url';

/** window.studio.selection: what is picked, in the shape agent tools take. */
export interface StudioSelection {
  sceneId: string;
  /** Left out when no layer is selected. */
  layerId?: string;
  /** Left out unless a part of the layer is selected. */
  partId?: string;
  /** First frame of the range, included. 0 when no range is set. */
  from: number;
  /** End of the range, excluded. frameCount when no range is set. */
  to: number;
}

/** window.studio: for debugging and for agents driving the page. */
export interface StudioApi {
  /** The selected scene after validation, or null when none is valid. */
  readonly scene: Scene | null;
  /** The frame on screen. */
  readonly frame: number;
  /** Frames in the selected scene; valid frames are [0, frameCount). 0 when no valid scene. */
  readonly frameCount: number;
  readonly playing: boolean;
  /**
   * The scene's sound. status is none for a silent scene; unlocked is false
   * until a click or key lets the browser play; heard is the scene time
   * reaching the speakers, in seconds, or null while nothing plays.
   */
  readonly sound: { status: 'none' | 'rendering' | 'ready' | 'failed'; muted: boolean; unlocked: boolean; heard: number | null };
  /** Scene keys in picker order: loose scenes, then each project's by qualified id. */
  readonly scenes: readonly string[];
  /** Every error the panel is showing, flattened. Empty when all is well. */
  readonly errors: readonly string[];
  readonly canvas: HTMLCanvasElement;
  /** Clamps into range and renders synchronously. Keeps playing if playing. Returns the frame. */
  seek(frame: number): number;
  play(): void;
  pause(): void;
  /** Pauses and renders exactly this frame synchronously. Throws on a bad frame or a render error. */
  renderFrame(frame: number): number;
  /** Selects a scene by id, at frame 0. Throws for an unknown id. Clears the selection. */
  selectScene(id: string): void;
  /**
   * What is picked: { sceneId, layerId?, partId?, from, to }. layerId and
   * partId are left out when not selected. from and to are the frame range
   * [from, to), or the whole scene [0, frameCount) when no range is set.
   * Null when no valid scene is showing.
   */
  readonly selection: StudioSelection | null;
  /** The frame range [from, to) set with I and O, the from and to fields or setRange; null when none is set (all frames) or no valid scene. */
  readonly range: { from: number; to: number } | null;
  /**
   * The engine hit test at scene pixel (x, y) on the frame on screen:
   * { layerId, partId?, candidates }. options.all scans every layer,
   * options.parts also finds the part. Does not change the selection.
   * Throws without a valid scene.
   */
  hitTest(x: number, y: number, options?: HitTestOptions): HitResult;
  /**
   * Selects a layer, and optionally one of the parts its rig declares, and
   * renders the highlight synchronously (on pause, if playing). null clears the layer. Throws for an
   * unknown layer or part, or without a valid scene.
   */
  select(layerId: string | null, partId?: string): void;
  /** Sets the frame range [from, to), to excluded. Throws a RangeError unless both are integers with 0 <= from < to <= frameCount. */
  setRange(from: number, to: number): void;
  /** Clears the frame range, so the selection covers all frames. */
  clearRange(): void;
  /** The shots a project scene places: each scene layer, the scene it shows, and its span [from, to) in this scene's frames. */
  readonly shots: readonly { layerId: string; scene: string; from: number; to: number }[];
  /**
   * Opens the shot a scene layer shows (the selected layer by default) at the frame matching the one on
   * screen, or its first frame shown. Throws when the layer places no scene.
   */
  openShot(layerId?: string): void;
  /** After openShot: back to the scene it came from, at the matching frame. Throws when there is nowhere to go back to. */
  back(): void;
}

export interface AppOptions {
  /** ?scene= from the URL. */
  scene: string | null;
  /** Open on the library: the project opened with nothing selected. */
  home?: boolean;
  /** ?frame= from the URL: a frame number or MM:SS:FF. */
  frame: string | null;
  /** Start playing (restoring play state across a full reload). */
  autoplay: boolean;
  /** ?layer=&part=&from=&to= from the URL, checked against the scene once it is valid. */
  selection?: SelectionParams;
}

/** sessionStorage key: play state carried across Vite's full-reload fallback. */
export const RESUME_KEY = 'frame-studio:resume-playback';

/** Sound muted, kept across reloads, scenes and projects. */
const MUTED_KEY = 'frame-studio:muted';

/** Start of the notice shown when a hover probe throws. */
const HOVER_OFF = 'Hover inspect is off';

type DrawResult = { kind: 'drawn' } | { kind: 'skipped'; reason: string } | { kind: 'failed'; error: unknown };

/** A layer being dragged on the canvas. Nothing is saved until the pointer lifts. */
interface CanvasDrag {
  layerId: string;
  pointerId: number;
  /** Where the press was, client CSS px. */
  start: Point;
  base: Layer;
  next: Layer;
  from: Movable;
  scale: DragScale;
  moment: DragMoment;
  centre: Position;
  guides: { x: boolean; y: boolean } | null;
}

/** How long Left and Right wait before a run of nudges saves, as one edit. */
const NUDGE_SAVE_MS = 250;
/** How long a saved layer stays held if its file never shows that edit, which means someone else's arrived first. */
const HOLD_MS = 2000;

const LOCKED = 'An agent is working on this scene, so it stays put until the agent finishes.';

export class App {
  readonly api: StudioApi;
  private library: SceneLibrary;
  private entry: SceneEntry | null = null;
  private total = 0;
  private readonly clock = new PlaybackClock(() => performance.now());
  private readonly url = new UrlSync();
  private readonly view: CanvasView;
  private readonly ui: ViewerUi;
  /** What the Svelte components call (ui.svelte.ts). */
  readonly actions: ViewerActions;
  private readonly overlay: SelectionOverlay;
  private readonly safeZones: SafeZoneGuide;
  private readonly errors: ErrorLog;
  private raf = 0;
  private canvasDirty = true;
  private uiDirty = true;
  private resumeAfterScrub = false;
  /** Set when a hot edit made the playing scene invalid; playback resumes once it is valid again. */
  private resumeWhenValid = false;
  /** ?frame= waiting for a valid scene to resolve against (it needs fps and frame count). */
  private pendingFrameParam: string | null;
  /** ?scene=, ?frame= and the selection from the URL when no scene matched; shown as an error and opened if the scene appears. */
  private missingRequest: { scene: string; frame: string | null; selection: SelectionParams | null } | null = null;
  /** A scene just created, to show as soon as the library has it. */
  private openWhenLoaded: string | null = null;

  // ---- selection ----
  private layerId: string | null = null;
  private partId: string | null = null;
  private rangeValue: FrameRange | null = null;
  /** The span X marks when a click landed on one: a clip, an override, a sound cue. */
  private pickedSpan: FrameRange | null = null;
  /** A row or band under the pointer, which outranks the canvas's hover. */
  private rowHover: string | null = null;
  /** The selected frame range. Playback loops inside it while it is set. */
  private get range(): FrameRange | null {
    return this.rangeValue;
  }
  private set range(range: FrameRange | null) {
    this.rangeValue = range;
    this.clock.setLoopRange(range);
  }
  /** Shown in the selection bar until the selection next changes. */
  private notice: string | null = null;
  /** ?layer=&part=&from=&to= waiting for a valid scene to be checked against. */
  private pendingSelection: SelectionParams | null;
  /** Layers and parts of the valid scene on screen; null when none. */
  private shape: SceneShape | null = null;
  /** Bumped on every scene swap, so cached masks and click cycles never outlive an edit. */
  private version = 0;
  private probe: OffscreenCanvasRenderingContext2D | null = null;
  /** Offscreen surfaces for masks and faded shots (ADR 0007). */
  private readonly surfaces = createSurfaces();
  /** Decoded picture clips (ADR 0014). A draw shows the nearest ready frame and asks for the exact one. */
  private readonly pictures = new PictureStore(mediaUrl);
  private picturesWanted = '';
  private picturesNext: PictureRequest[] | null = null;
  private picturesBusy = false;
  /** Pointer over the canvas, client CSS px; null when outside. */
  private pointer: Point | null = null;
  private downAt: Point | null = null;
  /** Where a press on the letterbox (the stage itself, not the canvas) started. */
  private stageDownAt: Point | null = null;
  private stageElement!: HTMLElement;
  private clickMemo: ClickMemo | null = null;
  private hoverLayer: string | null = null;
  private hoverDirty = false;
  /** Escape hides the hover until the pointer moves. */
  private hoverHidden = false;
  /** The frame on which a hover probe threw; hover skips that frame only, until the next scene swap. */
  private hoverFailedFrame: number | null = null;
  private scrubbing = false;
  /** Hand edits, for Command-Z. */
  private readonly history = new EditHistory();
  private historySteps: Promise<unknown> = Promise.resolve();

  // ---- hand edits (ADR 0015) ----
  /** Layers on screen ahead of their files: a drag under way, or a save on its way back. */
  private readonly held = new Map<string, Layer>();
  private heldVersion = 0;
  private heldScene: { base: Scene; version: number; scene: Scene } | null = null;
  private keyDrag: { target: KeyTarget; base: Layer; next: Layer } | null = null;
  /** Nudges not saved yet. */
  private nudge: { base: Layer; next: Layer; timer: ReturnType<typeof setTimeout> } | null = null;
  private canvasDrag: CanvasDrag | null = null;
  /** This press has looked for something to drag. */
  private pressLooked = false;
  /** The press became a drag, so the click it ends in selects nothing. */
  private pressDragged = false;
  /** The pointer is over the selected layer, and it can move. */
  private overMovable = false;
  /** Layers already told "Position is set by this rig". */
  private readonly toldFixed = new Set<string>();

  // ---- shots (ADR 0007) ----
  /** Where Open shot came from, so Back returns there. Any other scene switch forgets it. */
  private shotReturn: { key: string; layerId: string; span: SceneLayerSpan; frame: number } | null = null;

  // ---- sound (M7) ----
  private readonly sound = new LivePlayback(() => new AudioContext({ latencyHint: 'interactive' }));
  /** What the rendered sound was made from: the cues, and the generator objects they use. A change to either renders again. */
  private soundFor: { key: string; generators: (AudioGenerator | undefined)[] } | null = null;
  private soundStatus: 'none' | 'rendering' | 'ready' | 'failed' = 'none';

  // ---- handoff to the agent (ADR 0003) ----
  private readonly studio = new StudioClient();
  /** Decoded sound files (ADR 0012), kept while they don't change. */
  readonly media = new MediaStore();
  /** Where the click that picked the layer landed, in scene pixels; sent with the selection. */
  private selectionPoint: Point | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private requests: StudioRequest[] = [];
  /** Turns whose saved events were fetched, "id:turn". */
  private readonly loadedTurns = new Set<string>();

  /**
   * `root` holds the mounted Viewer.svelte, whose .stage and .stage-frame the
   * canvas and overlay go into. `ui` is the state its components show.
   */
  constructor(root: HTMLElement, library: SceneLibrary, options: AppOptions, ui: ViewerUi) {
    this.library = library;
    this.ui = ui;
    this.pendingFrameParam = options.frame;
    const sel = options.selection;
    this.pendingSelection = sel && (sel.layer ?? sel.part ?? sel.from ?? sel.to) !== null ? sel : null;

    const stage = root.querySelector<HTMLElement>('.stage');
    const frame = root.querySelector<HTMLElement>('.stage-frame');
    if (!stage || !frame) throw new Error('The viewer layout is missing .stage or .stage-frame.');

    this.actions = {
      togglePlay: () => this.togglePlay(),
      toggleMute: () => this.toggleMute(),
      scrubStart: () => {
        this.resumeAfterScrub = this.clock.playing;
        this.pauseInternal();
        this.scrubbing = true;
        this.hoverLayer = null;
      },
      scrub: (f) => this.seekInternal(f, false),
      scrubEnd: () => {
        this.scrubbing = false;
        this.requestHover();
        if (this.resumeAfterScrub) this.playInternal();
        this.resumeAfterScrub = false;
      },
      selectScene: (key) => {
        const next = findEntry(this.library, key);
        // The scene already behind the library opens as it was left.
        if (next && next === this.entry && this.ui.home) this.setHome(false);
        else if (next) this.userSelect(next);
      },
      importMedia: (files) =>
        attempt(async () => {
          for (const file of files) await this.studio.uploadMedia(file);
        }),
      placeSound: (file) =>
        attempt(async () => {
          const scene = this.validScene();
          if (!scene || !this.entry) throw new Error('No valid scene is showing.');
          await this.studio.placeSound(this.entry.key, file, this.clock.frame / scene.fps);
          this.setHome(false);
        }),
      waveform: (file, from, to, buckets) => this.media.peaks(file, from, to, buckets),
      createScene: (input) => this.create(() => this.studio.createScene(input)),
      createVideo: (input) => this.create(() => this.studio.createVideo(input)),
      showHome: (on) => {
        if (on && !this.ui.home) this.ui.homeReturn = this.library.entries.length > 0;
        this.setHome(on);
      },
      dragRange: (range) => {
        this.userSetRange(range);
        this.flushNow();
      },
      moveClip: (layerId, place) => this.moveClip(layerId, place),
      startKeyDrag: (target) => this.startKeyDrag(target),
      dragKeys: (to) => this.dragKeys(to),
      endKeyDrag: (commit) => this.endKeyDrag(commit),
      selectKey: (key) => {
        if (key && key.layerId !== this.layerId) this.pick(key.layerId, null);
        this.ui.selectedKey = key;
        this.flushNow();
      },
      deleteKey: (key) => this.deleteKey(key),
      syncGuides: () => this.syncOverlay(),
      revealRender: (path) => void desktop()?.reveal(path),
      selectLayer: (layerId, span) => {
        this.pick(layerId, span ?? null);
        this.flushNow();
      },
      selectRange: (layerId, range) => {
        this.pick(layerId, null);
        this.userSetRange(range.from === 0 && range.to === this.total ? null : range);
        this.flushNow();
      },
      selectCue: (id, span) => {
        this.pick(null, span);
        this.ui.cue = id;
        this.flushNow();
      },
      pickStack: (layerId) => {
        const point = this.ui.stackMenu?.point ?? null;
        this.ui.stackMenu = null;
        this.pick(layerId, null);
        this.selectionPoint = point ? { x: Math.round(point.x), y: Math.round(point.y) } : null;
        this.flushNow();
      },
      hoverLayer: (layerId) => {
        if (layerId === this.rowHover) return;
        this.rowHover = layerId;
        this.uiDirty = true;
        this.flushNow();
      },
      openShot: (layerId) => this.say(this.openShot(layerId)),
      back: () => this.say(this.back()),
      toggleExport: (open) => {
        this.ui.exporting = { ...this.ui.exporting, open: open ?? !this.ui.exporting.open };
      },
      startExport: (target, options) => this.startExport(target, options),
      cancelExport: () => {
        const running = this.ui.exporting.running;
        if (running) void this.studio.cancelExport(running.id).catch(() => {});
      },
      revealExport: () => {
        const result = this.ui.exporting.result;
        if (result && 'file' in result) void desktop()?.reveal(result.file);
      },
      startCheck: (loop) => this.startCheck(loop),
      cancelCheck: () => {
        const running = this.ui.checking.running;
        if (running) void this.studio.cancelCheck(running.id).catch(() => {});
      },
      clearSelection: () => {
        this.ui.rangeEditing = false;
        this.clickMemo = null;
        this.userSetLayer(null, null);
        this.userSetRange(null);
        this.flushNow();
      },
      editRange: (end, text) => {
        const scene = this.validScene();
        if (!scene) return 'no valid scene is showing';
        const edit = editRangeEnd(this.range, end, text, scene.fps, this.total);
        if (!edit.ok) return edit.error;
        this.userSetRange(edit.range);
        this.flushNow();
        return null;
      },
      sendRequest: (prompt, files, agent, settings) => this.sendRequest(prompt, files, agent, settings),
      reply: (id, prompt, files, settings) => this.reply(id, prompt, files, settings),
      requestAction: (id, action) => attempt(() => this.studio.act(id, action)),
      retry: (id, prompt, files, settings) =>
        attempt(async () => {
          const references: string[] = [];
          for (const file of files) references.push(await this.studio.uploadReference(file));
          const thread = this.requests.find((r) => r.id === id);
          await this.studio.retry(id, {
            prompt,
            ...(references.length > 0 ? { references } : {}),
            ...(thread && thread.agent !== 'external' && settings ? { settings } : {}),
          });
        }),
      revert: (id, turn) => attempt(() => this.studio.revert(id, turn)),
      respond: (id, approval, decision) => attempt(() => this.studio.respond(id, approval, decision)),
      answer: (id, card, answers) => attempt(() => this.studio.answer(id, card, answers)),
      clearFinished: async () => {
        await this.studio.clearFinished().catch(() => {});
      },
      openThread: (id) => this.openThread(id),
      restoreRequest: (id) => this.restoreRequest(id, false),
      viewRequest: (id) => this.restoreRequest(id, true),
      showFrame: (id, frame) => {
        this.restoreRequest(id, false);
        this.pauseInternal();
        this.seekInternal(frame, true);
      },
      refreshAgents: () => this.refreshAgents(true),
      dismissToast: () => (this.ui.toast = null),
      openFolder: () => void desktop()?.openFolder(),
      projects: async () => (await desktop()?.projects().catch(() => [])) ?? [],
      openProject: async (path, name, target) => {
        this.pauseInternal();
        this.ui.switching = { name, key: target?.scene ?? null, path };
        const problem = (await desktop()?.openProject(path, target).catch((err: unknown) => errorText(err).message)) ?? null;
        // On success the page goes; on failure, or a project that's refused, the stage comes back.
        if (problem) this.ui.switching = null;
        return problem;
      },
      forgetProject: async (path) => {
        await desktop()?.forgetProject(path).catch(() => {});
      },
      newProject: async () => (await desktop()?.newProject().catch((err: unknown) => errorText(err).message)) ?? null,
      convertFilm: async (id, project) => {
        const app = desktop();
        try {
          if (app) {
            const problem = await app.convertFilm(id, project);
            return problem ? { text: problem, error: true } : null;
          }
          const path = await this.studio.convertFilm(id);
          return { text: `Converted into ${path}. Open that folder to work on it.`, error: false };
        } catch (err) {
          return { text: errorText(err).message, error: true };
        }
      },
      installUpdate: () => void desktop()?.updates?.install(),
      checkForUpdate: () => void desktop()?.updates?.check(),
      openUpdateNotes: () => void desktop()?.updates?.openNotes(),
    };
    // The app pushes where its update stands; a browser has none.
    const updates = desktop()?.updates;
    if (updates) {
      updates.onChange((state) => (this.ui.update = state));
      void updates.state().then((state) => (this.ui.update = state));
    }
    this.view = new CanvasView(
      stage,
      () => {
        this.drawNow();
        this.syncOverlay();
      },
      frame,
    );
    this.overlay = new SelectionOverlay(frame);
    this.safeZones = new SafeZoneGuide(frame);
    this.errors = new ErrorLog((blocks) => (this.ui.errors = blocks));

    // The letterbox around the canvas is outside the scene: a click there clears the layer.
    this.stageElement = stage;
    stage.addEventListener('pointerdown', this.onStagePointerDown);
    stage.addEventListener('click', this.onStageClick);

    const canvas = this.view.canvas;
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown);
    canvas.addEventListener('click', this.onCanvasClick);
    canvas.addEventListener('dblclick', this.onCanvasDoubleClick);
    canvas.addEventListener('contextmenu', this.onCanvasContextMenu);
    canvas.addEventListener('pointermove', this.onCanvasPointerMove);
    canvas.addEventListener('pointerup', this.onCanvasPointerUp);
    canvas.addEventListener('pointercancel', this.onCanvasPointerCancel);
    canvas.addEventListener('pointerleave', this.onCanvasPointerLeave);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pagehide', this.onPageHide);
    // Browsers hold sound back until the person interacts. A mouse press, the end of a touch or pen
    // tap, a click or a key lets it start (HTML's activation-triggering events).
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown']) window.addEventListener(type, this.unlockSound, true);
    this.sound.setMuted(readMuted());

    const { entry: initial, missing } = openingEntry(library, options.scene);
    if (missing && options.scene !== null) {
      this.missingRequest = { scene: options.scene, frame: options.frame, selection: this.pendingSelection };
      this.pendingFrameParam = null;
      this.pendingSelection = null;
    }
    // Before the first scene shows, so the URL never carries one the project didn't open on.
    this.ui.home = options.home ?? false;
    this.selectEntry(initial, false);
    if (options.autoplay && !this.ui.home) this.playInternal();

    this.api = this.createApi();
    this.startQueue();
    this.refreshMedia();
    this.refreshThumbs();
    void this.refreshRenders();
  }

  // ---- the library ----

  /**
   * Shows or hides the library. While it shows, playback stops and the canvas isn't redrawn: it's under the
   * library, and anything marked dirty meanwhile draws when it closes. It can't close on a project with nothing to show.
   */
  private setHome(on: boolean): void {
    if (on === this.ui.home || (!on && this.library.entries.length === 0)) return;
    if (on) {
      this.pauseInternal();
      this.ui.exporting = { ...this.ui.exporting, open: false };
    }
    // Set by the showHome action; the App's own calls open the library with nothing to go back to.
    this.ui.home = on;
    if (on) void this.refreshRenders();
    else this.invalidate();
    this.syncUrl();
  }

  private thumbTimer: ReturnType<typeof setTimeout> | null = null;

  /** Asks where the posters stand, a moment after the last change, so a burst of edits asks once. */
  private refreshThumbs(): void {
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = null;
      this.studio.thumbs().then(
        (thumbs) => {
          // A scene keeps the poster it has until its new one arrives.
          const known = this.ui.thumbs;
          this.ui.thumbs = Object.fromEntries(Object.entries(thumbs).map(([key, file]) => [key, file ?? known[key] ?? null]));
        },
        () => {},
      );
    }, 600);
  }

  private async refreshRenders(): Promise<void> {
    this.ui.renders = await this.studio.renders().catch(() => this.ui.renders);
  }

  /** Saves a dragged clip. Whatever refuses it says why in the selection bar, and the file stays as it was. */
  private isPictureClip(layerId: string): boolean {
    return this.validScene()?.layers.some((l) => l.id === layerId && l.file !== undefined) ?? false;
  }

  /** Saves run one at a time, and undo waits in line behind them, or a quick Command-Z would find nothing to take back. */
  private inLine<T>(step: () => Promise<T>): Promise<T> {
    const run = this.historySteps.then(step);
    this.historySteps = run.catch(() => {});
    return run;
  }

  private moveClip(layerId: string, place: ClipPlace): Promise<boolean> {
    return this.inLine(() => this.saveClip(layerId, place));
  }

  /** Where a clip sits now, from the composition on screen. */
  private clipPlace(layerId: string): ClipPlace | null {
    const shot = this.shots().find((s) => s.layerId === layerId);
    return shot ? { from: shot.span.from, in: shot.span.in, out: shot.end, length: shot.length } : null;
  }

  private async saveClip(layerId: string, place: ClipPlace): Promise<boolean> {
    const scene = this.validScene();
    if (!scene || !this.entry) return false;
    const { fps } = scene;
    const key = this.entry.key;
    const edit = { start: place.from / fps, in: place.in / fps, out: place.out >= place.length && !this.isPictureClip(layerId) ? null : place.out / fps };
    const spanOf = (p: ClipPlace): FrameRange => ({ from: p.from, to: Math.min(this.total, p.from + p.out - p.in) });
    const was = this.clipPlace(layerId);
    const spans = was ? { before: spanOf(was), after: spanOf(place) } : undefined;
    this.history.begin();
    try {
      const change = await this.studio.moveClip(key, { clip: layerId, ...edit });
      this.history.record(key, { layerId, ...change, spans });
      this.rangeFollows(spans?.before, spans?.after);
      return true;
    } catch (err) {
      this.say(errorText(err).message);
      return false;
    } finally {
      this.history.end();
    }
  }

  /** A range marked on a clip stays on the clip. */
  private rangeFollows(was: FrameRange | undefined, now: FrameRange | undefined): void {
    if (was && now && this.range?.from === was.from && this.range.to === was.to) this.userSetRange(now);
  }

  /** Command-Z, one at a time, so quick presses all count. Nothing happens while an agent works on the scene. */
  private stepHistory(direction: 'undo' | 'redo'): void {
    this.saveNudge();
    void this.inLine(async () => {
      if (!this.entry || this.agentWorks()) return;
      const key = this.entry.key;
      const edit = direction === 'undo' ? this.history.undo() : this.history.redo();
      if (!edit) return;
      const [to, from] = direction === 'undo' ? [edit.before, edit.after] : [edit.after, edit.before];
      const layer = asLayer(edit.layerId, to);
      this.ui.selectedKey = null;
      this.hold(layer);
      this.history.begin();
      try {
        await this.studio.editLayer({ scene: key, layer: edit.layerId, set: layerSet(from, to) });
        this.letGo(layer);
        const spans = edit.spans;
        if (spans) this.rangeFollows(direction === 'undo' ? spans.after : spans.before, direction === 'undo' ? spans.before : spans.after);
      } catch (err) {
        this.say(errorText(err).message);
        this.unhold(edit.layerId);
        this.history.clear();
      } finally {
        this.history.end();
      }
    });
  }

  private agentWorks(): boolean {
    return this.requests.some((r) => r.sceneId === this.entry?.key && r.status === 'working');
  }

  // ---- hand edits (ADR 0015) ----

  /** The scene as the viewer shows it: the file, with any held layers in place. */
  private shownScene(): Scene | null {
    const scene = this.entry?.scene ?? null;
    if (!scene || this.held.size === 0) return scene;
    if (this.heldScene?.base !== scene || this.heldScene.version !== this.heldVersion) {
      this.heldScene = { base: scene, version: this.heldVersion, scene: withLayers(scene, this.held) };
    }
    return this.heldScene.scene;
  }

  private shownLayer(id: string): Layer | null {
    const scene = this.shownScene();
    return scene ? (sceneLayers(scene).find((l) => l.id === id) ?? null) : null;
  }

  /** Shows `layer` ahead of its file. */
  private hold(layer: Layer): void {
    this.held.set(layer.id, layer);
    this.heldChanged(layer.id);
  }

  private unhold(id: string): void {
    if (this.held.delete(id)) this.heldChanged(id);
  }

  /** A save answered: the file comes next. If it shows something else by then, someone else's edit came in between and wins. */
  private letGo(layer: Layer): void {
    setTimeout(() => {
      if (this.held.get(layer.id) === layer) this.unhold(layer.id);
    }, HOLD_MS);
  }

  private heldChanged(id: string): void {
    this.heldVersion++;
    this.version++;
    const scene = this.shownScene();
    const layer = this.shownLayer(id);
    if (scene && layer) this.ui.layers = this.ui.layers.map((row) => (row.id === id ? this.layerRow(layer, scene) : row));
    this.invalidate();
  }

  /** Files that show what was held let it go. A drag still under way keeps its layer. */
  private releaseHeld(): void {
    const scene = this.entry?.scene;
    if (!scene) return;
    for (const layer of sceneLayers(scene)) {
      const held = this.held.get(layer.id);
      if (held && layerKey(held) === layerKey(layer) && layer.id !== this.keyDrag?.base.id && layer.id !== this.canvasDrag?.layerId && layer.id !== this.nudge?.base.id) {
        this.held.delete(layer.id);
        this.heldVersion++;
      }
    }
  }

  /** Forgets everything under way, for a scene that's leaving. */
  private dropHeld(): void {
    this.endCanvasDrag(false);
    this.keyDrag = null;
    this.held.clear();
    this.heldVersion++;
    this.ui.selectedKey = null;
    this.toldFixed.clear();
  }

  /** Saves a held layer. Whatever refuses it says why in the selection bar, and the layer goes back to what the file holds. */
  private saveLayer(base: Layer, next: Layer): Promise<boolean> {
    const key = this.entry?.key;
    const set = layerSet(base, next);
    if (!key || Object.keys(set).length === 0) {
      this.unhold(next.id);
      return Promise.resolve(false);
    }
    this.history.begin();
    return this.inLine(async () => {
      try {
        const change = await this.studio.editLayer({ scene: key, layer: next.id, set });
        this.history.record(key, { layerId: next.id, ...change });
        this.letGo(next);
        return true;
      } catch (err) {
        this.say(errorText(err).message);
        this.ui.selectedKey = null;
        this.unhold(next.id);
        return false;
      } finally {
        this.history.end();
      }
    });
  }

  /** Why keys can't change here, or null. */
  private keysRefused(): string | null {
    if (this.entry?.kind === 'composition' || !this.validScene()) return 'Keys are edited in scenes. Open the clip to edit its keys.';
    return this.agentWorks() ? LOCKED : null;
  }

  private startKeyDrag(target: KeyTarget): boolean {
    const problem = this.keysRefused();
    if (problem) {
      this.say(problem);
      return false;
    }
    this.saveNudge();
    const base = this.shownLayer(target.layerId);
    if (!base) return false;
    this.pauseInternal();
    if (target.layerId !== this.layerId) this.pick(target.layerId, null);
    this.keyDrag = { target, base, next: base };
    return true;
  }

  private dragKeys(to: number): void {
    const drag = this.keyDrag;
    const scene = this.validScene();
    if (!drag || !scene) return;
    const { layer, frame } = moveTarget(drag.base, drag.target, to, scene.fps, this.total);
    drag.next = layer;
    if (drag.target.kind === 'key' && frame !== null) this.ui.selectedKey = { layerId: drag.target.layerId, param: drag.target.param, frame };
    this.hold(layer);
  }

  private endKeyDrag(commit: boolean): void {
    const drag = this.keyDrag;
    if (!drag) return;
    this.keyDrag = null;
    if (commit && drag.next !== drag.base) void this.saveLayer(drag.base, drag.next);
    else {
      if (drag.target.kind === 'key') this.ui.selectedKey = null;
      this.unhold(drag.base.id);
    }
  }

  private deleteKey(key: SelectedKey): void {
    const problem = this.keysRefused();
    const scene = this.validScene();
    if (problem || !scene) {
      this.say(problem);
      return;
    }
    this.saveNudge();
    const base = this.shownLayer(key.layerId);
    if (!base) return;
    const refs = keysAt(base.tracks, key.frame, scene.fps, key.param);
    if (refs.length === 0) return;
    const next = deleteKeys(base, refs);
    this.ui.selectedKey = null;
    this.hold(next);
    void this.saveLayer(base, next);
  }

  /** Left and Right on a selected key. A run of them shows at once and saves as one edit. */
  private nudgeKey(key: SelectedKey, frames: number): void {
    const problem = this.keysRefused();
    const scene = this.validScene();
    const current = this.shownLayer(key.layerId);
    if (problem || !scene || !current) {
      this.say(problem);
      return;
    }
    const { layer, frame } = moveTarget(current, { kind: 'key', ...key }, key.frame + frames, scene.fps, this.total);
    if (frame === null || frame === key.frame) return;
    if (this.nudge) clearTimeout(this.nudge.timer);
    this.nudge = { base: this.nudge?.base ?? current, next: layer, timer: setTimeout(() => this.saveNudge(), NUDGE_SAVE_MS) };
    this.ui.selectedKey = { ...key, frame };
    this.hold(layer);
  }

  private saveNudge(): void {
    const nudge = this.nudge;
    if (!nudge) return;
    clearTimeout(nudge.timer);
    this.nudge = null;
    void this.saveLayer(nudge.base, nudge.next);
  }

  /** The media list the sidebar shows was read for this listing of media/. */
  private mediaListed = '';

  /** Reads the sound files' lengths again when media/ changed (ADR 0012). */
  private refreshMedia(): void {
    const listing = JSON.stringify(this.library.media ?? []);
    if (listing === this.mediaListed) return;
    this.mediaListed = listing;
    // A replaced file must decode again.
    this.pictures.dispose();
    this.picturesWanted = '';
    this.ui.media = (this.library.media ?? []).map((m) => ({ file: m.file, name: m.file.slice('media/'.length) }));
    this.studio.mediaList().then(
      (list) => {
        if (listing !== this.mediaListed) return;
        this.ui.media = list.map((m) => ({ file: m.file, name: m.file.slice('media/'.length), ...(m.duration !== undefined ? { duration: m.duration } : {}) }));
      },
      () => {},
    );
  }

  /** Swaps in a freshly loaded library (hot edit of a scene or rig), keeping scene, frame, and play state. */
  setLibrary(library: SceneLibrary): void {
    const previous = this.entry;
    const wasPlaying = this.clock.playing || this.resumeWhenValid;
    this.library = library;
    // The scene the URL asked for now exists (its file was just written): open it at the requested frame.
    const requested = this.missingRequest ? findEntry(library, this.missingRequest.scene) : null;
    const created = this.openWhenLoaded !== null ? findEntry(library, this.openWhenLoaded) : null;
    if (created) {
      this.openWhenLoaded = null;
      this.userSelect(created);
    } else if (requested && this.missingRequest) {
      this.pendingFrameParam = this.missingRequest.frame;
      this.pendingSelection = this.missingRequest.selection;
      this.missingRequest = null;
      this.resumeWhenValid = false;
      this.selectEntry(requested, false);
    } else {
      // With nothing to keep, the first composition, as the sidebar lists them first (ADR 0013), else the first scene.
      const next = (previous && findEntry(library, previous.key, previous.path)) ?? library.entries.find((e) => e.kind === 'composition') ?? library.entries[0] ?? null;
      const same = previous !== null && next !== null && (next.key === previous.key || next.path === previous.path);
      // The shot on screen is gone, so there is no way back from wherever the viewer falls back to.
      if (!same) this.shotReturn = null;
      this.selectEntry(next, same);
      if (same && wasPlaying && !this.clock.playing) {
        if (!this.playInternal()) this.resumeWhenValid = true;
      }
    }
    this.errors.set('hmr', null);
    this.refreshMedia();
    this.refreshThumbs();
  }

  /**
   * A hot update could not load (syntax error, missing module) or could not
   * swap in. The previous scene stays on screen, and the next good swap clears this.
   */
  reportHotFailure(err?: unknown): void {
    const lines = [
      'A changed scene, rig, or engine file could not be loaded (usually a syntax error or a missing export). The last good version is still showing.',
      'See the browser console and the Vite terminal for the error; saving a fix updates the viewer.',
    ];
    if (err === undefined) {
      this.errors.set('hmr', { title: 'Hot update failed', lines });
      return;
    }
    const { message, stack } = errorText(err);
    this.errors.set('hmr', { title: 'Hot update failed', lines: [message, ...lines], detail: stack });
  }

  reportBuildError(err: { message: string; id?: string; frame?: string; plugin?: string; loc?: { file?: string; line: number; column: number } }): void {
    const where = err.loc ? `${err.loc.file ?? err.id ?? ''}:${err.loc.line}:${err.loc.column}` : err.id;
    this.errors.set('build', {
      title: `Build error${err.plugin ? ` (${err.plugin})` : ''}`,
      lines: where ? [err.message, where] : [err.message],
      detail: err.frame,
    });
  }

  clearBuildError(): void {
    this.errors.set('build', null);
  }

  /** The studio server stopped answering this page's event stream for good: its pairing is gone. */
  reportServerLost(): void {
    this.errors.set('server', {
      title: 'Lost the studio server',
      lines: ['This page no longer hears from the studio server, so edits and agents won’t show up here. Reload the page; under npm run dev, open the link it printed.'],
    });
  }

  reportRuntimeError(err: unknown): void {
    const { message, stack } = errorText(err);
    this.errors.set('runtime', { title: 'Uncaught error', lines: [message], detail: stack });
  }

  /** Before Vite's full-reload fallback: write the URL now and remember play state. */
  prepareForReload(): void {
    this.url.flush();
    try {
      sessionStorage.setItem(RESUME_KEY, this.clock.playing || this.resumeWhenValid ? '1' : '0');
    } catch {
      // storage unavailable; the reload still lands on the same scene and frame
    }
  }

  // ---- scene selection ----

  /** Creates a scene or project on the studio server, then shows the new scene: now if the library has it, else once it does. */
  private create(make: () => Promise<string>): Promise<string | null> {
    return attempt(async () => {
      const key = await make();
      const entry = findEntry(this.library, key);
      if (entry && entry.key === key) this.userSelect(entry);
      else this.openWhenLoaded = key;
    });
  }

  private userSelect(entry: SceneEntry): void {
    this.setHome(false);
    this.shotReturn = null;
    this.pendingFrameParam = null;
    this.pendingSelection = null;
    this.resumeWhenValid = false;
    this.missingRequest = null;
    this.selectEntry(entry, false);
  }

  /** keepFrame: the same scene after a hot edit (keeps frame and selection); false for a switch. */
  private selectEntry(entry: SceneEntry | null, keepFrame: boolean): void {
    if (!keepFrame) this.saveNudge();
    this.entry = entry;
    if (keepFrame) this.releaseHeld();
    else this.dropHeld();
    const scene = this.shownScene();
    const registry = entry?.registry ?? null;
    const renderable = scene !== null && registry !== null;
    this.total = scene ? countFrames(scene) : 0;
    this.version++;
    this.shape = renderable ? sceneShape(scene, registry, this.total, entry?.world) : null;
    this.ui.layers = renderable ? this.layerRows(scene) : [];
    this.history.sync(entry?.key ?? null, entry?.scene ? sceneState(entry.scene) : null);
    this.dropMissingKey();
    this.reconcileSelection(keepFrame);
    if (!keepFrame) {
      // Rows and menus of the scene that's leaving won't report the pointer going.
      this.rowHover = null;
      this.ui.stackMenu = null;
      this.ui.rangeEditing = false;
    }
    this.clickMemo = null;
    this.hoverLayer = null;
    this.hoverFailedFrame = null;
    this.overlay.reset();
    this.requestHover();

    this.clock.setTimeline(renderable ? { fps: scene.fps, frameCount: this.total } : null);
    if (renderable) {
      this.resumeWhenValid = false;
      if (this.pendingFrameParam !== null) {
        this.clock.seek(parseFrameParam(this.pendingFrameParam, scene.fps, this.total) ?? 0);
        this.pendingFrameParam = null;
      } else if (!keepFrame) {
        this.clock.seek(0);
      }
    }

    this.view.setSceneSize(renderable ? scene.size : null);
    this.view.canvas.classList.toggle('is-pixel', renderable && this.showsPixels(scene, entry?.world ?? {}));
    this.errors.set('render', null);
    this.syncErrors();
    this.ui.scenes = this.sceneOptions();
    this.ui.projects = this.library.projects.map((p) => ({ id: p.id, name: p.name, fps: p.project?.fps ?? null, size: p.project?.size ?? null }));
    const folder = this.library.folder?.project;
    this.ui.format = { fps: folder?.fps, size: folder?.size };
    this.ui.selectedScene = entry?.key ?? null;
    const project = entry && entry.project !== null ? this.library.projects.find((p) => p.id === entry.project) : undefined;
    this.ui.header = entry
      ? {
          key: entry.key,
          name: project ? entry.key.slice(project.id.length + 1) : entry.key,
          project: project?.name ?? null,
          size: scene ? scene.size : null,
          fps: scene?.fps ?? null,
          frames: this.total,
          empty: scene !== null && (scene.layers.length === 0 || scene.layers.every((l) => l.scene !== undefined && entry.world.scenes?.get(l.scene)?.layers.length === 0)),
          video: entry.kind === 'composition',
          vertical: scene !== null && scene.size[0] * 16 === scene.size[1] * 9,
        }
      : null;
    this.ui.markers = scene?.markers ? scene.markers.map((m) => ({ frame: Math.min(this.total - 1, timeToFrame(m.t, scene.fps)), label: m.label })).sort((a, b) => a.frame - b.frame) : [];
    document.title = entry ? `${entry.key} · Frame Studio` : 'Frame Studio';
    this.syncUrl();
    this.schedulePublish();
    this.refreshSound();
    this.invalidate();
  }

  /**
   * Brings the selection in line with the scene just swapped in: resolves URL
   * values once the scene is valid, clears it on a scene switch, and after a
   * hot edit drops a layer, part or range the edited scene no longer has, and
   * says so in the bar. While the edited scene is invalid the selection is kept.
   */
  private reconcileSelection(sameScene: boolean): void {
    const shape = this.shape;
    if (this.pendingSelection) {
      if (!shape) return;
      const resolved = resolveSelectionParams(this.pendingSelection, shape);
      this.pendingSelection = null;
      this.layerId = resolved.layerId;
      this.partId = resolved.partId;
      this.range = resolved.range;
      this.notice = null;
      if (resolved.ignored.length > 0) console.warn(`Ignored from the URL: ${resolved.ignored.join('; ')}`);
      return;
    }
    if (!sameScene) {
      this.layerId = null;
      this.partId = null;
      this.range = null;
      this.pickedSpan = null;
      this.ui.cue = null;
      this.notice = null;
      return;
    }
    if (!shape) return;
    const notes: string[] = [];
    if (this.layerId !== null && !shape.layers.has(this.layerId)) {
      notes.push(`Layer "${this.layerId}" is no longer in the scene, so it was deselected.`);
      this.layerId = null;
      this.partId = null;
    } else if (this.layerId !== null && this.partId !== null && !shape.layers.get(this.layerId)?.includes(this.partId)) {
      notes.push(`Layer "${this.layerId}" no longer has part "${this.partId}", so the part was deselected.`);
      this.partId = null;
    }
    if (this.range && this.range.to > shape.frameCount) {
      if (this.range.from < shape.frameCount) {
        this.range = { from: this.range.from, to: shape.frameCount };
        notes.push(`The scene got shorter, so the range was cut to ${spanLabel(this.range, shape.fps)}.`);
      } else {
        this.range = null;
        notes.push('The scene got shorter, so the range was cleared.');
      }
    }
    if (notes.length > 0) this.notice = notes.join(' ');
  }

  /** A scene on a pixel stage, or a composition of nothing else. Square pixels should stay square however the canvas scales. */
  private showsPixels(scene: Scene, world: World): boolean {
    if (scene.pixel) return true;
    const placed = scene.layers.filter((l) => l.scene !== undefined);
    return placed.length > 0 && placed.length === scene.layers.length && placed.every((l) => world.scenes?.get(l.scene!)?.pixel !== undefined);
  }

  /** Compositions and scenes, then each M9 project's scenes under its name, its main scene first (ADR 0007, ADR 0013). */
  private sceneOptions(): SceneOption[] {
    const projects = new Map(this.library.projects.map((p) => [p.id, p]));
    // Which compositions place each folder scene or composition, for "Used in".
    const usedIn = new Map<string, string[]>();
    for (const e of this.library.entries) {
      if (e.kind !== 'composition' || !e.scene) continue;
      for (const layer of e.scene.layers) {
        if (layer.scene === undefined) continue;
        const list = usedIn.get(layer.scene) ?? [];
        if (!list.includes(e.key)) list.push(e.key);
        usedIn.set(layer.scene, list);
      }
    }
    const options = this.library.entries.map((e): SceneOption => {
      const project = e.project !== null ? projects.get(e.project) : undefined;
      const main = project?.main === e.key;
      return {
        key: e.key,
        label: project ? e.key.slice(project.id.length + 1) : e.key,
        file: e.file,
        invalid: e.scene === null || (project?.errors.length ?? 0) > 0,
        film: project ? project.id : null,
        group: project ? project.name : null,
        main,
        kind: e.kind,
        usedIn: project ? [] : (usedIn.get(e.key) ?? []),
        format: e.scene ? { size: e.scene.size, fps: e.scene.fps, seconds: e.scene.duration, pixel: e.scene.pixel !== undefined || this.showsPixels(e.scene, e.world) } : null,
      };
    });
    // The project's own keep library order; older films follow in id order, each with its main scene first.
    return options
      .map((o, i) => ({ o, i }))
      .sort((a, b) => Number(a.o.film !== null) - Number(b.o.film !== null) || (a.o.film ?? '').localeCompare(b.o.film ?? '') || Number(b.o.main) - Number(a.o.main) || a.i - b.i)
      .map(({ o }) => o);
  }

  // ---- shots (ADR 0007) ----

  /** The scene layers of the scene on screen whose shots show at all, with their spans. */
  private shots(): { layerId: string; key: string; label: string; span: SceneLayerSpan; end: number; length: number }[] {
    const entry = this.entry;
    const scene = this.shownScene();
    if (!entry || !scene || (entry.project === null && entry.kind !== 'composition')) return [];
    return scene.layers.flatMap((layer) => {
      if (layer.file !== undefined) {
        const from = timeToFrame(layer.start ?? 0, scene.fps);
        const start = timeToFrame(layer.in ?? 0, scene.fps);
        const end = timeToFrame(layer.out ?? 0, scene.fps);
        const known = this.ui.media.find((m) => m.file === layer.file)?.duration;
        // A clip of an image can run as long as you like; a video stops where its file does.
        const length = isImageFile(layer.file) ? Number.MAX_SAFE_INTEGER : known !== undefined ? timeToFrame(known, scene.fps) : end;
        const span = { from, to: Math.min(this.total, from + Math.max(0, end - start)), in: start };
        return span.to > span.from ? [{ layerId: layer.id, key: '', label: layer.file.slice(layer.file.lastIndexOf('/') + 1), span, end, length }] : [];
      }
      const shot = layer.scene !== undefined ? entry.world.scenes?.get(layer.scene) : undefined;
      if (!shot) return [];
      const span = sceneLayerSpan(layer, scene, shot);
      // A composition's clips are folder entries, keyed by their plain id; an M9 shot is "<project>/<scene>".
      const key = entry.project === null ? layer.scene! : `${entry.project}/${layer.scene}`;
      const length = countFrames(shot);
      // The trim's end, which the span doesn't show when the composition cuts the clip off.
      const end = layer.out === undefined || layer.out >= shot.duration ? length : Math.min(length, timeToFrame(layer.out, scene.fps));
      return span.to > span.from ? [{ layerId: layer.id, key, label: layer.scene!, span, end, length }] : [];
    });
  }

  /** Opens the shot a scene layer shows, at the frame matching the one on screen, or the first frame it shows. */
  private openShot(layerId?: string | null): string | null {
    const id = layerId ?? this.layerId;
    const shot = this.shots().find((s) => s.layerId === id);
    if (!shot || !this.entry) return id === null ? 'Select a shot first.' : `Layer "${id}" places no scene.`;
    if (shot.key === '') return `"${shot.label}" is a recorded clip, so there is no scene to open.`;
    const target = findEntry(this.library, shot.key);
    if (!target) return `Scene "${shot.key}" is missing.`;
    const frame = this.clock.frame;
    const back = { key: this.entry.key, layerId: shot.layerId, span: shot.span, frame };
    this.userSelect(target);
    this.shotReturn = back;
    if (this.clock.timeline) this.clock.seek(shotFrame(shot.span, frame) ?? shot.span.in);
    this.uiDirty = true;
    this.syncUrl();
    this.invalidate();
    this.flushNow();
    return null;
  }

  /**
   * Back from Open shot to the scene it came from, at the frame matching the shot's, with the shot's layer
   * selected. The span is read again from the parent, in case its cut changed while the shot was open.
   */
  private back(): string | null {
    const back = this.shotReturn;
    if (!back) return 'No shot was opened from another scene.';
    const parent = findEntry(this.library, back.key);
    if (!parent) {
      this.shotReturn = null;
      this.uiDirty = true;
      this.schedule();
      return `Scene "${back.key}" is missing.`;
    }
    const layer = parent.scene?.layers.find((l) => l.id === back.layerId);
    const shot = layer?.scene !== undefined ? parent.world.scenes?.get(layer.scene) : undefined;
    // Only while the layer still shows the scene on screen; otherwise go back to where Open shot was pressed.
    const span = parent.scene && layer && shot && `${parent.project}/${layer.scene}` === this.entry?.key ? sceneLayerSpan(layer, parent.scene, shot) : null;
    const g = this.clock.frame;
    const frame = span && g >= span.in && g < span.in + (span.to - span.from) ? span.from + (g - span.in) : back.frame;
    this.userSelect(parent);
    if (!this.clock.timeline) {
      // The parent can't render right now (it places the broken shot, say): open there once it can.
      this.pendingFrameParam = String(frame);
      this.pendingSelection = { layer: back.layerId, part: null, from: null, to: null };
    } else {
      if (this.shape?.layers.has(back.layerId)) {
        this.layerId = back.layerId;
        this.partId = null;
        this.selectionChanged();
      }
      this.clock.seek(frame);
    }
    this.uiDirty = true;
    this.syncUrl();
    this.invalidate();
    this.flushNow();
    return null;
  }

  // ---- export (ADR 0008) ----

  /** Asks the studio server to export the scene on screen, or its selected range. Returns an error message, or null. */
  private async startExport(target: 'mp4' | 'gif' | 'html', options: { range: boolean; sound: boolean; media?: boolean }): Promise<string | null> {
    const scene = this.validScene();
    if (!scene || !this.entry) return 'There is no valid scene to export.';
    if (this.ui.exporting.running) return 'An export is already running.';
    const range = options.range && target !== 'html' && this.range ? this.range : null;
    try {
      const id = await this.studio.startExport({
        scene: this.entry.key,
        target,
        ...(range ? { from: range.from, to: range.to } : {}),
        ...(target !== 'gif' && !options.sound ? { silent: true } : {}),
        ...(target === 'html' && options.sound && options.media ? { media: true } : {}),
      });
      this.ui.exporting = { ...this.ui.exporting, running: { id, stage: 'starting', done: 0, total: 1 }, result: null, canReveal: desktop() !== null };
      return null;
    } catch (err) {
      return errorText(err).message;
    }
  }

  /** Asks the studio server to check the scene on screen. Returns an error message, or null. */
  private async startCheck(loop: boolean): Promise<string | null> {
    if (!this.validScene() || !this.entry) return 'There is no valid scene to check.';
    if (this.ui.checking.running) return 'A check is already running.';
    try {
      const id = await this.studio.startCheck({ scene: this.entry.key, loop });
      this.ui.checking = { running: { id, stage: 'starting', done: 0, total: 1 }, report: null, error: null };
      return null;
    } catch (err) {
      return errorText(err).message;
    }
  }

  /** Shows why a button did nothing, in the selection bar. */
  private say(problem: string | null): void {
    if (!problem) return;
    this.notice = problem;
    this.uiDirty = true;
    this.schedule();
  }

  private syncErrors(): void {
    const lib = this.library;
    const missing = this.missingRequest;
    const known = lib.entries.map((e) => e.key).join(', ') || 'none';
    this.errors.set(
      'request',
      missing
        ? {
            title: `Scene "${missing.scene}" not found`,
            lines: [
              `No scene has the id or file name "${missing.scene}", so the viewer is showing ${this.entry ? `"${this.entry.key}"` : 'nothing'}. Scenes: ${known}.`,
              'Pick a scene from the list, or add the scene file; the viewer opens it as soon as it exists.',
            ],
          }
        : null,
    );
    this.errors.set('library', lib.errors.length > 0 ? { title: 'Rigs failed to load; nothing can render', lines: lib.errors } : null);
    const project = this.entry?.project != null ? lib.projects.find((p) => p.id === this.entry!.project) : undefined;
    this.errors.set(
      'project',
      project && project.errors.length > 0 ? { title: `Project "${project.id}" has errors (${project.file})`, lines: project.errors } : null,
    );
    // A project with no scenes yet isn't an error: the library offers to start one (ADR 0013).
    this.ui.emptyProject = lib.entries.length === 0;
    if (lib.entries.length === 0) this.setHome(true);
    if (lib.entries.length === 0) {
      this.errors.set('scene', null);
    } else if (this.entry && this.entry.errors.length > 0) {
      const n = this.entry.errors.length;
      this.errors.set('scene', { title: `${this.entry.file} is invalid (${n} error${n === 1 ? '' : 's'})`, lines: this.entry.errors });
    } else {
      this.errors.set('scene', null);
    }
  }

  // ---- playback ----

  private togglePlay(): void {
    if (this.clock.playing) this.pauseInternal();
    else this.playInternal();
  }

  private playInternal(): boolean {
    this.resumeWhenValid = false;
    if (!this.clock.play()) return false;
    this.hoverLayer = null;
    this.uiDirty = true;
    this.schedule();
    return true;
  }

  private pauseInternal(): void {
    this.resumeWhenValid = false;
    if (!this.clock.playing) return;
    this.clock.pause();
    this.uiDirty = true;
    this.syncUrl();
    this.schedulePublish();
    this.requestHover();
    this.schedule();
  }

  /** Seeks; draws on the next animation frame, or right away when sync is set. */
  private seekInternal(frame: number, sync: boolean): number {
    const before = this.clock.frame;
    const after = this.clock.seek(frame);
    this.uiDirty = true;
    if (after !== before) {
      this.canvasDirty = true;
      this.requestHover();
      // The selection file carries the frame on screen; while paused, keep it current.
      if (!this.clock.playing) this.schedulePublish();
    }
    this.syncUrl();
    if (sync) this.flushNow();
    else this.schedule();
    return after;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    // A modal dialog (New scene) owns the keyboard; Escape there must close it, not clear the selection.
    if (e.defaultPrevented || e.isComposing || document.querySelector('dialog:modal')) return;
    // Escape during a drag puts it back, and nothing else.
    if (e.key === 'Escape' && (this.canvasDrag || this.keyDrag)) {
      e.preventDefault();
      this.endCanvasDrag(false);
      this.endKeyDrag(false);
      return;
    }
    // The timeline isn't showing under the library. Escape goes back to it.
    if (this.ui.home) {
      if (e.key === 'Escape' && this.ui.homeReturn) this.setHome(false);
      return;
    }
    const action = keyAction(e, this.entry?.scene?.fps ?? 1);
    if (!action || focusKeepsKey(e.target, e.key)) return;
    e.preventDefault();
    if (!this.clock.timeline) return;
    switch (action.type) {
      case 'toggle':
        this.togglePlay();
        break;
      case 'step':
        this.pauseInternal();
        if (this.ui.selectedKey) this.nudgeKey(this.ui.selectedKey, Math.sign(action.delta) * (e.shiftKey ? 10 : 1));
        else this.seekInternal(this.clock.frame + action.delta, false);
        break;
      case 'seek':
        this.seekInternal(action.to === 'start' ? 0 : this.total - 1, false);
        break;
      case 'markIn':
        this.userSetRange(markIn(this.range, this.clock.frame, this.total));
        break;
      case 'markOut':
        this.userSetRange(markOut(this.range, this.clock.frame, this.total));
        break;
      case 'escape':
        if (this.ui.selectedKey) this.ui.selectedKey = null;
        else this.escape();
        break;
      case 'delete':
        if (this.ui.selectedKey) this.deleteKey(this.ui.selectedKey);
        break;
      case 'mute':
        if (this.soundStatus !== 'none') this.toggleMute();
        break;
      case 'markSpan':
        this.markSpan();
        break;
      case 'compose':
        this.ui.layout.panel = true;
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.agent-panel textarea')?.focus());
        break;
      case 'undo':
      case 'redo':
        this.stepHistory(action.type);
        break;
      case 'ignore':
        break;
    }
  };

  // ---- picking ----

  private validScene(): Scene | null {
    return this.clock.timeline ? this.shownScene() : null;
  }

  /** The engine hit test on the frame on screen, with the one shared 1x1 probe. */
  private hit(x: number, y: number, options?: HitTestOptions): HitResult {
    const scene = this.validScene();
    const registry = this.entry?.registry ?? null;
    if (!scene || !registry) {
      const why = this.errors.messages;
      throw new Error(`No valid scene to hit test.${why.length ? `\n${why.join('\n')}` : ''}`);
    }
    if (!this.probe) {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('This browser did not provide an OffscreenCanvas 2D context for hit testing.');
      this.probe = ctx;
    }
    return hitTest(this.probe, scene, this.clock.frame, x, y, registry, { ...options, world: this.world() });
  }

  /** A client position in scene pixels, or null off the scene. */
  private scenePoint(at: Point): Point | null {
    const scene = this.validScene();
    if (!scene) return null;
    return clientToScene(at.x, at.y, this.view.canvas.getBoundingClientRect(), scene.size[0], scene.size[1]);
  }

  private readonly onCanvasPointerDown = (e: PointerEvent): void => {
    this.downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    this.pressLooked = false;
    this.pressDragged = false;
  };

  /** The moment a drag starts, if it starts: the range counts when the playhead is inside it. */
  private dragMoment(scene: Scene): DragMoment {
    return { frame: this.clock.frame, fps: scene.fps, range: this.range };
  }

  /**
   * Past the drag threshold a press takes hold of a layer: the selected one if it's under the press, as click
   * cycling can leave it, else the top one. It selects it, and moves it if it can. The selected part stays.
   */
  private startCanvasDrag(e: PointerEvent, down: Point): void {
    const scene = this.validScene();
    const registry = this.entry?.registry ?? null;
    const p = this.scenePoint(down);
    if (!scene || !registry || !p || this.scrubbing) return;
    let under: string[];
    try {
      under = this.hit(p.x, p.y, { all: true }).candidates.map((c) => c.layerId);
    } catch {
      return;
    }
    const layerId = this.layerId !== null && under.includes(this.layerId) ? this.layerId : (under[0] ?? null);
    if (layerId === null) return;
    this.pauseInternal();
    this.pressDragged = true;
    this.hoverLayer = null;
    if (layerId !== this.layerId) {
      this.clickMemo = null;
      this.userSetLayer(layerId, null);
      this.selectionPoint = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    const layer = this.shownLayer(layerId);
    if (!layer) return;
    const frame = this.clock.frame;
    if (this.agentWorks()) {
      this.say(LOCKED);
      return;
    }
    const from = this.whereIs(layer, scene);
    if (!from) {
      if (!this.toldFixed.has(layerId)) this.say('Position is set by this rig');
      this.toldFixed.add(layerId);
      return;
    }
    const moment = this.dragMoment(scene);
    const write = writePosition(layer, from, from, moment);
    if (!write.ok) {
      this.say(write.error);
      return;
    }
    this.saveNudge();
    this.view.canvas.setPointerCapture(e.pointerId);
    this.canvasDrag = {
      layerId,
      pointerId: e.pointerId,
      start: down,
      base: layer,
      next: layer,
      from,
      scale: dragScale(scene, layer, frame, this.view.currentFit.cssWidth),
      moment,
      centre: stageCentre(scene, layer, frame),
      guides: null,
    };
    this.view.canvas.classList.add('is-dragging');
    this.moveCanvasDrag(e);
  }

  /** The layer's position on the frame on screen, or null when it has none to change. */
  private whereIs(layer: Layer, scene: Scene): Movable | null {
    const registry = this.entry?.registry;
    if (!registry) return null;
    try {
      return movable(layer, scene, this.clock.frame, registry, this.world());
    } catch {
      return null;
    }
  }

  private moveCanvasDrag(e: PointerEvent): void {
    const drag = this.canvasDrag;
    if (!drag) return;
    const dx = e.clientX - drag.start.x;
    const dy = e.clientY - drag.start.y;
    const moved = e.shiftKey ? lockAxis(dx, dy) : { x: dx, y: dy };
    const delta = dragDelta(moved.x, moved.y, drag.scale);
    const x = snapCentre(drag.from.x + delta.x, drag.centre.x, drag.scale);
    const y = snapCentre(drag.from.y + delta.y, drag.centre.y, drag.scale);
    const to = {
      x: moved.x === 0 ? drag.from.x : landValue(withinBounds(x.value, drag.from.bounds.x), drag.scale),
      y: moved.y === 0 ? drag.from.y : landValue(withinBounds(y.value, drag.from.bounds.y), drag.scale),
    };
    const write = writePosition(drag.base, to, drag.from, drag.moment);
    if (!write.ok) return;
    drag.next = write.layer;
    drag.guides = (moved.x !== 0 && x.snapped) || (moved.y !== 0 && y.snapped) ? { x: moved.x !== 0 && x.snapped, y: moved.y !== 0 && y.snapped } : null;
    this.hold(write.layer);
  }

  /** Lifts a canvas drag: saved, or put back. */
  private endCanvasDrag(commit: boolean): void {
    const drag = this.canvasDrag;
    if (!drag) return;
    this.canvasDrag = null;
    this.view.canvas.classList.remove('is-dragging');
    if (this.view.canvas.hasPointerCapture(drag.pointerId)) this.view.canvas.releasePointerCapture(drag.pointerId);
    if (commit && drag.next !== drag.base) void this.saveLayer(drag.base, drag.next);
    else this.unhold(drag.layerId);
    this.requestHover();
  }

  private readonly onCanvasPointerUp = (): void => this.endCanvasDrag(true);
  private readonly onCanvasPointerCancel = (): void => this.endCanvasDrag(false);

  /**
   * A click selects the layer under the pointer; a click where nothing
   * painted clears the layer. Clicking the same spot again (same frame, within
   * 4 CSS px) steps down through every layer painted there and wraps to the
   * top. Alt/Option-click selects the part too.
   */
  private readonly onCanvasClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const at = { x: e.clientX, y: e.clientY };
    const down = this.downAt;
    this.downAt = null;
    if (this.pressDragged || (down && isDrag(down, at))) return;
    if (!this.shape || !this.validScene()) return;
    const p = this.scenePoint(at);
    const spot = { scene: `${this.entry?.key ?? ''}#${this.version}`, frame: this.clock.frame, x: at.x, y: at.y };
    try {
      if (e.altKey) {
        const result = p ? this.hit(p.x, p.y, { parts: true }) : null;
        this.clickMemo = null;
        this.userSetLayer(result?.layerId ?? null, result?.partId ?? null);
      } else if (p && this.clickMemo && isRepeatClick(this.clickMemo, spot, this.layerId)) {
        const result = this.hit(p.x, p.y, { all: true });
        const next = nextCandidate(
          result.candidates.map((c) => c.layerId),
          this.layerId,
        );
        this.clickMemo = { ...this.clickMemo, layerId: next };
        this.userSetLayer(next, null);
      } else {
        const id = p ? this.hit(p.x, p.y).layerId : null;
        this.clickMemo = id !== null ? { ...spot, layerId: id } : null;
        this.userSetLayer(id, null);
      }
    } catch (err) {
      this.clickMemo = null;
      this.notice = `Hit test failed: ${errorText(err).message}`;
      this.uiDirty = true;
    }
    this.selectionPoint = this.layerId !== null && p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
    this.flushNow();
  };

  /** Double-clicking a shot on a scene that places shots opens it (ADR 0007). The top layer counts, whatever the clicks cycled to. */
  private readonly onCanvasDoubleClick = (e: MouseEvent): void => {
    if (e.button !== 0 || !this.validScene() || this.entry?.project === null) return;
    const p = this.scenePoint({ x: e.clientX, y: e.clientY });
    if (!p) return;
    let top: string | null = null;
    try {
      top = this.hit(p.x, p.y).layerId;
    } catch {
      return;
    }
    if (top !== null && this.shots().some((s) => s.layerId === top)) this.openShot(top);
  };

  /** Keynote's stack menu: every layer under the pointer, top first. The playhead stops, so the menu matches the picture. */
  private readonly onCanvasContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const p = this.scenePoint({ x: e.clientX, y: e.clientY });
    if (!p || !this.validScene()) return;
    this.pauseInternal();
    try {
      const layers = this.hit(p.x, p.y, { all: true }).candidates.map((c) => c.layerId);
      this.ui.stackMenu = layers.length > 0 ? { x: e.clientX, y: e.clientY, layers, point: p } : null;
    } catch (err) {
      this.say(`Hit test failed: ${errorText(err).message}`);
    }
  };

  private readonly onStagePointerDown = (e: PointerEvent): void => {
    this.stageDownAt = e.button === 0 && e.target === this.stageElement ? { x: e.clientX, y: e.clientY } : null;
  };

  /**
   * A click on the letterbox around the canvas clears the layer, like a click
   * where nothing is painted. The range stays. Presses that start on the canvas
   * or a panel, and drags, are ignored.
   */
  private readonly onStageClick = (e: MouseEvent): void => {
    const down = this.stageDownAt;
    this.stageDownAt = null;
    if (e.button !== 0 || e.target !== this.stageElement || !down) return;
    if (isDrag(down, { x: e.clientX, y: e.clientY })) return;
    if (!this.validScene() || this.layerId === null) return;
    this.clickMemo = null;
    this.userSetLayer(null, null);
    this.flushNow();
  };

  private readonly onCanvasPointerMove = (e: PointerEvent): void => {
    const at = { x: e.clientX, y: e.clientY };
    if (this.canvasDrag) {
      this.moveCanvasDrag(e);
      return;
    }
    if (this.downAt && (e.buttons & 1) !== 0 && !this.pressLooked && isDrag(this.downAt, at)) {
      this.pressLooked = true;
      this.startCanvasDrag(e, this.downAt);
      if (this.canvasDrag) return;
    }
    if (this.pointer && this.pointer.x === at.x && this.pointer.y === at.y) return;
    this.pointer = at;
    this.hoverHidden = false;
    this.requestHover();
  };

  private readonly onCanvasPointerLeave = (): void => {
    this.pointer = null;
    this.hoverHidden = false;
    this.hoverLayer = null;
    this.hoverDirty = false;
    this.schedule();
  };

  /** Asks for a hover probe on the next animation frame (at most one per frame). */
  private requestHover(): void {
    if (!this.pointer) return;
    this.hoverDirty = true;
    this.schedule();
  }

  /** Hover inspect: probes the layer under the pointer while paused, not scrubbing and not hidden by Escape. */
  private probeHover(): void {
    this.hoverDirty = false;
    let next: string | null = null;
    const frame = this.clock.frame;
    let over = false;
    if (this.pointer && !this.hoverHidden && this.hoverFailedFrame !== frame && !this.clock.playing && !this.scrubbing && !this.canvasDrag) {
      const p = this.scenePoint(this.pointer);
      if (p) {
        try {
          next = this.hit(p.x, p.y).layerId;
          over = this.overMovableLayer(p, next);
          if (this.hoverFailedFrame !== null) {
            // A rig that throws on one frame (say inside one override range) should not end hover everywhere.
            if (this.notice?.startsWith(HOVER_OFF)) this.notice = null;
            this.hoverFailedFrame = null;
            this.uiDirty = true;
          }
        } catch (err) {
          // Stop probing on this frame, and say why once.
          this.hoverFailedFrame = frame;
          this.notice = `${HOVER_OFF} on frame ${frame}: ${errorText(err).message}`;
          this.uiDirty = true;
        }
      }
    }
    this.hoverLayer = next;
    this.overMovable = over;
    this.ui.hoverLayer = this.rowHover ?? next;
  }

  /** Whether a press here would take hold of the selected layer and move it. */
  private overMovableLayer(p: Point, top: string | null): boolean {
    const scene = this.validScene();
    const layer = this.layerId !== null ? this.shownLayer(this.layerId) : null;
    if (!scene || !layer || this.agentWorks() || !this.whereIs(layer, scene)) return false;
    return top === layer.id || this.hit(p.x, p.y, { all: true }).candidates.some((c) => c.layerId === layer.id);
  }

  /** Escape clears one thing: the hover, else the layer (and part) or sound cue, else the range. */
  private escape(): void {
    const hoverShowing = this.hoverLayer !== null && this.hoverLayer !== this.layerId;
    if (hoverShowing) {
      this.hoverHidden = true;
      this.hoverLayer = null;
      this.schedule();
    } else if (this.layerId !== null || this.ui.cue !== null) {
      // Hide the hover too, or the layer under the pointer would light up again at once.
      this.hoverHidden = true;
      this.hoverLayer = null;
      this.userSetLayer(null, null);
    } else if (this.range !== null) {
      this.userSetRange(null);
    }
  }

  private userSetLayer(layerId: string | null, partId: string | null): void {
    this.layerId = layerId;
    this.partId = layerId !== null ? partId : null;
    this.pickedSpan = null;
    this.ui.cue = null;
    this.ui.selectedKey = null;
    if (layerId === null) this.selectionPoint = null;
    this.selectionChanged();
  }

  /** Selects from the timeline or a list, where no click landed on the canvas. */
  private pick(layerId: string | null, span: FrameRange | null): void {
    this.clickMemo = null;
    this.userSetLayer(layerId, null);
    this.selectionPoint = null;
    this.pickedSpan = span;
  }

  /** X: the range goes to the clip, override or cue clicked, else the selected shot, else the layer's first to last key. */
  private markSpan(): void {
    const row = this.ui.layers.find((r) => r.id === this.layerId);
    const shot = this.shots().find((s) => s.layerId === this.layerId);
    const span = (shot ? shot.span : null) ?? this.pickedSpan ?? (row && row.keys.length > 1 ? { from: row.keys[0], to: Math.min(this.total, row.keys[row.keys.length - 1] + 1) } : null);
    if (span) this.userSetRange(span.from === 0 && span.to === this.total ? null : { from: span.from, to: span.to });
  }

  private userSetRange(range: FrameRange | null): void {
    this.range = range;
    this.selectionChanged();
  }

  private selectionChanged(): void {
    this.notice = null;
    this.uiDirty = true;
    this.requestHover();
    this.syncUrl();
    this.schedulePublish();
    this.schedule();
  }

  // ---- handoff to the agent ----

  /** What a request is about: the layer (and part) and range picked, the whole range with no layer, or the whole scene with nothing picked. */
  private requestSelection(): RequestSelection | null {
    const scene = this.validScene();
    if (!scene) return null;
    const { from, to } = this.selectedSpan();
    return {
      sceneId: this.entry!.key,
      ...(this.layerId !== null ? { layerId: this.layerId } : {}),
      ...(this.layerId !== null && this.partId !== null ? { partId: this.partId } : {}),
      from,
      to,
    };
  }

  /** What the selection covers: the range, else the selected clip, else everything. The token and a request read this same span. */
  private selectedSpan(): FrameRange {
    const clip = this.layerId === null ? undefined : this.shots().find((s) => s.layerId === this.layerId)?.span;
    return this.range ?? (clip ? { from: clip.from, to: clip.to } : { from: 0, to: this.total });
  }

  /** Writes .frame-studio/selection.json 300 ms after the selection stops changing (ADR 0003). */
  private schedulePublish(): void {
    if (!this.studio.available) return;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      const selection = this.requestSelection();
      const picked = selection && (this.layerId !== null || this.range !== null);
      const current: Omit<CurrentSelection, 'updatedAt'> | null = picked
        ? { ...selection, frame: this.clock.frame, ...(this.selectionPoint && this.layerId !== null ? { point: this.selectionPoint } : {}) }
        : null;
      this.studio.setSelection(current).catch(() => {});
    }, 300);
  }

  private startQueue(): void {
    if (!this.studio.available) return;
    const apply = (requests: StudioRequest[]) => {
      for (const r of requests) {
        const before = this.requests.find((p) => p.id === r.id);
        const turn = currentTurn(r);
        const ended = turn.status === 'done' || turn.status === 'failed' || turn.status === 'interrupted';
        // A turn ended: say so, unless its thread is open in the panel, where the turn shows it. A push can
        // fold the claim and the end together, so any change to "your turn" with an ended turn counts.
        // Stopped turns are the user's own doing, so they need no notice.
        const changed = before && (before.status !== r.status || before.turns.length !== r.turns.length);
        if (changed && r.status === 'your_turn' && ended && (this.ui.studio.open !== r.id || !this.ui.layout.panel)) {
          this.ui.toast = { id: r.id, status: turn.status as 'done' | 'failed' | 'interrupted', text: turn.summary ?? '' };
        }
      }
      this.requests = requests;
      this.ui.studio.requests = requests;
      // Drop the events of threads that left the queue (cleared into the archive).
      const ids = new Set(requests.map((r) => `${r.id}:`));
      const kept = Object.entries(this.ui.turnEvents).filter(([key]) => ids.has(key.slice(0, key.indexOf(':') + 1)));
      if (kept.length !== Object.keys(this.ui.turnEvents).length) this.ui.turnEvents = Object.fromEntries(kept);
      for (const key of [...this.loadedTurns]) if (!ids.has(key.slice(0, key.indexOf(':') + 1))) this.loadedTurns.delete(key);
      // A clip's bands lock while an agent works on its composition.
      this.uiDirty = true;
      this.schedule();
      // A thread that got a new turn while open needs that turn's events.
      if (this.ui.studio.open !== null) void this.loadEvents(this.ui.studio.open);
    };
    // A push is always newer than the first fetch, so once one arrives the fetch result is dropped.
    let pushed = false;
    this.studio.queue().then(
      (requests) => {
        if (!pushed) apply(requests);
      },
      (err) => (this.ui.studio.error = errorText(err).message),
    );
    this.studio.onQueue((requests) => {
      pushed = true;
      apply(requests);
    });
    this.studio.onTurnEvent(({ id, turn, event }) => {
      this.addEvents(id, turn, [event]);
      // An agent waits on the user in a thread that isn't showing: say so, as for a turn that ended.
      if ((event.type === 'questions' || event.type === 'approval') && (this.ui.studio.open !== id || !this.ui.layout.panel)) {
        this.ui.toast = { id, status: 'asking', text: event.type === 'questions' ? (event.questions[0]?.question ?? '') : event.summary };
      }
    });
    this.studio.onThumb(({ key, file }) => (this.ui.thumbs = { ...this.ui.thumbs, [key]: file }));
    this.studio.onExport((event) => {
      const state = this.ui.exporting;
      if (state.running?.id !== event.id) return;
      if ('error' in event) this.ui.exporting = { ...state, running: null, result: { error: event.error } };
      else if ('file' in event) {
        this.ui.exporting = { ...state, running: null, result: { file: event.file, ...(event.note ? { note: event.note } : {}) } };
        void this.refreshRenders();
      }
      else this.ui.exporting = { ...state, running: { id: event.id, stage: event.stage, done: event.done, total: event.total } };
    });
    this.studio.onCheck((event) => {
      if (this.ui.checking.running?.id !== event.id) return;
      if ('error' in event) this.ui.checking = { running: null, report: null, error: event.error };
      else if ('report' in event) this.ui.checking = { running: null, report: event.report, error: null };
      else this.ui.checking = { running: event, report: null, error: null };
    });
    this.refreshAgents(false);
    // Stalled requests are judged against the clock, and agents sign in and out, so check now and then.
    setInterval(() => (this.ui.studio.now = Date.now()), 30_000);
    setInterval(() => this.refreshAgents(false), 60_000);
  }

  private refreshAgents(fresh: boolean): void {
    this.studio.agents(fresh).then(
      (agents) => (this.ui.studio.agents = agents),
      () => {},
    );
  }

  /** Merges events into a turn's list, in order, without repeats (a push can race the first fetch). */
  private addEvents(id: number, turn: number, events: TurnEvent[]): void {
    const key = `${id}:${turn}`;
    const have = this.ui.turnEvents[key] ?? [];
    const last = have.length > 0 ? have[have.length - 1].seq : 0;
    let next: TurnEvent[];
    if (events.every((e) => e.seq > last)) {
      // The usual case, a push of what comes next: append.
      if (events.length === 0 && this.ui.turnEvents[key]) return;
      next = [...have, ...events];
    } else {
      const seen = new Set(have.map((e) => e.seq));
      const fresh = events.filter((e) => !seen.has(e.seq));
      if (fresh.length === 0 && this.ui.turnEvents[key]) return;
      next = [...have, ...fresh].sort((a, b) => a.seq - b.seq);
    }
    this.ui.turnEvents = { ...this.ui.turnEvents, [key]: next };
  }

  private openThread(id: number | null): void {
    this.ui.studio.open = id;
    if (id !== null) {
      void this.loadEvents(id);
      this.restoreRequest(id, false);
    }
  }

  /**
   * Loads the saved events of a thread's turns that haven't been fetched yet, and always its newest
   * turn. Pushed events alone don't count as loaded: they may start mid-turn.
   */
  private async loadEvents(id: number): Promise<void> {
    const thread = this.requests.find((r) => r.id === id);
    if (!thread || thread.agent === 'external') return;
    for (let k = 0; k < thread.turns.length; k++) {
      const key = `${id}:${k}`;
      if (this.loadedTurns.has(key) && k < thread.turns.length - 1) continue;
      try {
        this.addEvents(id, k, await this.studio.turnEvents(id, k));
        this.loadedTurns.add(key);
      } catch {
        // Shown as a turn with no transcript; the next queue push tries again.
      }
    }
  }

  private async sendRequest(
    prompt: string,
    files: File[],
    agent: AgentId,
    settings?: TurnSettings,
  ): Promise<{ ok: true; id: number; copied: boolean } | { ok: false; error: string }> {
    const selection = this.requestSelection();
    if (!selection) return { ok: false, error: 'Open a valid scene first.' };
    if (!prompt.trim()) return { ok: false, error: 'Write what you want changed.' };
    try {
      const references: string[] = [];
      for (const file of files) references.push(await this.studio.uploadReference(file));
      const request = await this.studio.create({
        selection,
        frame: this.clock.frame,
        ...(this.selectionPoint && this.layerId !== null ? { point: this.selectionPoint } : {}),
        prompt,
        references,
        agent,
        ...(agent !== 'external' && settings ? { settings } : {}),
      });
      let copied = false;
      if (agent === 'external') {
        try {
          await navigator.clipboard.writeText(clipboardLine(request));
          copied = true;
        } catch {
          // The clipboard can refuse, e.g. without focus. The request is queued either way.
        }
      }
      return { ok: true, id: request.id, copied };
    } catch (err) {
      return { ok: false, error: errorText(err).message };
    }
  }

  /**
   * Replies in a thread. It is about the current selection when that is on the
   * thread's scene; otherwise it keeps the thread's own selection.
   */
  private async reply(id: number, prompt: string, files: File[], settings?: TurnSettings): Promise<string | null> {
    const thread = this.requests.find((r) => r.id === id);
    if (!thread) return `There is no request #${id}.`;
    if (!prompt.trim()) return 'Write your reply.';
    const here = this.requestSelection();
    const onScene = here !== null && here.sceneId === thread.sceneId && (this.layerId !== null || this.range !== null);
    const last = currentTurn(thread).ask;
    try {
      const references: string[] = [];
      for (const file of files) references.push(await this.studio.uploadReference(file));
      await this.studio.reply(id, {
        selection: onScene ? here : last.selection,
        frame: onScene ? this.clock.frame : last.frame,
        ...(onScene && this.selectionPoint && this.layerId !== null ? { point: this.selectionPoint } : {}),
        prompt,
        references,
        ...(thread.agent !== 'external' && settings ? { settings } : {}),
      });
      return null;
    } catch (err) {
      return errorText(err).message;
    }
  }

  /** Brings back a request's scene, layer, part, range and frame. With play, loops its range, for View. */
  private restoreRequest(id: number, play: boolean): void {
    const request = this.requests.find((r) => r.id === id);
    if (!request) return;
    this.setHome(false);
    const sel = currentSelection(request);
    const entry = findEntry(this.library, sel.sceneId);
    if (!entry) {
      this.notice = `Scene "${sel.sceneId}" no longer exists.`;
      this.uiDirty = true;
      this.schedule();
      return;
    }
    if (entry !== this.entry) this.userSelect(entry);
    const parts = sel.layerId !== undefined ? this.shape?.layers.get(sel.layerId) : undefined;
    const missing = sel.layerId !== undefined && parts === undefined;
    this.layerId = missing ? null : (sel.layerId ?? null);
    this.partId = this.layerId !== null && sel.partId !== undefined && parts?.includes(sel.partId) ? sel.partId : null;
    this.selectionPoint = null;
    this.range = rangeError(sel.from, sel.to, this.total) === null ? { from: sel.from, to: sel.to } : null;
    this.clock.seek(play && this.range ? this.range.from : currentTurn(request).ask.frame);
    this.selectionChanged();
    if (missing) this.notice = `Layer "${sel.layerId}" is no longer in the scene.`;
    this.canvasDirty = true;
    this.requestHover();
    if (play) this.playInternal();
    this.flushNow();
  }

  // ---- sound ----

  /** Renders the scene's audio when what it depends on changed. Playback stays silent until it is ready. */
  private refreshSound(): void {
    const scene = this.validScene();
    const generators = this.library.generators;
    const world = this.entry?.world ?? {};
    if (!scene || !generators || !hasAudio(scene, world)) {
      this.soundFor = null;
      this.soundStatus = 'none';
      this.sound.setBuffer(null);
      this.errors.set('audio', null);
      this.errors.set('media', null);
      return;
    }
    // The sound files it plays, and what they are on disk, so a replaced file renders again.
    const files = mediaUsed(scene, world);
    const known = this.library.media ?? [];
    const stamps = files.map((f) => {
      const m = known.find((k) => k.file === f);
      return m ? `${f}:${m.bytes}:${m.modified}` : `${f}:missing`;
    });
    const key = `${audioKey(scene, world)}|${stamps.join('|')}`;
    const used = generatorsUsed(scene, generators, world);
    // A scene or rig edit reloads the library, but the generator modules it didn't touch are the same objects.
    if (this.soundFor?.key === key && sameGenerators(this.soundFor.generators, used)) return;
    const request = { key, generators: used };
    this.soundFor = request;
    this.soundStatus = 'rendering';
    this.sound.setBuffer(null);
    const settle = () => {
      this.uiDirty = true;
      this.schedule();
    };
    this.media
      .load(files, known)
      .then((loaded) => {
        if (this.soundFor !== request) return null;
        const lines = [
          ...loaded.missing.map((f) => `${f} isn't in the studio folder's media/; its cue plays silence. Import it again, or change the cue.`),
          ...loaded.failed.map((f) => `${f} (it plays silence)`),
        ];
        this.errors.set('media', lines.length > 0 ? { title: 'Sound files missing', lines } : null);
        return renderSceneAudio(scene, generators, world, loaded.buffers);
      })
      .then(
      (buffer) => {
        if (this.soundFor !== request || !buffer) return;
        this.sound.setBuffer(buffer);
        this.soundStatus = 'ready';
        this.errors.set('audio', null);
        settle();
      },
      (err: unknown) => {
        if (this.soundFor !== request) return;
        this.soundStatus = 'failed';
        const { message, stack } = errorText(err);
        this.errors.set('audio', { title: `Audio failed to render for "${this.entry?.key ?? scene.id}"`, lines: [message], detail: stack });
        settle();
      },
    );
  }

  private readonly unlockSound = (): void => {
    if (this.soundStatus === 'none' || this.sound.unlocked) return;
    this.sound.unlock().then(
      () => {
        this.uiDirty = true;
        this.schedule();
      },
      () => {},
    );
  };

  private toggleMute(): void {
    this.sound.setMuted(!this.sound.isMuted);
    writePref(MUTED_KEY, this.sound.isMuted ? '1' : '0');
    this.uiDirty = true;
    this.schedule();
  }

  /**
   * Keeps the sound on the playhead. Runs on every flush, so it follows play, pause, seeks and loops.
   * It reads the clock now, after the draw, rather than the animation frame's start time, so the time
   * spent drawing doesn't count as drift.
   */
  private syncSound(): void {
    const scene = this.validScene();
    const loop = this.clock.activeLoop;
    if (!scene || !loop) {
      this.sound.update({ playing: false, seconds: 0, loop: { from: 0, to: 0 }, repeat: true });
      return;
    }
    this.sound.update({
      playing: this.clock.playing,
      seconds: this.clock.position(performance.now()) / scene.fps,
      loop: { from: loop.from / scene.fps, to: loop.to / scene.fps },
      repeat: true,
    });
  }

  // ---- rendering ----

  /** What the scene on screen draws with beyond its file: its project's scenes and cast, and surfaces for compositing. */
  private world(): World {
    return { ...this.entry?.world, surfaces: this.surfaces, pictures: this.pictures };
  }

  private invalidate(): void {
    this.canvasDirty = true;
    this.uiDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf === 0) this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (this.hoverDirty) this.probeHover();
    if (this.clock.tick(now)) {
      this.canvasDirty = true;
      this.uiDirty = true;
      this.syncUrl();
    }
    this.flushNow();
    if (this.clock.playing) this.schedule();
  };

  private flushNow(): void {
    if (this.canvasDirty && !this.ui.home) this.drawNow();
    this.syncSound();
    if (this.uiDirty) this.syncUi();
    this.syncOverlay();
  }

  /**
   * Redraws the highlights when the frame, scene, selection, hover or size changed (the overlay skips the rest).
   * Playback shows no highlight, like hover: a fresh mask on every frame costs a second draw of the layer
   * plus a readback, several times the render itself. The selection bar still names the layer, and the
   * highlight comes back on pause.
   */
  private syncOverlay(): void {
    const scene = this.validScene();
    this.overlay.update({
      scene,
      registry: this.entry?.registry ?? null,
      world: this.world(),
      frame: this.clock.frame,
      version: this.version,
      fit: this.view.currentFit,
      selected: scene && this.layerId !== null && !this.clock.playing ? { layerId: this.layerId, partId: this.partId } : null,
      hover: scene && !this.clock.playing ? (this.rowHover ?? this.hoverLayer) : null,
      guides: this.canvasDrag?.guides ?? null,
    });
    this.view.canvas.classList.toggle('is-over-layer', scene !== null && this.hoverLayer !== null);
    this.view.canvas.classList.toggle('is-movable', scene !== null && this.overMovable && !this.canvasDrag);
    this.safeZones.show(this.ui.layout.safeZones && scene !== null && (this.ui.header?.vertical ?? false));
  }

  /** Asks for the frame's pictures, and draws again when they arrive. */
  private wantPictures(scene: Scene, frame: number, world: World): void {
    const wanted = picturesAt(scene, frame, world);
    const key = JSON.stringify(wanted);
    if (wanted.length === 0 || key === this.picturesWanted) return;
    this.picturesWanted = key;
    this.picturesNext = wanted;
    if (this.picturesBusy) return;
    this.picturesBusy = true;
    void this.decodePictures();
  }

  /** Decodes what the newest draw wanted, one at a time, skipping frames a scrub or playback has left behind. */
  private async decodePictures(): Promise<void> {
    while (this.picturesNext) {
      const wanted = this.picturesNext;
      this.picturesNext = null;
      try {
        await this.pictures.prepare(wanted);
        this.errors.set('pictures', null);
      } catch (err) {
        this.errors.set('pictures', { title: 'A picture clip could not be read', lines: [err instanceof Error ? err.message : String(err)] });
      }
      this.invalidate();
    }
    this.picturesBusy = false;
  }

  private drawNow(): DrawResult {
    this.canvasDirty = false;
    const scene = this.shownScene();
    const registry = this.entry?.registry ?? null;
    if (!scene || !registry) {
      this.view.clear();
      return { kind: 'skipped', reason: 'no valid scene is loaded' };
    }
    const frame = this.clock.frame;
    const world = this.world();
    this.wantPictures(scene, frame, world);
    try {
      const drawn = this.view.draw((ctx) => render(ctx, scene, frame, registry, world));
      this.errors.set('render', null);
      return drawn ? { kind: 'drawn' } : { kind: 'skipped', reason: 'the canvas has no size yet (stage not laid out)' };
    } catch (error) {
      const { message, stack } = errorText(error);
      this.errors.set('render', { title: `Render failed at frame ${frame} of "${this.entry?.key ?? scene.id}"`, lines: [message], detail: stack });
      if (this.clock.playing) {
        // Stop on the failing frame so the error stays readable.
        this.clock.pause();
        this.uiDirty = true;
      }
      return { kind: 'failed', error };
    }
  }

  private syncUi(): void {
    this.uiDirty = false;
    const scene = this.validScene();
    const ui = this.ui;
    ui.playing = this.clock.playing;
    ui.canPlay = scene !== null;
    const status = this.soundStatus === 'ready' && !this.sound.unlocked ? 'locked' : this.soundStatus;
    ui.sound = scene && status !== 'none' ? { status, muted: this.sound.isMuted } : null;
    ui.band = scene && this.range ? { range: this.range, frameCount: this.total } : null;
    ui.keyEdit = !scene || this.entry?.kind === 'composition' ? 'off' : this.agentWorks() ? 'locked' : 'on';
    ui.shots = scene ? this.shotBands() : null;
    ui.sounds = scene ? this.soundBands(scene) : null;
    ui.usesMedia = scene !== null && mediaUsed(scene, this.entry?.world ?? {}).length > 0;
    ui.back = this.shotReturn ? { label: this.shotReturn.key.slice(this.shotReturn.key.indexOf('/') + 1), key: this.shotReturn.key } : null;
    const span = this.selectedSpan();
    ui.layerId = this.layerId;
    ui.hoverLayer = this.rowHover ?? this.hoverLayer;
    ui.selection = {
      sceneId: scene ? (this.entry?.key ?? null) : null,
      layer: layerLabel(this.layerId, this.partId),
      shot: scene && this.layerId !== null ? (this.shots().find((s) => s.layerId === this.layerId)?.label ?? null) : null,
      range: scene ? this.range : null,
      when: scene ? spanLabel(span, scene.fps) : '',
      whenTitle: scene ? spanTitle(span) : '',
      fps: scene?.fps ?? 1,
      frameCount: this.total,
      notice: this.notice,
    };
    if (!scene) {
      ui.timeline = null;
      ui.fps = null;
      return;
    }
    const frame = this.clock.frame;
    ui.timeline = {
      frame,
      frameCount: this.total,
      timecode: formatTimecode(frame, scene.fps),
      endTimecode: formatTimecode(this.total, scene.fps),
      clock: formatClock(frame, scene.fps),
      endClock: formatClock(this.total, scene.fps),
      seconds: this.total / scene.fps,
    };
    ui.fps = scene.fps;
  }

  /** One row per layer, top of the stack first, so the background comes last. Worked out once per scene: a row never changes while it plays. */
  private layerRows(scene: Scene): LayerRow[] {
    return sceneLayers(scene)
      .reverse()
      .map((layer) => this.layerRow(layer, scene));
  }

  private layerRow(layer: Layer, scene: Scene): LayerRow {
    const { fps } = scene;
    const marks = keyMarks(layer.tracks, fps, this.total);
    return {
      id: layer.id,
      keys: marks.map((m) => m.frame).filter((f) => f >= 0 && f < this.total),
      overrides: (layer.overrides ?? []).map((o) => ({ from: o.from, to: o.to })),
      faded: layer.tracks?.some((t) => t.param === 'opacity') ?? false,
      bars: visibleSpans(layer, fps, this.total),
      marks,
      lanes: keyLanes(layer.tracks, fps, this.total),
    };
  }

  /** A selected key an edit took away is no longer selected. */
  private dropMissingKey(): void {
    const key = this.ui.selectedKey;
    if (!key) return;
    const row = this.ui.layers.find((r) => r.id === key.layerId);
    const marks = key.param === null ? row?.marks : row?.lanes.find((lane) => lane.param === key.param)?.keys;
    if (!marks?.some((m) => m.frame === key.frame)) this.ui.selectedKey = null;
  }

  /** The shots for the scrubber, each in the lowest lane where it overlaps no other. Null without any. */
  private shotBands(): { bands: ShotBand[]; lanes: number; frameCount: number; locked: boolean } | null {
    const shots = this.shots();
    if (shots.length === 0) return null;
    const composition = this.entry?.kind === 'composition';
    const laneEnds: number[] = [];
    const bands = [...shots]
      .sort((a, b) => a.span.from - b.span.from)
      .map((s): ShotBand => {
        let lane = laneEnds.findIndex((end) => end <= s.span.from);
        if (lane < 0) lane = laneEnds.push(0) - 1;
        laneEnds[lane] = s.span.to;
        return {
          layerId: s.layerId,
          label: s.label,
          from: s.span.from,
          to: s.span.to,
          lane,
          selected: s.layerId === this.layerId,
          ...(composition ? { clip: { from: s.span.from, in: s.span.in, out: s.end, length: s.length } } : {}),
        };
      });
    return { bands, lanes: laneEnds.length, frameCount: this.total, locked: this.agentWorks() };
  }

  /** The scene's own sound cues for the timeline, each in the lowest lane where it overlaps no other. Null without any. */
  private soundBands(scene: Scene): { bands: SoundBand[]; lanes: number; frameCount: number } | null {
    const cues = scene.audio ?? [];
    if (cues.length === 0) return null;
    const laneEnds: number[] = [];
    const bands = cues
      .map((cue) => {
        const from = timeToFrame(cue.start, scene.fps);
        return { cue, from, to: Math.max(from + 1, timeToFrame(cue.end, scene.fps)) };
      })
      .sort((a, b) => a.from - b.from)
      .map(({ cue, from, to }): SoundBand => {
        let lane = laneEnds.findIndex((end) => end <= from);
        if (lane < 0) lane = laneEnds.push(0) - 1;
        laneEnds[lane] = to;
        const label = cue.file ? cue.file.slice(cue.file.lastIndexOf('/') + 1) : (cue.generator ?? cue.id);
        const played = (to - from) / scene.fps;
        return { id: cue.id, label, from, to, lane, ...(cue.file ? { file: { path: cue.file, from: cue.in ?? 0, to: (cue.in ?? 0) + played } } : {}) };
      });
    return { bands, lanes: laneEnds.length, frameCount: this.total };
  }

  /** The frame the URL should carry. While a scene is invalid the clock keeps its frame, so the URL keeps it too. */
  private urlFrame(): number | string | null {
    return this.pendingFrameParam ?? (this.entry ? this.clock.frame : null);
  }

  /** The selection the URL should carry: URL values still waiting for a valid scene stay as written. */
  private urlSelection(): Pick<UrlPosition, 'layer' | 'part' | 'from' | 'to'> {
    const p = this.pendingSelection;
    if (p) return { layer: p.layer, part: p.part, from: p.from, to: p.to };
    return { layer: this.layerId, part: this.partId, from: this.range?.from ?? null, to: this.range?.to ?? null };
  }

  private urlPosition(): UrlPosition {
    // The library carries no scene, so a reload lands back on it.
    if (this.ui.home) return { scene: null, frame: null };
    return { scene: this.entry?.key ?? null, frame: this.urlFrame(), ...this.urlSelection() };
  }

  private syncUrl(): void {
    this.url.request(this.urlPosition());
  }

  /**
   * Writes the pending URL (so Back and Forward return to this frame) and
   * stores the position in sessionStorage. A reload keeps the URL from before
   * this handler ran, so main.ts reads the stored frame on a reload instead.
   */
  private readonly onPageHide = (): void => {
    this.url.flush();
    try {
      sessionStorage.setItem(RELOAD_KEY, reloadRecord(this.urlPosition()));
    } catch {
      // storage unavailable; a reload lands on the last URL write
    }
  };

  // ---- window.studio ----

  private createApi(): StudioApi {
    const app = this;
    return {
      get scene() {
        return app.clock.timeline ? (app.entry?.scene ?? null) : null;
      },
      get frame() {
        return app.clock.frame;
      },
      get frameCount() {
        return app.clock.timeline ? app.total : 0;
      },
      get sound() {
        return { status: app.soundStatus, muted: app.sound.isMuted, unlocked: app.sound.unlocked, heard: app.sound.heardSeconds };
      },
      get playing() {
        return app.clock.playing;
      },
      get scenes() {
        return app.sceneOptions().map((o) => o.key);
      },
      get errors() {
        return app.errors.messages;
      },
      get canvas() {
        return app.view.canvas;
      },
      seek(frame: number): number {
        if (typeof frame !== 'number' || Number.isNaN(frame)) throw new TypeError(`seek(frame) needs a number, got ${String(frame)}`);
        app.setHome(false);
        return app.seekInternal(frame, true);
      },
      play(): void {
        app.setHome(false);
        app.playInternal();
        app.flushNow();
      },
      pause(): void {
        app.pauseInternal();
        app.flushNow();
      },
      renderFrame(frame: number): number {
        const scene = app.clock.timeline ? app.entry?.scene : null;
        if (!scene) {
          const why = app.errors.messages;
          throw new Error(`No valid scene to render.${why.length ? `\n${why.join('\n')}` : ''}`);
        }
        if (!Number.isInteger(frame) || frame < 0 || frame >= app.total) {
          throw new RangeError(`renderFrame: frame must be an integer in [0, ${app.total}) for scene "${app.entry?.key ?? scene.id}", got ${String(frame)}`);
        }
        app.setHome(false);
        app.pauseInternal();
        app.clock.seek(frame);
        const result = app.drawNow();
        app.syncUi();
        app.syncOverlay();
        app.requestHover();
        app.syncUrl();
        if (result.kind === 'failed') throw result.error;
        if (result.kind === 'skipped') throw new Error(`renderFrame(${frame}): ${result.reason}`);
        return frame;
      },
      selectScene(id: string): void {
        const entry = app.library.entries.find((e) => e.key === id);
        if (!entry) {
          const known = app.library.entries.map((e) => e.key).join(', ') || 'none';
          throw new Error(`Unknown scene "${id}". Known scenes: ${known}`);
        }
        app.userSelect(entry);
        app.flushNow();
      },
      get selection() {
        const scene = app.validScene();
        if (!scene) return null;
        const { from, to } = app.selectedSpan();
        const sceneId = app.entry!.key;
        if (app.layerId === null) return { sceneId, from, to };
        if (app.partId === null) return { sceneId, layerId: app.layerId, from, to };
        return { sceneId, layerId: app.layerId, partId: app.partId, from, to };
      },
      get range() {
        return app.validScene() && app.range ? { from: app.range.from, to: app.range.to } : null;
      },
      hitTest(x: number, y: number, options?: HitTestOptions): HitResult {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError(`hitTest(x, y) needs finite scene pixels, got ${String(x)}, ${String(y)}`);
        return app.hit(x, y, options);
      },
      select(layerId: string | null, partId?: string): void {
        const scene = app.validScene();
        const shape = app.shape;
        if (!scene || !shape) {
          const why = app.errors.messages;
          throw new Error(`No valid scene to select in.${why.length ? `\n${why.join('\n')}` : ''}`);
        }
        const part = partId ?? null;
        if (layerId === null) {
          if (part !== null) throw new Error(`select(null, "${part}"): a part needs a layer`);
        } else {
          const parts = shape.layers.get(layerId);
          if (!parts) {
            throw new Error(`Unknown layer "${layerId}" in scene "${app.entry?.key ?? scene.id}". Layers: ${[...shape.layers.keys()].join(', ')}`);
          }
          if (part !== null && !parts.includes(part)) {
            throw new Error(
              parts.length > 0
                ? `Layer "${layerId}" has no part "${part}". Its parts: ${parts.join(', ')}`
                : `Layer "${layerId}" has no parts, so "${part}" cannot be selected`,
            );
          }
        }
        app.clickMemo = null;
        app.userSetLayer(layerId, part);
        app.flushNow();
      },
      setRange(from: number, to: number): void {
        if (!app.validScene()) throw new Error('No valid scene to set a range in.');
        const error = rangeError(from, to, app.total);
        if (error) throw new RangeError(`setRange: ${error}`);
        app.userSetRange({ from, to });
        app.flushNow();
      },
      clearRange(): void {
        app.userSetRange(null);
        app.flushNow();
      },
      get shots() {
        return app.shots().map((s) => ({ layerId: s.layerId, scene: s.key, from: s.span.from, to: s.span.to }));
      },
      openShot(layerId?: string): void {
        const problem = app.openShot(layerId);
        if (problem) throw new Error(problem);
      },
      back(): void {
        const problem = app.back();
        if (problem) throw new Error(problem);
      },
    };
  }
}

function readMuted(): boolean {
  return readPref(MUTED_KEY) === '1';
}

/** Runs a studio call, turning a failure into its message for the panel. */
async function attempt(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return errorText(err).message;
  }
}

