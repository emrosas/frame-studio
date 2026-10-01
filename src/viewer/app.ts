// Viewer controller: owns the selected scene, the playback clock, the canvas,
// the selection (layer, part, frame range) and the HTML overlay. Renders only
// when the frame, the scene, or the canvas size changes.

// The audio modules without the generators, so a generator edit hot-swaps through ./scenes like a rig edit.
import { LivePlayback } from '../audio/live';
import { mediaUsed } from '../audio/media';
import { audioKey, generatorsUsed, hasAudio, renderSceneAudio, sameGenerators } from '../audio/render';
import { MediaStore } from './media';
import type { AudioGenerator } from '../audio/types';
import {
  formatTimecode,
  frameCount as countFrames,
  hitTest,
  render,
  sceneLayerSpan,
  shotFrame,
  timeToFrame,
  type HitResult,
  type HitTestOptions,
  type SceneLayerSpan,
} from '../engine';
import type { Scene, World } from '../engine/types';
import { createSurfaces } from '../embed/surfaces';
import { CanvasView } from './canvas';
import { FpsMeter, PlaybackClock } from './clock';
import { ErrorLog, errorText } from './errors';
import { focusKeepsKey, keyAction } from './keys';
import { findEntry, openingEntry, type SceneEntry, type SceneLibrary } from './library';
import { SelectionOverlay } from './overlay';
import { clientToScene, isDrag, type Point } from './pointer';
import {
  describeRange,
  editRangeEnd,
  isRepeatClick,
  layerLabel,
  markIn,
  markOut,
  nextCandidate,
  rangeError,
  resolveSelectionParams,
  sceneShape,
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
import { StudioClient } from './studio-client';
import type { SceneOption, ShotBand, SoundBand, ViewerActions, ViewerUi } from './ui.svelte';
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
  /** ?frame= from the URL: a frame number or MM:SS:FF. */
  frame: string | null;
  /** Start playing (restoring play state across a full reload). */
  autoplay: boolean;
  /** ?layer=&part=&from=&to= from the URL, checked against the scene once it is valid. */
  selection?: SelectionParams;
}

/** sessionStorage key: play state carried across Vite's full-reload fallback. */
export const RESUME_KEY = 'frame-studio:resume-playback';

/** localStorage key: sound muted, kept across reloads and scenes. */
const MUTED_KEY = 'frame-studio:muted';

/** Start of the notice shown when a hover probe throws. */
const HOVER_OFF = 'Hover inspect is off';

type DrawResult = { kind: 'drawn' } | { kind: 'skipped'; reason: string } | { kind: 'failed'; error: unknown };

export class App {
  readonly api: StudioApi;
  private library: SceneLibrary;
  private entry: SceneEntry | null = null;
  private total = 0;
  private readonly clock = new PlaybackClock(() => performance.now());
  private readonly meter = new FpsMeter();
  private readonly url = new UrlSync();
  private readonly view: CanvasView;
  private readonly ui: ViewerUi;
  /** What the Svelte components call (ui.svelte.ts). */
  readonly actions: ViewerActions;
  private readonly overlay: SelectionOverlay;
  private readonly errors: ErrorLog;
  private raf = 0;
  private canvasDirty = true;
  private uiDirty = true;
  private lastFpsUpdate = -Infinity;
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
        if (next) this.userSelect(next);
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
        }),
      waveform: (file, from, to, buckets) => this.media.peaks(file, from, to, buckets),
      createScene: (input) => this.create(() => this.studio.createScene(input)),
      createProject: (input) => this.create(() => this.studio.createProject(input)),
      selectShot: (layerId) => {
        const shot = this.shots().find((s) => s.layerId === layerId);
        if (!shot) return;
        this.clickMemo = null;
        this.layerId = layerId;
        this.partId = null;
        this.selectionPoint = null;
        this.range = { from: shot.span.from, to: shot.span.to };
        this.selectionChanged();
        this.canvasDirty = true;
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
      clearLayer: () => {
        this.userSetLayer(null, null);
        this.flushNow();
      },
      clearRange: () => {
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
      openProject: async (path) => (await desktop()?.openProject(path).catch((err: unknown) => errorText(err).message)) ?? null,
      newProject: async () => (await desktop()?.newProject().catch((err: unknown) => errorText(err).message)) ?? null,
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
    this.errors = new ErrorLog((blocks) => (this.ui.errors = blocks));

    // The letterbox around the canvas is outside the scene: a click there clears the layer.
    this.stageElement = stage;
    stage.addEventListener('pointerdown', this.onStagePointerDown);
    stage.addEventListener('click', this.onStageClick);

    const canvas = this.view.canvas;
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown);
    canvas.addEventListener('click', this.onCanvasClick);
    canvas.addEventListener('dblclick', this.onCanvasDoubleClick);
    canvas.addEventListener('pointermove', this.onCanvasPointerMove);
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
    this.selectEntry(initial, false);
    if (options.autoplay) this.playInternal();

    this.api = this.createApi();
    this.startQueue();
    this.refreshMedia();
  }

  /** The media list the sidebar shows was read for this listing of media/. */
  private mediaListed = '';

  /** Reads the sound files' lengths again when media/ changed (ADR 0012). */
  private refreshMedia(): void {
    const listing = JSON.stringify(this.library.media ?? []);
    if (listing === this.mediaListed) return;
    this.mediaListed = listing;
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
      const next = (previous && findEntry(library, previous.key, previous.path)) ?? library.entries[0] ?? null;
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
    this.shotReturn = null;
    this.pendingFrameParam = null;
    this.pendingSelection = null;
    this.resumeWhenValid = false;
    this.missingRequest = null;
    this.selectEntry(entry, false);
  }

  /** keepFrame: the same scene after a hot edit (keeps frame and selection); false for a switch. */
  private selectEntry(entry: SceneEntry | null, keepFrame: boolean): void {
    this.entry = entry;
    const scene = entry?.scene ?? null;
    const registry = entry?.registry ?? null;
    const renderable = scene !== null && registry !== null;
    this.total = scene ? countFrames(scene) : 0;
    this.version++;
    this.shape = renderable ? sceneShape(scene, registry, this.total, entry?.world) : null;
    this.reconcileSelection(keepFrame);
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
    this.meter.reset();
    this.errors.set('render', null);
    this.syncErrors();
    this.ui.scenes = this.sceneOptions();
    this.ui.projects = this.library.projects.map((p) => ({ id: p.id, name: p.name, fps: p.project?.fps ?? null, size: p.project?.size ?? null }));
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
          empty: scene !== null && scene.layers.length === 0,
        }
      : null;
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
      this.notice = resolved.ignored.length > 0 ? `Ignored from the URL: ${resolved.ignored.join('; ')}` : null;
      return;
    }
    if (!sameScene) {
      this.layerId = null;
      this.partId = null;
      this.range = null;
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
      const was = `[${this.range.from}, ${this.range.to})`;
      if (this.range.from < shape.frameCount) {
        this.range = { from: this.range.from, to: shape.frameCount };
        notes.push(`The scene now has ${shape.frameCount} frames, so the range ${was} was cut to [${this.range.from}, ${this.range.to}).`);
      } else {
        this.range = null;
        notes.push(`The scene now has ${shape.frameCount} frames, so the range ${was} was cleared.`);
      }
    }
    if (notes.length > 0) this.notice = notes.join(' ');
  }

  /** Loose scenes, then each project's scenes under its name, its main scene first (ADR 0007). */
  private sceneOptions(): SceneOption[] {
    const projects = new Map(this.library.projects.map((p) => [p.id, p]));
    const options = this.library.entries.map((e): SceneOption => {
      const project = e.project !== null ? projects.get(e.project) : undefined;
      const main = project?.main === e.key;
      return {
        key: e.key,
        label: project ? e.key.slice(project.id.length + 1) : e.key,
        file: e.file,
        invalid: e.scene === null || (project?.errors.length ?? 0) > 0,
        project: project ? project.id : null,
        group: project ? project.name : null,
        main,
      };
    });
    // Loose scenes keep library order; projects follow in id order, each with its main scene first.
    return options
      .map((o, i) => ({ o, i }))
      .sort((a, b) => Number(a.o.project !== null) - Number(b.o.project !== null) || (a.o.project ?? '').localeCompare(b.o.project ?? '') || Number(b.o.main) - Number(a.o.main) || a.i - b.i)
      .map(({ o }) => o);
  }

  // ---- shots (ADR 0007) ----

  /** The scene layers of the scene on screen whose shots show at all, with their spans. */
  private shots(): { layerId: string; key: string; label: string; span: SceneLayerSpan }[] {
    const entry = this.entry;
    const scene = entry?.scene;
    if (!entry || !scene || entry.project === null) return [];
    return scene.layers.flatMap((layer) => {
      const shot = layer.scene !== undefined ? entry.world.scenes?.get(layer.scene) : undefined;
      if (!shot) return [];
      const span = sceneLayerSpan(layer, scene, shot);
      return span.to > span.from ? [{ layerId: layer.id, key: `${entry.project}/${layer.scene}`, label: layer.scene!, span }] : [];
    });
  }

  /** Opens the shot a scene layer shows, at the frame matching the one on screen, or the first frame it shows. */
  private openShot(layerId?: string | null): string | null {
    const id = layerId ?? this.layerId;
    const shot = this.shots().find((s) => s.layerId === id);
    if (!shot || !this.entry) return id === null ? 'Select a shot first.' : `Layer "${id}" places no scene.`;
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
    // A project with no scenes yet isn't an error: the stage offers to start one (ADR 0013).
    this.ui.emptyProject = lib.entries.length === 0;
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
    this.meter.reset();
    this.lastFpsUpdate = -Infinity;
    this.uiDirty = true;
    this.schedule();
    return true;
  }

  private pauseInternal(): void {
    this.resumeWhenValid = false;
    if (!this.clock.playing) return;
    this.clock.pause();
    this.meter.reset();
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
    this.meter.reset();
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
        this.seekInternal(this.clock.frame + action.delta, false);
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
        this.escape();
        break;
      case 'mute':
        if (this.soundStatus !== 'none') this.toggleMute();
        break;
      case 'ignore':
        break;
    }
  };

  // ---- picking ----

  private validScene(): Scene | null {
    return this.clock.timeline ? (this.entry?.scene ?? null) : null;
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
  };

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
    if (down && isDrag(down, at)) return;
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
    if (this.pointer && !this.hoverHidden && this.hoverFailedFrame !== frame && !this.clock.playing && !this.scrubbing) {
      const p = this.scenePoint(this.pointer);
      if (p) {
        try {
          next = this.hit(p.x, p.y).layerId;
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
  }

  /** Escape clears one thing: the hover, else the layer (and part), else the range. */
  private escape(): void {
    const hoverShowing = this.hoverLayer !== null && this.hoverLayer !== this.layerId;
    if (hoverShowing) {
      this.hoverHidden = true;
      this.hoverLayer = null;
      this.schedule();
    } else if (this.layerId !== null) {
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
    if (layerId === null) this.selectionPoint = null;
    this.selectionChanged();
  }

  private userSetRange(range: FrameRange | null): void {
    this.range = range;
    this.selectionChanged();
  }

  private selectionChanged(): void {
    this.notice = null;
    this.uiDirty = true;
    this.syncUrl();
    this.schedulePublish();
    this.schedule();
  }

  // ---- handoff to the agent ----

  /** What a request is about: the layer (and part) and range picked, the whole range with no layer, or the whole scene with nothing picked. */
  private requestSelection(): RequestSelection | null {
    const scene = this.validScene();
    if (!scene) return null;
    const from = this.range?.from ?? 0;
    const to = this.range?.to ?? this.total;
    return {
      sceneId: this.entry!.key,
      ...(this.layerId !== null ? { layerId: this.layerId } : {}),
      ...(this.layerId !== null && this.partId !== null ? { partId: this.partId } : {}),
      from,
      to,
    };
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
    this.studio.onExport((event) => {
      const state = this.ui.exporting;
      if (state.running?.id !== event.id) return;
      if ('error' in event) this.ui.exporting = { ...state, running: null, result: { error: event.error } };
      else if ('file' in event) this.ui.exporting = { ...state, running: null, result: { file: event.file, ...(event.note ? { note: event.note } : {}) } };
      else this.ui.exporting = { ...state, running: { id: event.id, stage: event.stage, done: event.done, total: event.total } };
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
    try {
      localStorage.setItem(MUTED_KEY, this.sound.isMuted ? '1' : '0');
    } catch {
      // storage unavailable; the setting lasts until reload
    }
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
    return { ...this.entry?.world, surfaces: this.surfaces };
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
      this.meter.record(now);
      this.canvasDirty = true;
      this.uiDirty = true;
      this.syncUrl();
    }
    if (this.clock.playing && now - this.lastFpsUpdate >= 250) {
      this.lastFpsUpdate = now;
      this.uiDirty = true;
    }
    this.flushNow(now);
    if (this.clock.playing) this.schedule();
  };

  private flushNow(now = performance.now()): void {
    if (this.canvasDirty) this.drawNow();
    this.syncSound();
    if (this.uiDirty) this.syncUi(now);
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
      hover: scene ? this.hoverLayer : null,
    });
    this.view.canvas.classList.toggle('is-over-layer', scene !== null && this.hoverLayer !== null);
  }

  private drawNow(): DrawResult {
    this.canvasDirty = false;
    const scene = this.entry?.scene ?? null;
    const registry = this.entry?.registry ?? null;
    if (!scene || !registry) {
      this.view.clear();
      return { kind: 'skipped', reason: 'no valid scene is loaded' };
    }
    const frame = this.clock.frame;
    const world = this.world();
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

  private syncUi(now: number): void {
    this.uiDirty = false;
    const scene = this.clock.timeline ? (this.entry?.scene ?? null) : null;
    const ui = this.ui;
    ui.playing = this.clock.playing;
    ui.canPlay = scene !== null;
    const status = this.soundStatus === 'ready' && !this.sound.unlocked ? 'locked' : this.soundStatus;
    ui.sound = scene && status !== 'none' ? { status, muted: this.sound.isMuted } : null;
    ui.band = scene && this.range ? { range: this.range, frameCount: this.total } : null;
    ui.shots = scene ? this.shotBands() : null;
    ui.sounds = scene ? this.soundBands(scene) : null;
    ui.usesMedia = scene !== null && mediaUsed(scene, this.entry?.world ?? {}).length > 0;
    ui.back = this.shotReturn ? { label: this.shotReturn.key.slice(this.shotReturn.key.indexOf('/') + 1), key: this.shotReturn.key } : null;
    ui.selection = {
      sceneId: scene ? (this.entry?.key ?? null) : null,
      layer: layerLabel(this.layerId, this.partId),
      shot: scene && this.layerId !== null ? (this.shots().find((s) => s.layerId === this.layerId)?.label ?? null) : null,
      range: scene ? this.range : null,
      rangeText: scene ? describeRange(this.range, scene.fps, this.total) : null,
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
    };
    ui.fps = { scene: scene.fps, measured: this.clock.playing ? this.meter.fps(now) : null };
  }

  /** The shots for the scrubber, each in the lowest lane where it overlaps no other. Null without any. */
  private shotBands(): { bands: ShotBand[]; lanes: number; frameCount: number } | null {
    const shots = this.shots();
    if (shots.length === 0) return null;
    const laneEnds: number[] = [];
    const bands = [...shots]
      .sort((a, b) => a.span.from - b.span.from)
      .map((s): ShotBand => {
        let lane = laneEnds.findIndex((end) => end <= s.span.from);
        if (lane < 0) lane = laneEnds.push(0) - 1;
        laneEnds[lane] = s.span.to;
        return { layerId: s.layerId, label: s.label, from: s.span.from, to: s.span.to, lane, selected: s.layerId === this.layerId };
      });
    return { bands, lanes: laneEnds.length, frameCount: this.total };
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
        return app.seekInternal(frame, true);
      },
      play(): void {
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
        app.pauseInternal();
        app.clock.seek(frame);
        app.meter.reset();
        const result = app.drawNow();
        app.syncUi(performance.now());
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
        const from = app.range?.from ?? 0;
        const to = app.range?.to ?? app.total;
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
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
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

