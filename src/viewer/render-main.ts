// Render mode (render.html?scene=<id>): no UI, one canvas at scene size, and
// window.studio for the headless tools. The canvas follows ticket 03: CPU
// raster ({ willReadFrequently: true }), sRGB, no devicePixelRatio transform.
// Exports encode here, in the page that draws the frames (ticket 14). The
// scene's audio renders once, offline, and exports slice it (M7).

import { hasAudio, renderSceneAudio, SAMPLE_RATE, samplesPerFrame } from '../audio';
import { formatTimecode, frameCount, hitTest, render, type Ctx2D, type RigRegistry, type Scene, type World } from '../engine';
import { createSurfaces } from '../embed/surfaces';
import {
  contactSheetFrames,
  contactSheetLayout,
  exportGif,
  exportMp4,
  type AudioTrackSource,
  type ByteSink,
  type ExportProgress,
  type FrameSource,
} from '../export';
import { findEntry } from './library';
import type { ContactSheetResult, ExportTarget, RenderExportResult, RenderHostBindings, RenderStudioApi } from './render-api';
import { loadLibrary } from './scenes';
import { parseFrameText, rangeError } from './selection';

declare global {
  interface Window extends RenderHostBindings {
    __studioProgress?(stage: string, done: number, total: number): void;
  }
}

/** The one way this page makes a 2D context (ticket 03, recommendation 3). */
function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
  return ctx;
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A sink that hands bytes to the host through window.__studioWrite. */
function hostSink(sinkId: string): ByteSink {
  const write = window.__studioWrite;
  if (!write) throw new Error('No host is listening for bytes: window.__studioWrite is missing. Run exports through the render tools.');
  return {
    write: (data, position) => write(sinkId, toBase64(data), position),
    close: () => window.__studioClose?.(sinkId),
  };
}

function progress(p: ExportProgress): void {
  window.__studioProgress?.(p.stage, p.done, p.total);
}

async function blobBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The canvas could not be encoded as PNG.');
  return new Uint8Array(await blob.arrayBuffer());
}

async function hex(data: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function boot(): RenderStudioApi {
  const library = loadLibrary();
  const requested = new URLSearchParams(location.search).get('scene');
  const entry = requested ? findEntry(library, requested) : (library.entries[0] ?? null);
  const errors: string[] = [...library.errors];
  if (!entry) errors.push(requested ? `No scene "${requested}". Scenes: ${library.entries.map((e) => e.key).join(', ')}` : 'There are no scenes.');
  else errors.push(...entry.errors.map((e) => `${entry.file}: ${e}`));
  const scene: Scene | null = entry?.scene ?? null;
  const registry: RigRegistry | null = entry?.registry ?? null;
  const project = entry?.project ? library.projects.find((p) => p.id === entry.project) : undefined;
  if (project) errors.push(...project.errors.map((e) => `${project.file}: ${e}`));
  // Surfaces rasterize on the CPU like the canvas, so masks and fades give the same pixels everywhere.
  const world: World = { ...entry?.world, surfaces: createSurfaces({ willReadFrequently: true, colorSpace: 'srgb' }) };
  const total = scene ? frameCount(scene) : 0;
  const sound = scene !== null && hasAudio(scene, world);
  if (sound && !library.generators) errors.push('The scene has audio, but the audio generators failed to load.');

  const canvas = document.createElement('canvas');
  canvas.width = scene?.size[0] ?? 0;
  canvas.height = scene?.size[1] ?? 0;
  document.body.append(canvas);
  const ctx = context2d(canvas);

  let probe: OffscreenCanvasRenderingContext2D | null = null;
  const need = (): { scene: Scene; registry: RigRegistry } => {
    if (!scene || !registry || errors.length > 0) throw new Error(`Cannot render.\n${errors.join('\n')}`);
    return { scene, registry };
  };
  const checkFrame = (frame: number) => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= total) {
      throw new RangeError(`frame must be an integer in [0, ${total}) for scene "${scene?.id}", got ${String(frame)}`);
    }
  };
  const draw = (frame: number) => {
    const ready = need();
    checkFrame(frame);
    render(ctx as unknown as Ctx2D, ready.scene, frame, ready.registry, world);
    return canvas;
  };
  const range = (from = 0, to = total) => {
    need();
    const problem = rangeError(from, to, total);
    if (problem) throw new RangeError(`${problem} (scene "${scene?.id}")`);
    return { from, to };
  };

  let rendered: Promise<AudioBuffer> | null = null;
  /** The whole scene's audio, rendered on first use. */
  const sceneAudio = (): Promise<AudioBuffer> => {
    const { scene: s } = need();
    if (!library.generators) throw new Error('The audio generators failed to load.');
    if (!rendered) {
      const attempt = renderSceneAudio(s, library.generators, world);
      rendered = attempt;
      // Don't keep a failure, so the next call tries again.
      attempt.catch(() => {
        if (rendered === attempt) rendered = null;
      });
    }
    return rendered;
  };

  document.title = scene ? `${scene.id} · render · Frame Studio` : 'render · Frame Studio';

  return {
    ready: true,
    scene: scene ? { id: scene.id, out: entry?.project ? `${entry.project}/${scene.id}` : scene.id, fps: scene.fps, frameCount: total, width: scene.size[0], height: scene.size[1], audio: sound } : null,
    errors,
    scenes: library.entries.map((e) => e.key),
    canvas,
    resolveFrame(text, end = false) {
      const { scene: s } = need();
      const parsed = parseFrameText(text, s.fps);
      if (!parsed.ok) throw new Error(parsed.error);
      if (!(end && parsed.frame === total)) checkFrame(parsed.frame);
      return parsed.frame;
    },
    renderFrame(frame) {
      draw(frame);
      return frame;
    },
    async audioHash() {
      if (!sound) return null;
      const buffer = await sceneAudio();
      const bytes = new Uint8Array(buffer.length * buffer.numberOfChannels * 4);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        bytes.set(new Uint8Array(buffer.getChannelData(c).slice().buffer), c * buffer.length * 4);
      }
      return hex(bytes);
    },
    async pixelHash(frame) {
      draw(frame);
      return hex(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    },
    async writePng(frame, sinkId, options = {}) {
      draw(frame);
      let source = canvas;
      if (options.maxWidth !== undefined && options.maxWidth < canvas.width) {
        const scale = options.maxWidth / canvas.width;
        source = document.createElement('canvas');
        source.width = Math.round(canvas.width * scale);
        source.height = Math.round(canvas.height * scale);
        const small = context2d(source);
        small.imageSmoothingQuality = 'high';
        small.drawImage(canvas, 0, 0, source.width, source.height);
      }
      const bytes = await blobBytes(source);
      const sink = hostSink(sinkId);
      await sink.write(bytes, 0);
      await sink.close?.();
      return bytes.length;
    },
    hitTest(frame, x, y, options = {}) {
      const ready = need();
      checkFrame(frame);
      probe ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      if (!probe) throw new Error('This browser did not provide an offscreen 2D context for hit testing.');
      const result = hitTest(probe as unknown as Ctx2D, ready.scene, frame, x, y, ready.registry, { parts: options.parts, world });
      return { layerId: result.layerId, ...(result.partId !== undefined ? { partId: result.partId } : {}), candidates: result.candidates };
    },
    async exportVideo(target: ExportTarget, sinkId, options = {}): Promise<RenderExportResult> {
      const { scene: s } = need();
      const r = range(options.from, options.to);
      const source: FrameSource = { width: s.size[0], height: s.size[1], fps: s.fps, draw };
      const sink = hostSink(sinkId);
      const start = performance.now();
      if (target === 'mp4') {
        let audio: AudioTrackSource | undefined;
        if (sound && !options.silent) {
          progress({ stage: 'rendering audio', done: 0, total: r.to - r.from });
          const buffer = await sceneAudio();
          const spf = samplesPerFrame(s.fps);
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(r.from * spf, r.to * spf));
          audio = { sampleRate: SAMPLE_RATE, channels };
        }
        const out = await exportMp4(source, r, sink, { onProgress: progress, audio, audioCodec: options.audioCodec });
        return {
          target,
          ...r,
          frames: out.frames,
          seconds: out.durationUs / 1e6,
          ms: performance.now() - start,
          codec: out.codec,
          ...(out.audio ? { audioCodec: out.audio.codecString } : {}),
        };
      }
      if (target === 'gif') {
        const out = await exportGif(source, r, sink, { onProgress: progress });
        return { target, ...r, frames: out.frames, seconds: out.durationCs / 100, ms: performance.now() - start, colours: out.colours };
      }
      throw new Error(`unknown export target ${JSON.stringify(target)}; use mp4 or gif`);
    },
    async contactSheet(sinkId, options = {}): Promise<ContactSheetResult> {
      const { scene: s } = need();
      const r = range(options.from, options.to);
      const frames = contactSheetFrames(r.from, r.to, options.every);
      const layout = contactSheetLayout({ count: frames.length, frameWidth: s.size[0], frameHeight: s.size[1], columns: options.columns });
      const sheet = document.createElement('canvas');
      sheet.width = layout.width;
      sheet.height = layout.height;
      const out = context2d(sheet);
      out.fillStyle = '#18191b';
      out.fillRect(0, 0, sheet.width, sheet.height);
      out.imageSmoothingQuality = 'high';
      out.font = '13px monospace'; // a generic family only (CLAUDE.md, runtime budget)
      out.textBaseline = 'middle';
      frames.forEach((frame, i) => {
        const { x, y } = layout.cell(i);
        out.drawImage(draw(frame), x, y, layout.thumbWidth, layout.thumbHeight);
        out.fillStyle = '#c9cbcf';
        out.fillText(`${frame}  ${formatTimecode(frame, s.fps)}`, x + 2, y + layout.thumbHeight + layout.labelHeight / 2);
        progress({ stage: 'contact sheet', done: i + 1, total: frames.length });
      });
      const sink = hostSink(sinkId);
      await sink.write(await blobBytes(sheet), 0);
      await sink.close?.();
      return { frames, width: layout.width, height: layout.height };
    },
  };
}

const api = boot();
Object.assign(window, { studio: api });
