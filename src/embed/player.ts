// The single-file embed's player: one canvas at scene size, a playback loop,
// and a small API for host pages. It ships inside every HTML export, so it
// follows the runtime rules: no packages, and imports from the engine only.
// Its one exception is the wall clock, which picks the frame to show during
// playback; render() itself never sees time.
//
// Host pages control it two ways:
// - Same origin: window.studio in the embed's document (play, pause, seek).
// - Any origin, e.g. an iframe: postMessage({ type: 'frame-studio', command, frame? }) with
//   command 'play', 'pause', 'seek' (with a numeric frame) or 'state'. The embed
//   answers every message with { type: 'frame-studio:state', frame, playing,
//   frameCount, fps }, plus error when it could not do what was asked. It also
//   posts that state to its parent once on load; a host that starts listening
//   later can send 'state' to ask.

import { createRegistry } from '../engine/registry';
import { render } from '../engine/render';
import { frameCount } from '../engine/time';
import { PlaybackClock } from '../engine/playback';
import type { Ctx2D, Rig, Scene } from '../engine/types';

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
  play(): void;
  pause(): void;
  /** Shows frame n at once, clamped into the scene. Keeps playing if playing. Returns the frame shown. */
  seek(frame: number): number;
}

export interface EmbedState {
  type: 'frame-studio:state';
  frame: number;
  playing: boolean;
  frameCount: number;
  fps: number;
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

export function mountEmbed(root: HTMLElement, scene: Scene, rigs: readonly Rig[], options: EmbedOptions = {}): EmbedApi {
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
  const tick = (now: number) => {
    raf = 0;
    if (clock.tick(now)) draw();
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
    play() {
      if (failed) return;
      const before = clock.frame;
      clock.play();
      if (clock.frame !== before) draw();
      schedule();
    },
    pause() {
      clock.pause();
    },
    seek(frame) {
      if (failed) return clock.frame;
      const shown = clock.seek(frame);
      draw();
      schedule();
      return shown;
    },
  };

  const state = (error?: string): EmbedState => ({
    type: 'frame-studio:state',
    frame: clock.frame,
    playing: clock.playing,
    frameCount: total,
    fps: scene.fps,
    ...(error ?? failed ? { error: error ?? failed ?? undefined } : {}),
  });
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: unknown; command?: unknown; frame?: unknown } | null;
    if (!data || data.type !== 'frame-studio') return;
    let error: string | undefined;
    if (data.command === 'play') api.play();
    else if (data.command === 'pause') api.pause();
    else if (data.command === 'seek') {
      if (typeof data.frame === 'number' && Number.isFinite(data.frame)) api.seek(data.frame);
      else error = `seek needs a numeric frame, got ${JSON.stringify(data.frame)}`;
    } else if (data.command !== 'state') error = `unknown command ${JSON.stringify(data.command)}; use play, pause, seek or state`;
    (e.source as Window | null)?.postMessage(state(error), { targetOrigin: '*' });
  });

  draw();
  if (options.autoplay ?? true) api.play();
  if (window.parent !== window) window.parent.postMessage(state(), '*');
  return api;
}
