// Viewer controller: owns the selected scene, the playback clock, the canvas,
// the selection (layer, part, frame range) and the HTML overlay. Renders only
// when the frame, the scene, or the canvas size changes.

import { formatTimecode, frameCount as countFrames, hitTest, render, type HitResult, type HitTestOptions } from '../engine';
import type { Scene } from '../engine/types';
import { CanvasView } from './canvas';
import { FpsMeter, PlaybackClock } from './clock';
import { Controls, type SceneOption } from './controls';
import { ErrorPanel, errorText } from './errors';
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
import { SelectionBar } from './selection-bar';
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
  /** Scene keys (ids) in picker order. */
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
  private readonly controls: Controls;
  private readonly bar: SelectionBar;
  private readonly overlay: SelectionOverlay;
  private readonly errors: ErrorPanel;
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

  // ---- selection ----
  private layerId: string | null = null;
  private partId: string | null = null;
  private range: FrameRange | null = null;
  /** Shown in the selection bar until the selection next changes. */
  private notice: string | null = null;
  /** ?layer=&part=&from=&to= waiting for a valid scene to be checked against. */
  private pendingSelection: SelectionParams | null;
  /** Layers and parts of the valid scene on screen; null when none. */
  private shape: SceneShape | null = null;
  /** Bumped on every scene swap, so cached masks and click cycles never outlive an edit. */
  private version = 0;
  private probe: OffscreenCanvasRenderingContext2D | null = null;
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

  constructor(root: HTMLElement, library: SceneLibrary, options: AppOptions) {
    this.library = library;
    this.pendingFrameParam = options.frame;
    const sel = options.selection;
    this.pendingSelection = sel && (sel.layer ?? sel.part ?? sel.from ?? sel.to) !== null ? sel : null;

    const shell = document.createElement('main');
    shell.className = 'viewer';
    const stage = document.createElement('div');
    stage.className = 'stage';
    shell.appendChild(stage);
    root.replaceChildren(shell);

    // Controls first: the footer takes its height out of the stage before
    // CanvasView measures it, so the first render is already the right size.
    this.controls = new Controls(shell, {
      togglePlay: () => this.togglePlay(),
      scrubStart: () => {
        this.resumeAfterScrub = this.clock.playing;
        this.pauseInternal();
        this.scrubbing = true;
        this.hoverLayer = null;
      },
      scrub: (frame) => this.seekInternal(frame, false),
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
    });
    this.bar = new SelectionBar(this.controls.element, {
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
    });
    // The canvas and the overlay share one box, so the overlay lines up with the canvas exactly.
    const frame = document.createElement('div');
    frame.className = 'stage-frame';
    stage.appendChild(frame);
    this.view = new CanvasView(
      stage,
      () => {
        this.drawNow();
        this.syncOverlay();
      },
      frame,
    );
    this.overlay = new SelectionOverlay(frame);
    this.errors = new ErrorPanel(stage);

    // The letterbox around the canvas is outside the scene: a click there clears the layer.
    this.stageElement = stage;
    stage.addEventListener('pointerdown', this.onStagePointerDown);
    stage.addEventListener('click', this.onStageClick);

    const canvas = this.view.canvas;
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown);
    canvas.addEventListener('click', this.onCanvasClick);
    canvas.addEventListener('pointermove', this.onCanvasPointerMove);
    canvas.addEventListener('pointerleave', this.onCanvasPointerLeave);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pagehide', this.onPageHide);

    const { entry: initial, missing } = openingEntry(library, options.scene);
    if (missing && options.scene !== null) {
      this.missingRequest = { scene: options.scene, frame: options.frame, selection: this.pendingSelection };
      this.pendingFrameParam = null;
      this.pendingSelection = null;
    }
    this.selectEntry(initial, false);
    if (options.autoplay) this.playInternal();

    this.api = this.createApi();
  }

  /** Swaps in a freshly loaded library (hot edit of a scene or rig), keeping scene, frame, and play state. */
  setLibrary(library: SceneLibrary): void {
    const previous = this.entry;
    const wasPlaying = this.clock.playing || this.resumeWhenValid;
    this.library = library;
    // The scene the URL asked for now exists (its file was just written): open it at the requested frame.
    const requested = this.missingRequest ? findEntry(library, this.missingRequest.scene) : null;
    if (requested && this.missingRequest) {
      this.pendingFrameParam = this.missingRequest.frame;
      this.pendingSelection = this.missingRequest.selection;
      this.missingRequest = null;
      this.resumeWhenValid = false;
      this.selectEntry(requested, false);
    } else {
      const next = (previous && findEntry(library, previous.key, previous.path)) ?? library.entries[0] ?? null;
      const same = previous !== null && next !== null && (next.key === previous.key || next.path === previous.path);
      this.selectEntry(next, same);
      if (same && wasPlaying && !this.clock.playing) {
        if (!this.playInternal()) this.resumeWhenValid = true;
      }
    }
    this.errors.set('hmr', null);
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

  private userSelect(entry: SceneEntry): void {
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
    const registry = this.library.registry;
    const renderable = scene !== null && registry !== null;
    this.total = scene ? countFrames(scene) : 0;
    this.version++;
    this.shape = renderable ? sceneShape(scene, registry, this.total) : null;
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
    this.controls.setScenes(this.sceneOptions(), entry?.key ?? null);
    document.title = entry ? `${entry.key} · Frame Studio` : 'Frame Studio';
    this.syncUrl();
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

  private sceneOptions(): SceneOption[] {
    return this.library.entries.map((e) => ({ key: e.key, label: e.key, file: e.file, invalid: e.scene === null }));
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
              `No scene in /scenes has the id or file name "${missing.scene}", so the viewer is showing ${this.entry ? `"${this.entry.key}"` : 'nothing'}. Scenes: ${known}.`,
              'Pick a scene from the list, or add the scene file; the viewer opens it as soon as it exists.',
            ],
          }
        : null,
    );
    this.errors.set('library', lib.errors.length > 0 ? { title: 'Rigs failed to load; nothing can render', lines: lib.errors } : null);
    if (lib.entries.length === 0) {
      this.errors.set('scene', {
        title: 'No scenes found',
        lines: ['Add a scene file to /scenes (for example scenes/my-scene.json). The format is under "Scene format" in CLAUDE.md.'],
      });
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
    }
    this.syncUrl();
    if (sync) this.flushNow();
    else this.schedule();
    return after;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return;
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
    const registry = this.library.registry;
    if (!scene || !registry) {
      const why = this.errors.messages;
      throw new Error(`No valid scene to hit test.${why.length ? `\n${why.join('\n')}` : ''}`);
    }
    if (!this.probe) {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('This browser did not provide an OffscreenCanvas 2D context for hit testing.');
      this.probe = ctx;
    }
    return hitTest(this.probe, scene, this.clock.frame, x, y, registry, options);
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
    this.flushNow();
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
    this.schedule();
  }

  // ---- rendering ----

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
      registry: this.library.registry,
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
    const registry = this.library.registry;
    if (!scene || !registry) {
      this.view.clear();
      return { kind: 'skipped', reason: 'no valid scene is loaded' };
    }
    const frame = this.clock.frame;
    try {
      const drawn = this.view.draw((ctx) => render(ctx, scene, frame, registry));
      this.errors.set('render', null);
      return drawn ? { kind: 'drawn' } : { kind: 'skipped', reason: 'the canvas has no size yet (stage not laid out)' };
    } catch (error) {
      const { message, stack } = errorText(error);
      this.errors.set('render', { title: `Render failed at frame ${frame} of "${scene.id}"`, lines: [message], detail: stack });
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
    this.controls.setPlaying(this.clock.playing, scene !== null);
    this.controls.setRange(scene ? this.range : null, this.total);
    this.bar.set({
      sceneId: scene?.id ?? null,
      layer: layerLabel(this.layerId, this.partId),
      range: scene ? this.range : null,
      rangeText: scene ? describeRange(this.range, scene.fps, this.total) : null,
      frameCount: this.total,
      notice: this.notice,
    });
    if (!scene) {
      this.controls.setTimeline(null);
      this.controls.setFps(null, null);
      return;
    }
    const frame = this.clock.frame;
    this.controls.setTimeline({
      frame,
      frameCount: this.total,
      timecode: formatTimecode(frame, scene.fps),
      endTimecode: formatTimecode(this.total, scene.fps),
    });
    this.controls.setFps(scene.fps, this.clock.playing ? this.meter.fps(now) : null);
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
      get playing() {
        return app.clock.playing;
      },
      get scenes() {
        return app.library.entries.map((e) => e.key);
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
          throw new RangeError(`renderFrame: frame must be an integer in [0, ${app.total}) for scene "${scene.id}", got ${String(frame)}`);
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
        if (app.layerId === null) return { sceneId: scene.id, from, to };
        if (app.partId === null) return { sceneId: scene.id, layerId: app.layerId, from, to };
        return { sceneId: scene.id, layerId: app.layerId, partId: app.partId, from, to };
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
            throw new Error(`Unknown layer "${layerId}" in scene "${scene.id}". Layers: ${[...shape.layers.keys()].join(', ')}`);
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
    };
  }
}
