// The render worker (render.html?worker, ADR 0008): no UI, a canvas at scene
// size per scene, taking jobs from the studio server over its event stream.
// Each job runs one method of the scene's render API below and posts the
// result back; bytes it makes go back to the server's sinks in chunks. The
// canvas follows ticket 03: CPU raster ({ willReadFrequently: true }), sRGB,
// no devicePixelRatio transform. Exports encode here, in the page that draws
// the frames (ticket 14). A scene's audio renders once, offline, and exports
// slice it (M7). render.html?scene=<id> opens one scene as window.studio, for
// looking at by hand.

import { hasAudio, mediaUsed, renderSceneAudio, SAMPLE_RATE, samplesPerFrame } from '../audio';
import { MediaStore } from './media';
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
import { findEntry, type SceneLibrary } from './library';
import { pair } from './pairing';
import type { ContactSheetResult, ExportTarget, RenderExportResult, RenderStudioApi } from './render-api';
import { loadLibrary } from './scenes';
import { parseFrameText, rangeError } from './selection';

/** Where a render API sends its bytes and progress: the studio server, in worker mode. */
interface RenderHost {
  sink(sinkId: string): ByteSink;
  progress(p: ExportProgress): void;
}

/** The one way this page makes a 2D context (ticket 03, recommendation 3). */
function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
  return ctx;
}

async function post(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(path, { method: 'POST', ...init });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The studio server answered ${res.status}.`);
  return data;
}

/** A sink whose bytes go to the studio server, which writes them into the file it opened for them. */
function serverSink(sinkId: string): ByteSink {
  const at = `/__studio/worker/sinks/${encodeURIComponent(sinkId)}`;
  return {
    write: async (data, position) => void (await post(`${at}?position=${position}`, { headers: { 'Content-Type': 'application/octet-stream' }, body: data.slice() })),
    close: async () => void (await post(`${at}/close`, { headers: { 'Content-Type': 'application/json' }, body: '{}' })),
  };
}

/** A host for looking at a scene by hand: it has nowhere to put bytes. */
const NO_HOST: RenderHost = {
  sink: () => {
    throw new Error('Open render.html as a worker (?worker) to write files; it writes through the studio server.');
  },
  progress: () => {},
};

async function blobBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The canvas could not be encoded as PNG.');
  return new Uint8Array(await blob.arrayBuffer());
}

async function hex(data: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decoded sound files, kept across scene loads while the files don't change (ADR 0012). */
const media = new MediaStore();

/** The render API for scene `requested` in `library`, drawing on a canvas of its own that it adds to the page. */
function boot(library: SceneLibrary, requested: string | null, host: RenderHost): RenderStudioApi {
  const hostSink = (sinkId: string) => host.sink(sinkId);
  const progress = (p: ExportProgress) => host.progress(p);
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
  /** The whole scene's audio, rendered on first use, with its sound files (ADR 0012). An export never drops one quietly. */
  const sceneAudio = (): Promise<AudioBuffer> => {
    const { scene: s } = need();
    const generators = library.generators;
    if (!generators) throw new Error('The audio generators failed to load.');
    if (!rendered) {
      const attempt = (async () => {
        const loaded = await media.load(mediaUsed(s, world), library.media ?? []);
        const problems = [...loaded.missing.map((f) => `${f} isn't in the studio folder's media/`), ...loaded.failed];
        if (problems.length > 0) throw new Error(`The scene's sound files can't play: ${problems.join('; ')}.`);
        return renderSceneAudio(s, generators, world, loaded.buffers);
      })();
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
    async audioSamples(from, to, channel = 0) {
      if (!sound) return [];
      const buffer = await sceneAudio();
      return Array.from(buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)).subarray(from, to));
    },
    async audioPeak(from, to) {
      if (!sound) return 0;
      const buffer = await sceneAudio();
      let peak = 0;
      for (let c = 0; c < buffer.numberOfChannels; c++) for (const v of buffer.getChannelData(c).subarray(from, to)) peak = Math.max(peak, Math.abs(v));
      return peak;
    },
    async audioFanIn() {
      const { scene: s } = need();
      if (!library.generators) throw new Error('The audio generators failed to load.');
      const counts = new Map<unknown, Map<number, number>>();
      let max = 0;
      const proto = AudioNode.prototype as unknown as { connect: (...a: unknown[]) => unknown };
      const connect = proto.connect;
      proto.connect = function (this: unknown, ...args: unknown[]) {
        const [destination, , input = 0] = args as [unknown, number?, number?];
        const inputs = counts.get(destination) ?? new Map<number, number>();
        counts.set(destination, inputs);
        const n = (inputs.get(input) ?? 0) + 1;
        inputs.set(input, n);
        max = Math.max(max, n);
        return connect.apply(this, args);
      };
      try {
        await renderSceneAudio(s, library.generators, world);
      } finally {
        proto.connect = connect;
      }
      return max;
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

/** One job from the studio server. */
interface Job {
  id: string;
  scene: string;
  method: string;
  args: unknown[];
  /** The server's file generation when the job was made; an older library loads again first. */
  generation: number;
}

/**
 * Worker mode: takes jobs from the server one at a time, each on the render API of its scene, and posts back
 * what it returns. The library loads again when files changed, and each scene's API is made on first use.
 */
async function runWorker(): Promise<void> {
  // The first load has to succeed before jobs can run; a folder mid-edit may fail it, so keep trying.
  let loaded: Awaited<ReturnType<typeof loadLibrary>>;
  for (;;) {
    try {
      loaded = await loadLibrary();
      break;
    } catch (err) {
      document.title = `render worker: ${err instanceof Error ? err.message : String(err)}`;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const apis = new Map<string, RenderStudioApi>();
  const cancelled = new Set<string>();
  let current: Job | null = null;
  let lastProgress = 0;
  const host: RenderHost = {
    sink: serverSink,
    progress(p) {
      const job = current;
      if (!job) return;
      if (cancelled.has(job.id)) throw new Error('Cancelled.');
      // A few reports a second is plenty, but the last one always goes.
      const now = performance.now();
      if (p.done !== p.total && now - lastProgress < 100) return;
      lastProgress = now;
      // The server answers go: false once the export is cancelled; the next report stops it.
      void post(`/__studio/worker/jobs/${job.id}/progress`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
        .then((answer) => {
          if ((answer as { go?: boolean }).go === false) cancelled.add(job.id);
        })
        .catch(() => {});
    },
  };
  const queue: Job[] = [];
  let running = false;
  const answer = (id: string, value: unknown) =>
    post(`/__studio/worker/jobs/${id}`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).catch(() => {});

  async function run(job: Job): Promise<void> {
    current = job;
    try {
      if (job.generation > loaded.generation) {
        loaded = await loadLibrary();
        for (const api of apis.values()) api.canvas.remove();
        apis.clear();
      }
      let api = apis.get(job.scene);
      if (!api) {
        api = boot(loaded.library, job.scene, host);
        apis.set(job.scene, api);
      }
      const value =
        job.method === 'info'
          ? { scene: api.scene, errors: [...api.errors] }
          : job.method === 'gpu'
            ? ((window as unknown as { frameStudioGpu?: Record<string, string> }).frameStudioGpu ?? null)
            : // JSON turns an argument left out into null; the API's defaults want undefined.
              await (api as unknown as Record<string, (...a: unknown[]) => unknown>)[job.method](...job.args.map((a) => (a === null ? undefined : a)));
      await answer(job.id, { ok: true, value: value ?? null });
    } catch (err) {
      await answer(job.id, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      cancelled.delete(job.id);
      current = null;
    }
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) await run(queue.shift()!);
    } finally {
      running = false;
    }
  }

  const stream = new EventSource('/__studio/worker/stream');
  stream.addEventListener('job', (e) => {
    queue.push(JSON.parse((e as MessageEvent<string>).data) as Job);
    void drain();
  });
  stream.addEventListener('cancel', (e) => cancelled.add((JSON.parse((e as MessageEvent<string>).data) as { id: string }).id));
  document.title = 'render worker · Frame Studio';
}

async function start(): Promise<void> {
  const paired = await pair();
  if (!paired.ok) {
    document.body.textContent = paired.reason;
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.has('worker')) return runWorker();
  const { library } = await loadLibrary();
  Object.assign(window, { studio: boot(library, params.get('scene'), NO_HOST) });
}

void start();
