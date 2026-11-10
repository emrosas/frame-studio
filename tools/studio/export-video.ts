// MP4 and GIF exports for every caller (the viewer's Export button, the MCP
// tool, the CLI), through the render pool. A long MP4 splits across render
// workers (ADR 0019): each encodes one segment of the frame range, starting
// on a key frame, and writes its packets to a temporary file as records; one
// worker encodes the sound once (ADR 0005); and this process muxes the
// segments in order into the file with the same muxer the page uses. A short
// export, a GIF, or one worker takes the single-page path. Node only.

import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EncodedPacket } from 'mediabunny';
import { Mp4Muxer, type MuxAudio } from '../../src/export/mp4-mux.ts';
import { unpackRecords } from '../../src/export/packets.ts';
import { defaultWorkers, InOrder, splitRange, type Segment } from '../../src/export/segments.ts';
import { frameTimestampUs } from '../../src/export/timing.ts';
import type { ByteSink } from '../../src/export/sink.ts';
import type { AudioTrackResult, ExportStages, ExportTarget, RenderExportResult, RenderSceneInfo, SegmentResult } from '../../src/viewer/render-api.ts';
import type { RenderPool, RenderProgress } from './render-pool.ts';

export interface ExportVideoOptions {
  target: ExportTarget;
  from?: number;
  to?: number;
  silent?: boolean;
  audioCodec?: 'aac' | 'opus';
  /** Render workers to share an MP4 across. Defaults to what the machine's cores and memory allow; 1 is the single-page path. */
  workers?: number;
  /** Shortest export, in seconds, worth splitting: helpers take a second or two to open. Default 10; tests set it lower. */
  minParallelSeconds?: number;
  signal?: AbortSignal;
  onProgress?(progress: RenderProgress): void;
}

/** A parallel export with no progress from any job for this long gives up. Rendering a long sound alone can take a while. */
const STALL_MS = 120_000;

/** The worker count an export uses when not told: see defaultWorkers. FRAME_STUDIO_EXPORT_WORKERS overrides it. */
export function exportWorkers(): number {
  const set = Number(process.env.FRAME_STUDIO_EXPORT_WORKERS);
  if (Number.isInteger(set) && set >= 1) return Math.min(16, set);
  return defaultWorkers(availableParallelism(), totalmem());
}

/** A sink onto an open file. */
function fileSink(handle: Awaited<ReturnType<typeof open>>): ByteSink {
  return {
    write: async (data, position) => void (await handle.write(data, 0, data.length, position)),
  };
}

function addStages(into: ExportStages, add: ExportStages): void {
  for (const key of Object.keys(into) as (keyof ExportStages)[]) into[key] += add[key];
}

/** Exports `scene` to `path`, through `path`.partial so a failed export never leaves a file that looks whole. */
export async function exportVideoFile(pool: RenderPool, scene: string, path: string, options: ExportVideoOptions): Promise<RenderExportResult> {
  const info = (await pool.call(scene, 'info', [], { signal: options.signal })) as { scene: RenderSceneInfo | null; errors: string[] };
  if (!info.scene || info.errors.length > 0) throw new Error(`Scene "${scene}" cannot render:\n${info.errors.join('\n')}`);
  const from = options.from ?? 0;
  const to = options.to ?? info.scene.frameCount;
  const workers = Math.max(1, Math.floor(options.workers ?? exportWorkers()));
  const segments =
    options.target === 'mp4' &&
    workers > 1 &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 0 &&
    to <= info.scene.frameCount &&
    to - from >= (options.minParallelSeconds ?? 10) * info.scene.fps
      ? splitRange(from, to, info.scene.fps, { workers })
      : [];
  const partial = `${path}.partial`;
  await mkdir(dirname(path), { recursive: true });
  try {
    if (segments.length < 2) {
      const sink = await pool.openSink(partial);
      try {
        const result = (await pool.call(scene, 'exportVideo', [options.target, sink, { from: options.from, to: options.to, silent: options.silent, audioCodec: options.audioCodec }], {
          signal: options.signal,
          onProgress: options.onProgress,
        })) as RenderExportResult;
        await pool.closeSink(sink);
        await rename(partial, path);
        return { ...result, workers: 1, segments: 1 };
      } finally {
        await pool.closeSink(sink);
      }
    }
    const result = await parallelMp4(pool, scene, info.scene, partial, segments, workers, options);
    await rename(partial, path);
    return result;
  } finally {
    await rm(partial, { force: true });
  }
}

async function parallelMp4(
  pool: RenderPool,
  scene: string,
  info: RenderSceneInfo,
  partial: string,
  segments: Segment[],
  workers: number,
  options: ExportVideoOptions,
): Promise<RenderExportResult> {
  const start = performance.now();
  const from = segments[0].from;
  const to = segments.at(-1)!.to;
  const total = to - from;
  const { fps } = info;
  // One failure, or the caller's cancel, stops every job.
  const abort = new AbortController();
  const stop = () => abort.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  const release = pool.lease(Math.min(workers, segments.length) - 1);
  const dir = await mkdtemp(join(tmpdir(), 'frame-studio-export-'));
  const sinks: string[] = [];
  const done = new Array<number>(segments.length).fill(0);
  let lastReport = 0;
  /** When any job last reported progress: a parallel export that goes quiet this long has a stuck worker. */
  let heard = performance.now();
  let stalled: Error | null = null;
  const watchdog = setInterval(() => {
    if (performance.now() - heard < STALL_MS) return;
    stalled = new Error(`No render worker reported progress for ${STALL_MS / 1000} s, so the export stopped. Try again, or export with one worker.`);
    abort.abort();
  }, 5_000);
  watchdog.unref();
  const report = (force = false) => {
    const now = performance.now();
    heard = now;
    if (!force && now - lastReport < 100) return;
    lastReport = now;
    options.onProgress?.({ stage: 'encoding', done: done.reduce((a, b) => a + b, 0), total });
  };
  const sinkFor = async (name: string) => {
    const file = join(dir, name);
    const id = await pool.openSink(file);
    sinks.push(id);
    return { id, file };
  };
  const call = <T>(method: string, args: unknown[], onProgress?: (p: RenderProgress) => void) =>
    pool.call(scene, method, args, { signal: abort.signal, ...(onProgress ? { onProgress } : {}) }) as Promise<T>;

  let muxer: Mp4Muxer | null = null;
  let settled: Promise<unknown> | null = null;
  const handle = await open(partial, 'w');
  try {
    // Sound first, so the main worker starts on it while helpers open.
    const wantsAudio = info.audio && !options.silent;
    const audioSink = wantsAudio ? await sinkFor('audio.bin') : null;
    const audioJob = audioSink
      ? call<AudioTrackResult | null>('encodeAudioTrack', [audioSink.id, { from, to, audioCodec: options.audioCodec }], (p) => {
          heard = performance.now();
          options.onProgress?.(p);
        })
      : Promise.resolve(null);
    const segmentSinks = await Promise.all(segments.map((_, i) => sinkFor(`segment-${i}.bin`)));
    const jobs = segments.map((segment, i) =>
      call<SegmentResult>('encodeSegment', [segmentSinks[i].id, { from: segment.from, to: segment.to, origin: from }], (p) => {
        heard = performance.now();
        if (p.stage !== 'encoding') return;
        done[i] = p.done;
        report();
      }),
    );
    settled = Promise.allSettled([audioJob, ...jobs]);
    const failed = new Promise<never>((_, reject) => {
      for (const job of [audioJob, ...jobs]) job.catch((err: unknown) => reject(err));
    });
    failed.catch(() => {});

    // Encoding errors from any job end the wait at once; the rest are cancelled below.
    const audioResult = await Promise.race([audioJob, failed]);
    let audio: MuxAudio | null = null;
    let audioCodecString: string | undefined;
    if (audioResult && audioSink) {
      audio = readAudio(await readFile(audioSink.file));
      audioCodecString = audioResult.codecString;
    }
    muxer = await Mp4Muxer.start(fileSink(handle), { fps, frames: total, audio });

    const stages: ExportStages = { prepare: 0, draw: 0, raster: 0, convert: 0, encode: 0, mux: 0, audio: audioResult?.ms ?? 0 };
    const order = new InOrder<{ index: number; result: SegmentResult }>();
    let reference: { codec: string; description: string } | null = null;
    let codec = '';
    // Mux each segment as soon as every one before it is in, one batch after another.
    let chain: Promise<void> = Promise.resolve();
    const muxed = Promise.all(
      jobs.map((job, index) =>
        job.then((result) => {
          const ready = order.done(index, { index, result });
          chain = chain.then(async () => {
            for (const r of ready) {
              const bytes = await readFile(segmentSinks[r.index].file);
              reference = await muxSegment(muxer!, bytes, r.index, reference);
              addStages(stages, r.result.stages);
              codec = r.result.codec;
              await rm(segmentSinks[r.index].file, { force: true });
            }
          });
          return chain;
        }),
      ),
    );
    await Promise.race([muxed, failed]);
    if (order.released !== segments.length) throw new Error(`only ${order.released} of ${segments.length} segments were muxed`);
    await muxer.finish();
    stages.mux += muxer.ms;
    report(true);
    await settled;
    return {
      target: 'mp4',
      from,
      to,
      frames: total,
      seconds: frameTimestampUs(total, fps) / 1e6,
      ms: performance.now() - start,
      codec,
      ...(audioCodecString ? { audioCodec: audioCodecString } : {}),
      stages,
      workers: Math.min(workers, segments.length),
      segments: segments.length,
    };
  } catch (err) {
    abort.abort();
    await muxer?.cancel();
    // Cancelled jobs end at their next frame; wait for them so no worker still writes into the files below.
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
    throw stalled ?? abortedError(err, options.signal);
  } finally {
    clearInterval(watchdog);
    options.signal?.removeEventListener('abort', stop);
    release();
    await handle.close().catch(() => {});
    for (const id of sinks) await pool.closeSink(id);
    await rm(dir, { recursive: true, force: true });
  }
}

function abortedError(err: unknown, signal: AbortSignal | undefined): Error {
  if (signal?.aborted) return new Error('Cancelled.');
  return err instanceof Error ? err : new Error(String(err));
}

/** The sound a parallel export's audio job wrote, as the muxer takes it. */
export function readAudio(bytes: Uint8Array): MuxAudio {
  let audio: MuxAudio | null = null;
  let sampleRate = 0;
  for (const record of unpackRecords(bytes)) {
    if (record.kind === 'audio-config') {
      sampleRate = record.sampleRate;
      audio = {
        codec: record.codec,
        packets: [],
        decoderConfig: {
          codec: record.configCodec,
          sampleRate: record.sampleRate,
          numberOfChannels: record.numberOfChannels,
          ...(record.data.length > 0 ? { description: record.data } : {}),
        },
      };
    } else if (record.kind === 'audio') {
      if (!audio) throw new Error('the audio records start without a config');
      // The page made these as start / sampleRate; so do we, to the same double.
      audio.packets.push(new EncodedPacket(record.data, record.key ? 'key' : 'delta', record.start / sampleRate, record.length / sampleRate));
    } else throw new Error(`unexpected ${record.kind} record in the audio track`);
  }
  if (!audio) throw new Error('the audio job wrote no config');
  return audio;
}

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/**
 * Feeds one segment's packets to the muxer. The first segment's decoder
 * config goes in with its first packet; every later segment's must match it
 * byte for byte, since an MP4 track holds one avcC.
 */
export async function muxSegment(
  muxer: Pick<Mp4Muxer, 'addVideo'>,
  bytes: Uint8Array,
  index: number,
  reference: { codec: string; description: string } | null,
): Promise<{ codec: string; description: string }> {
  let config: VideoDecoderConfig | null = null;
  let first = true;
  let seen = reference;
  for (const record of unpackRecords(bytes)) {
    if (record.kind === 'video-config') {
      const mine = { codec: record.codec, description: hexOf(record.data) };
      if (seen && (seen.codec !== mine.codec || seen.description !== mine.description)) {
        throw new Error(`Segment ${index}'s encoder wrote a different SPS/PPS from segment 0's (${mine.codec} against ${seen.codec}), so the segments can't share one track. Export with one worker.`);
      }
      if (!seen) config = { codec: record.codec, codedWidth: record.codedWidth, codedHeight: record.codedHeight, description: record.data };
      seen = mine;
      continue;
    }
    if (record.kind !== 'video') throw new Error(`unexpected ${record.kind} record in segment ${index}`);
    if (first && !record.key) throw new Error(`segment ${index} does not start on a key frame`);
    const packet = new EncodedPacket(record.data, record.key ? 'key' : 'delta', record.timestamp / 1e6, record.duration / 1e6);
    await muxer.addVideo(packet, first && config ? config : undefined);
    first = false;
  }
  if (!seen) throw new Error(`segment ${index} has no decoder config`);
  return seen;
}
