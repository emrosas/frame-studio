// Where export bytes go. Each shell brings its own sink: the CLI writes
// through Playwright to a file, Electron will send them over IPC, and the web
// app collects them for a download (ADR 0001). Exporters only ever call write
// and close.

export interface ByteSink {
  /**
   * Writes `data` at byte offset `position`. Writes can go back to patch
   * earlier bytes (MP4 box sizes). The exporter may reuse `data` once the
   * returned promise settles, so a sink that keeps the bytes must copy them.
   */
  write(data: Uint8Array, position: number): void | Promise<void>;
  /** Called once after the last write. */
  close?(): void | Promise<void>;
}

/** A sink that keeps the file in memory, for downloads and tests. */
export function memorySink(): ByteSink & { bytes(): Uint8Array } {
  let buffer = new Uint8Array(1 << 16);
  let length = 0;
  return {
    write(data, position) {
      const end = position + data.length;
      if (end > buffer.length) {
        const grown = new Uint8Array(Math.max(end, buffer.length * 2));
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      buffer.set(data, position);
      length = Math.max(length, end);
    },
    bytes: () => buffer.slice(0, length),
  };
}
