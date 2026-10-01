// Sound files for the viewer and the render worker (ADR 0012): fetched from
// the studio server, decoded at 48 kHz once, and kept until the file on disk
// changes. Also the waveform peaks the timeline draws.

import { decodeMedia } from '../audio/media';

/** A sound file in the studio folder, as the studio server lists it. */
export interface MediaEntry {
  file: string;
  bytes: number;
  modified: number;
}

export interface LoadedMedia {
  buffers: Map<string, AudioBuffer>;
  /** Files a scene plays that aren't in media/. */
  missing: string[];
  /** Files that are there but wouldn't fetch or decode, each "file: why". */
  failed: string[];
}

const url = (file: string) => `/__studio/${file.split('/').map(encodeURIComponent).join('/')}`;

export class MediaStore {
  private readonly decoded = new Map<string, { stamp: string; buffer: Promise<AudioBuffer> }>();
  private readonly peakCache = new Map<string, Float32Array>();

  /** Decodes the `files` a scene plays, reusing earlier decodes of files that haven't changed. */
  async load(files: readonly string[], known: readonly MediaEntry[]): Promise<LoadedMedia> {
    const byFile = new Map(known.map((m) => [m.file, m]));
    const out: LoadedMedia = { buffers: new Map(), missing: [], failed: [] };
    await Promise.all(
      files.map(async (file) => {
        const entry = byFile.get(file);
        if (!entry) {
          out.missing.push(file);
          return;
        }
        const stamp = `${entry.bytes}:${entry.modified}`;
        let held = this.decoded.get(file);
        if (!held || held.stamp !== stamp) {
          const buffer = fetch(url(file), { cache: 'no-store' }).then(async (res) => {
            if (!res.ok) throw new Error(`the studio server answered ${res.status}`);
            return decodeMedia(await res.arrayBuffer());
          });
          held = { stamp, buffer };
          this.decoded.set(file, held);
          for (const key of [...this.peakCache.keys()]) if (key.startsWith(`${file}|`)) this.peakCache.delete(key);
          // Don't keep a failure, so the next load tries again.
          buffer.catch(() => {
            if (this.decoded.get(file) === held) this.decoded.delete(file);
          });
        }
        try {
          out.buffers.set(file, await held.buffer);
        } catch (err) {
          out.failed.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    out.missing.sort();
    out.failed.sort();
    return out;
  }

  /** The file's decoded audio, if it has been loaded. */
  async decodedOf(file: string): Promise<AudioBuffer | null> {
    return (await this.decoded.get(file)?.buffer.catch(() => null)) ?? null;
  }

  /**
   * The loudest sample, 0 to 1, in each of `buckets` slices of seconds [from, to) of a decoded file, for a
   * waveform. Null until the file is decoded.
   */
  async peaks(file: string, from: number, to: number, buckets: number): Promise<Float32Array | null> {
    const key = `${file}|${from}|${to}|${buckets}`;
    const cached = this.peakCache.get(key);
    if (cached) return cached;
    const buffer = await this.decodedOf(file);
    if (!buffer) return null;
    const out = new Float32Array(buckets);
    const start = Math.max(0, Math.round(from * buffer.sampleRate));
    const end = Math.min(buffer.length, Math.round(to * buffer.sampleRate));
    const per = Math.max(1, (end - start) / buckets);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let b = 0; b < buckets; b++) {
        const lo = Math.floor(start + b * per);
        const hi = Math.min(end, Math.floor(start + (b + 1) * per));
        let peak = out[b];
        for (let i = lo; i < hi; i++) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
        }
        out[b] = Math.min(1, peak);
      }
    }
    this.peakCache.set(key, out);
    return out;
  }
}
