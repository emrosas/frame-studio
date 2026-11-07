// Decoded picture clips (ADR 0014), for the viewer and the render worker. The
// engine stays synchronous: a host awaits prepare() for what a frame needs,
// then render() reads it from at(). A video frame is the last one that starts
// at or before t, whether reached by playing or by seeking, so the two match.

import type { VideoSample, VideoSampleSink } from 'mediabunny';
import { isImageFile, type PictureRequest } from '../engine';
import type { Picture, Pictures } from '../engine';

interface Reader {
  input: { dispose(): void };
  sink: VideoSampleSink;
  width: number;
  height: number;
  /** Walking forward through the file; closed and started again on a jump back or far ahead. */
  samples: AsyncGenerator<VideoSample, void, unknown> | null;
  current: VideoSample | null;
  ahead: VideoSample | null;
}

/** Frames a host keeps. A frame can show two clips of one file; the viewer scrubs back and forth across a few. */
const KEEP = 8;
/** Beyond this, a seek is faster than decoding through. */
const FAR = 2;

export class PictureStore implements Pictures {
  private readonly url: (file: string) => string;
  private readonly images = new Map<string, Promise<Picture>>();
  private readonly readers = new Map<string, Promise<Reader>>();
  private readonly frames = new Map<string, Picture>();
  private readonly latest = new Map<string, Picture>();
  private readonly spare: OffscreenCanvas[] = [];
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(url: (file: string) => string) {
    this.url = url;
  }

  /** The frame for (file, t), or the file's latest while it decodes, so playback holds instead of flashing. */
  at(file: string, t: number): Picture | null {
    return this.frames.get(`${file}|${t}`) ?? this.latest.get(file) ?? null;
  }

  /** Decodes what `requests` need, in order. Rejects if a file can't be read. */
  prepare(requests: readonly PictureRequest[]): Promise<void> {
    const run = this.queue.then(async () => {
      for (const { file, t } of requests) await this.decode(file, t);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async decode(file: string, t: number): Promise<void> {
    const key = `${file}|${t}`;
    if (this.frames.has(key)) return;
    const generation = this.generation;
    const picture = isImageFile(file) ? await this.image(file) : await this.videoFrame(file, t);
    // A dispose while this decoded means the file may have changed, so its frame is not kept.
    if (generation !== this.generation) return;
    this.frames.set(key, picture);
    this.latest.set(file, picture);
    if (this.frames.size <= KEEP) return;
    const oldest = this.frames.keys().next().value as string;
    const gone = this.frames.get(oldest);
    this.frames.delete(oldest);
    // One canvas per kept frame, not one per frame decoded: at 4K, that's 33 MB a frame.
    if (gone?.image instanceof OffscreenCanvas && ![...this.latest.values()].includes(gone) && ![...this.frames.values()].includes(gone)) this.spare.push(gone.image);
  }

  /** Lets go of decoders, samples and frames. The next prepare starts again, so a replaced file decodes afresh. */
  dispose(): void {
    this.generation++;
    const readers = [...this.readers.values()];
    this.readers.clear();
    this.images.clear();
    this.frames.clear();
    this.latest.clear();
    this.spare.length = 0;
    this.queue = this.queue.then(async () => {
      for (const held of readers) {
        const r = await held.catch(() => null);
        if (!r) continue;
        await r.samples?.return();
        r.current?.close();
        r.ahead?.close();
        r.input.dispose();
      }
    });
  }

  private async bytes(file: string): Promise<Blob> {
    const res = await fetch(this.url(file), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${file}: the studio server answered ${res.status}`);
    return res.blob();
  }

  private image(file: string): Promise<Picture> {
    let held = this.images.get(file);
    if (!held) {
      held = this.bytes(file)
        .then((blob) => createImageBitmap(blob))
        .then((image) => ({ image, width: image.width, height: image.height }));
      this.images.set(file, held);
      held.catch(() => this.images.delete(file));
    }
    return held;
  }

  private reader(file: string): Promise<Reader> {
    let held = this.readers.get(file);
    if (!held) {
      held = (async () => {
        // Only a scene with video pays for the decoder.
        const { ALL_FORMATS, BlobSource, Input, VideoSampleSink } = await import('mediabunny');
        const input = new Input({ source: new BlobSource(await this.bytes(file)), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error(`${file} has no video track`);
        if (!(await track.canDecode())) throw new Error(`${file}: this build can't decode its video`);
        return {
          input,
          // Software decoding where it can, so frames match across machines as closely as they can.
          sink: new VideoSampleSink(track, { hardwareAcceleration: 'prefer-software' }),
          width: track.displayWidth,
          height: track.displayHeight,
          samples: null,
          current: null,
          ahead: null,
        };
      })();
      this.readers.set(file, held);
      held.catch(() => this.readers.delete(file));
    }
    return held;
  }

  private async videoFrame(file: string, t: number): Promise<Picture> {
    const r = await this.reader(file);
    const near = r.current && t >= r.current.timestamp && t - r.current.timestamp < FAR;
    if (!near) {
      await r.samples?.return();
      r.current?.close();
      r.ahead?.close();
      r.samples = r.sink.samples(t);
      r.current = (await r.samples.next()).value ?? null;
      r.ahead = null;
    }
    while (r.samples) {
      r.ahead ??= (await r.samples.next()).value ?? null;
      if (!r.ahead || r.ahead.timestamp > t) break;
      r.current?.close();
      r.current = r.ahead;
      r.ahead = null;
    }
    if (!r.current) throw new Error(`${file} has no frame at ${t} s`);
    let canvas = this.spare.pop() ?? new OffscreenCanvas(r.width, r.height);
    if (canvas.width !== r.width || canvas.height !== r.height) canvas = new OffscreenCanvas(r.width, r.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!ctx) throw new Error('This browser did not provide an offscreen 2D context.');
    r.current.draw(ctx, 0, 0, r.width, r.height);
    return { image: canvas, width: r.width, height: r.height };
  }
}
