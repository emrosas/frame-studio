// The studio server's event stream (ADR 0008): the queue, turn events,
// library changes and export progress, over one EventSource that reconnects
// by itself.

type Handler = (data: unknown) => void;

export class StudioEvents {
  private source: EventSource | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly closedHandlers = new Set<() => void>();
  private readonly url: string;

  constructor(url = '/__studio/events') {
    this.url = url;
  }

  /** Calls `handler` with each `event`'s data. Returns an unsubscribe function. */
  on<T>(event: string, handler: (data: T) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
      this.open().addEventListener(event, (e) => {
        const data = JSON.parse((e as MessageEvent<string>).data) as unknown;
        for (const h of this.handlers.get(event) ?? []) h(data);
      });
    }
    set.add(handler as Handler);
    return () => set.delete(handler as Handler);
  }

  /** Calls `handler` if the stream closes for good, as it does when the server refuses it (the pairing is gone). */
  onClosed(handler: () => void): () => void {
    this.closedHandlers.add(handler);
    this.open();
    return () => this.closedHandlers.delete(handler);
  }

  private open(): EventSource {
    if (!this.source) {
      const source = new EventSource(this.url);
      // EventSource reconnects by itself after a dropped connection, but not after an error answer.
      source.addEventListener('error', () => {
        if (source.readyState === EventSource.CLOSED) for (const h of this.closedHandlers) h();
      });
      this.source = source;
    }
    return this.source;
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }
}

/** The page's one stream. */
export const studioEvents = new StudioEvents();
