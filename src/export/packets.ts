// Encoded packets as bytes, for a parallel MP4 export (ADR 0019). Each render
// worker encodes one segment of the frame range and writes its packets to a
// sink as records; the studio server reads them back and muxes them in order.
// A record is a 4-byte big-endian header length, the header as JSON, a 4-byte
// data length and the data. Times stay integers (microseconds for video,
// samples for audio), so the server rebuilds exactly the timestamps the page
// would have handed the muxer. Import-free, so Node loads it too.

export type PacketRecord =
  /** The encoder's decoder config; data is the avcC from `description`. */
  | { kind: 'video-config'; codec: string; codedWidth: number; codedHeight: number; data: Uint8Array }
  /** One video chunk, timestamps in microseconds from the export's first frame. */
  | { kind: 'video'; key: boolean; timestamp: number; duration: number; data: Uint8Array }
  /** The audio encoder's decoder config; data is its `description`, empty when it has none. */
  | {
      kind: 'audio-config';
      codec: 'aac' | 'opus';
      /** The codec string the encoder was configured with. */
      codecString: string;
      /** The decoder config's own codec string. */
      configCodec: string;
      sampleRate: number;
      numberOfChannels: number;
      priming: number;
      data: Uint8Array;
    }
  /** One audio packet, start and length in samples, start already shifted back by the priming. */
  | { kind: 'audio'; key: boolean; start: number; length: number; data: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One record's bytes. */
export function packRecord(record: PacketRecord): Uint8Array {
  const { data, ...rest } = record;
  const header = encoder.encode(JSON.stringify(rest));
  const out = new Uint8Array(8 + header.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, header.length);
  out.set(header, 4);
  view.setUint32(4 + header.length, data.length);
  out.set(data, 8 + header.length);
  return out;
}

/** The records in `bytes`, in the order they were written. Throws on a truncated or garbled file. */
export function* unpackRecords(bytes: Uint8Array): Generator<PacketRecord> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 4) throw new Error(`truncated packet record at byte ${at}`);
    const headerLength = view.getUint32(at);
    if (bytes.length - at < 8 + headerLength) throw new Error(`truncated packet record at byte ${at}`);
    const header = JSON.parse(decoder.decode(bytes.subarray(at + 4, at + 4 + headerLength))) as Omit<PacketRecord, 'data'>;
    const dataLength = view.getUint32(at + 4 + headerLength);
    const start = at + 8 + headerLength;
    if (bytes.length - start < dataLength) throw new Error(`truncated packet record at byte ${at}`);
    yield { ...header, data: bytes.slice(start, start + dataLength) } as PacketRecord;
    at = start + dataLength;
  }
}

/**
 * Collects records and hands them to `flush` in batches of about `batchBytes`,
 * so a worker makes a few large writes instead of one per frame.
 */
export class RecordWriter {
  private parts: Uint8Array[] = [];
  private pending = 0;
  private position = 0;
  private readonly flushBatch: (data: Uint8Array, position: number) => void | Promise<void>;
  private readonly batchBytes: number;

  constructor(flush: (data: Uint8Array, position: number) => void | Promise<void>, batchBytes = 1 << 20) {
    this.flushBatch = flush;
    this.batchBytes = batchBytes;
  }

  async add(record: PacketRecord): Promise<void> {
    const bytes = packRecord(record);
    this.parts.push(bytes);
    this.pending += bytes.length;
    if (this.pending >= this.batchBytes) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.pending === 0) return;
    const out = new Uint8Array(this.pending);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    const position = this.position;
    this.position += out.length;
    this.parts = [];
    this.pending = 0;
    await this.flushBatch(out, position);
  }
}
