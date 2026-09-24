// The single-file embed's player: one canvas at scene size, a playback loop,
// and a small API for host pages. It ships inside every HTML export, so it
// follows the runtime rules: no packages, and imports from the engine only.
// Its one exception is the wall clock, which picks the frame to show during
// playback; render() itself never sees time.
//
// Host pages control it two ways:
// - Same origin: window.studio in the embed's document (play, pause, seek).
// - Any origin, e.g. an iframe: postMessage({ type: 'frame-studio', command, frame? }) with
//   command 'play', 'pause', 'seek' (with a numeric frame), 'mute', 'unmute' or
//   'state'. The embed answers every message with { type: 'frame-studio:state',
//   frame, playing, frameCount, fps }, plus muted for a scene with sound and
//   error when it could not do what was asked. It also posts that state to its
//   parent once on load; a host that starts listening later can send 'state'.
//
// A scene with sound shows a speaker button. Sound starts muted, because
// browsers only allow it after a click or key press in the embed; the button
// turns it on.

import { createRegistry } from '../engine/registry';
import { render } from '../engine/render';
import { frameCount } from '../engine/time';
import { PlaybackClock } from '../engine/playback';
import type { Ctx2D, Rig, Scene } from '../engine/types';
import type { EmbedSound, EmbedSoundFactory, EmbedSoundState } from './sound';

export interface EmbedOptions {
  /** Start playing on load. Default true. */
  autoplay?: boolean;
  /** Loop at the end. Default true; off, playback stops on the last frame. */
  loop?: boolean;
  /** Frame to show first. Default 0. */
  frame?: number;
}

export interface EmbedApi {
  readonly frame: number;
  readonly playing: boolean;
  readonly frameCount: number;
  readonly fps: number;
  readonly canvas: HTMLCanvasElement;
  /** The scene's sound, or null when the embed is silent. */
  readonly sound: EmbedSoundState | null;
  play(): void;
  pause(): void;
  /** Shows frame n at once, clamped into the scene. Keeps playing if playing. Returns the frame shown. */
  seek(frame: number): number;
  /** Sound on or off. Browsers only allow sound on from a click or key press in the embed. */
  setMuted(muted: boolean): Promise<void>;
}

export interface EmbedState {
  type: 'frame-studio:state';
  frame: number;
  playing: boolean;
  frameCount: number;
  fps: number;
  /** Whether sound is off, including while the browser waits for a click in the embed. Left out when the embed is silent. */
  muted?: boolean;
  /** Why the last command did nothing, e.g. a seek without a numeric frame or an embed that failed to draw. */
  error?: string;
}

/** Reads autoplay, loop and frame from a query string such as "?autoplay=0&loop=0&frame=12". */
export function optionsFromQuery(search: string): EmbedOptions {
  const q = new URLSearchParams(search);
  const flag = (name: string) => (q.has(name) ? !/^(0|false|no|off)$/i.test(q.get(name) ?? '') : undefined);
  const frame = q.get('frame') ?? '';
  return { autoplay: flag('autoplay'), loop: flag('loop'), frame: /^\d+$/.test(frame) ? Number(frame) : undefined };
}

const SPEAKER = 'M2 6h2.5L8 3v10L4.5 10H2z';
const WAVES = 'M10 5.2a3.5 3.5 0 0 1 0 5.6l-.8-1a2.2 2.2 0 0 0 0-3.6zM11.8 3a6.3 6.3 0 0 1 0 10l-.8-1a5 5 0 0 0 0-8z';
const CROSS = 'M10.2 5.6l1-1 1.8 1.8 1.8-1.8 1 1-1.8 1.8 1.8 1.8-1 1-1.8-1.8-1.8 1.8-1-1 1.8-1.8z';

/** The speaker button in the corner, drawn with inline SVG so the file stays asset-free. */
function soundButton(root: HTMLElement, onClick: () => void): (muted: boolean) => void {
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText =
    'position:absolute;right:12px;bottom:12px;width:36px;height:36px;padding:8px;border:0;border-radius:50%;' +
    'background:rgba(20,20,20,.55);color:#fff;cursor:pointer;line-height:0';
  button.addEventListener('click', onClick);
  root.append(button);
  return (muted) => {
    button.setAttribute('aria-label', muted ? 'Turn sound on' : 'Turn sound off');
    button.title = button.getAttribute('aria-label') ?? '';
    button.innerHTML = `<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="${SPEAKER}"/><path d="${muted ? CROSS : WAVES}"/></svg>`;
  };
}

/**
 * Mounts the player in `root`. `sound` comes from the generated entry for a
 * scene with audio (sound.ts); a silent embed passes nothing.
 */
export function mountEmbed(root: HTMLElement, scene: Scene, rigs: readonly Rig[], options: EmbedOptions = {}, sound?: EmbedSoundFactory): EmbedApi {
  const registry = createRegistry(rigs);
  const [width, height] = scene.size;
  const total = frameCount(scene);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', scene.id);
  root.append(canvas);
  // The same attributes the headless renderer uses (ticket 03), so frames match its PNGs pixel for pixel.
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');

  const clock = new PlaybackClock(() => performance.now(), { loop: options.loop ?? true });
  clock.setTimeline({ fps: scene.fps, frameCount: total });
  clock.seek(options.frame ?? 0);

  let failed: string | null = null;
  let raf = 0;
  const draw = () => {
    if (failed) return;
    try {
      render(ctx as unknown as Ctx2D, scene, clock.frame, registry);
    } catch (err) {
      failed = `This animation could not draw frame ${clock.frame}: ${err instanceof Error ? err.message : String(err)}`;
      clock.pause();
      const message = document.createElement('pre');
      message.textContent = failed;
      root.replaceChildren(message);
    }
  };
  let audio: EmbedSound | null = null;
  let showMuted: ((muted: boolean) => void) | null = null;
  /** Sound is on only once asked for and allowed by the browser. */
  const soundOff = () => !audio || audio.state.muted || !audio.state.unlocked;
  /**
   * Keeps the sound on the playhead: started, stopped, looped or resynced. It
   * reads the clock now, after any draw, so drawing time doesn't count as drift.
   */
  const syncSound = () => {
    if (!audio) return;
    const loop = clock.activeLoop ?? { from: 0, to: 0 };
    audio.update({
      playing: clock.playing,
      seconds: clock.position(performance.now()) / scene.fps,
      loop: { from: loop.from / scene.fps, to: loop.to / scene.fps },
      repeat: options.loop ?? true,
    });
  };
  if (sound) {
    audio = sound(scene, () => {
      syncSound();
      showMuted?.(soundOff());
    });
    // While the browser still holds sound back, a click asks for it again rather than muting.
    showMuted = soundButton(root, () => void audio?.setMuted(!soundOff()));
    showMuted(true);
  }

  const tick = (now: number) => {
    raf = 0;
    if (clock.tick(now)) draw();
    syncSound();
    if (clock.playing) raf = requestAnimationFrame(tick);
  };
  const schedule = () => {
    if (raf === 0 && clock.playing) raf = requestAnimationFrame(tick);
  };

  const api: EmbedApi = {
    get frame() {
      return clock.frame;
    },
    get playing() {
      return clock.playing;
    },
    frameCount: total,
    fps: scene.fps,
    canvas,
    get sound() {
      return audio?.state ?? null;
    },
    play() {
      if (failed) return;
      const before = clock.frame;
      clock.play();
      if (clock.frame !== before) draw();
      syncSound();
      schedule();
    },
    pause() {
      clock.pause();
      syncSound();
    },
    seek(frame) {
      if (failed) return clock.frame;
      const shown = clock.seek(frame);
      draw();
      syncSound();
      schedule();
      return shown;
    },
    async setMuted(muted) {
      await audio?.setMuted(muted);
    },
  };

  const state = (error?: string): EmbedState => ({
    type: 'frame-studio:state',
    frame: clock.frame,
    playing: clock.playing,
    frameCount: total,
    fps: scene.fps,
    ...(audio ? { muted: soundOff() } : {}),
    ...(error ?? failed ? { error: error ?? failed ?? undefined } : {}),
  });
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: unknown; command?: unknown; frame?: unknown } | null;
    if (!data || data.type !== 'frame-studio') return;
    let error: string | undefined;
    if (data.command === 'play') api.play();
    else if (data.command === 'pause') api.pause();
    else if (data.command === 'mute' || data.command === 'unmute') {
      if (audio) void api.setMuted(data.command === 'mute');
      else error = 'this embed has no sound';
    }
    else if (data.command === 'seek') {
      if (typeof data.frame === 'number' && Number.isFinite(data.frame)) api.seek(data.frame);
      else error = `seek needs a numeric frame, got ${JSON.stringify(data.frame)}`;
    } else if (data.command !== 'state') error = `unknown command ${JSON.stringify(data.command)}; use play, pause, seek, mute, unmute or state`;
    (e.source as Window | null)?.postMessage(state(error), { targetOrigin: '*' });
  });

  draw();
  if (options.autoplay ?? true) api.play();
  if (window.parent !== window) window.parent.postMessage(state(), '*');
  return api;
}
