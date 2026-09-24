// Types for the parts of gifenc 1.0.3 that exports use. The package ships no
// types. Source: https://github.com/mattdesl/gifenc (src/index.js, src/stream.js).
declare module 'gifenc' {
  export interface WriteFrameOptions {
    /** [r, g, b] entries. Required on the first frame; later frames with a palette get a local table. */
    palette?: number[][];
    /** Frame delay in milliseconds; stored as round(delay / 10) centiseconds. */
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    /** -1 plays once, 0 loops forever, n loops n times. */
    repeat?: number;
    colorDepth?: number;
    /** GIF disposal method; 1 keeps the frame under the next one. */
    dispose?: number;
    /** Manual mode only: this frame writes the screen descriptor and global palette. */
    first?: boolean;
  }

  export interface ByteStream {
    reset(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }

  export interface Encoder {
    writeHeader(): void;
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
    readonly stream: ByteStream;
  }

  /** auto: false is manual mode: call writeHeader() yourself and pass first on the first frame. */
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' },
  ): number[][];
}
