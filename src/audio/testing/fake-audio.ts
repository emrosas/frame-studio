/**
 * A fake Web Audio graph for unit tests in Node, which has no Web Audio. It
 * records nodes, connections, start and stop times and automation, so tests
 * can check fan-in, frame alignment and seeding without rendering sound.
 * Browser tests render the real thing.
 */

export interface AutomationEvent {
  method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'setValueCurveAtTime';
  value: number | Float32Array;
  time: number;
  duration?: number;
}

export class FakeParam {
  readonly events: AutomationEvent[] = [];
  readonly owner: FakeNode;
  readonly name: string;
  value: number;
  constructor(owner: FakeNode, name: string, value: number) {
    this.owner = owner;
    this.name = name;
    this.value = value;
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ method: 'setValueAtTime', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ method: 'linearRampToValueAtTime', value, time });
    return this;
  }
  setValueCurveAtTime(values: Float32Array, time: number, duration: number): this {
    this.events.push({ method: 'setValueCurveAtTime', value: Float32Array.from(values), time, duration });
    return this;
  }
}

export class FakeBuffer {
  private readonly channels: Float32Array[];
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(i: number): Float32Array {
    return this.channels[i];
  }
}

const PARAMS: Record<string, readonly string[]> = {
  GainNode: ['gain'],
  OscillatorNode: ['frequency', 'detune'],
  BiquadFilterNode: ['frequency', 'Q', 'gain', 'detune'],
  AudioBufferSourceNode: ['playbackRate', 'detune'],
  StereoPannerNode: ['pan'],
};

export class FakeNode {
  readonly params: Record<string, FakeParam> = {};
  readonly options: Record<string, unknown>;
  readonly graph: FakeAudio;
  readonly kind: string;
  startTime?: number;
  stopTime?: number;
  constructor(graph: FakeAudio, kind: string, options: Record<string, unknown> = {}) {
    this.graph = graph;
    this.kind = kind;
    this.options = options;
    for (const name of PARAMS[kind] ?? []) {
      const param = new FakeParam(this, name, typeof options[name] === 'number' ? (options[name] as number) : 0);
      this.params[name] = param;
      Object.defineProperty(this, name, { value: param, enumerable: true });
    }
    graph.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(target: T): T {
    this.graph.connections.push({ from: this, to: target });
    return target;
  }
  startOffset?: number;
  startDuration?: number;
  disconnected = false;
  start(time = 0, offset?: number, duration?: number): void {
    this.startTime = time;
    this.startOffset = offset;
    this.startDuration = duration;
  }
  stop(time = 0): void {
    this.stopTime = time;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

export interface FakeAudio {
  ctx: BaseAudioContext;
  destination: FakeNode;
  nodes: FakeNode[];
  connections: { from: FakeNode; to: FakeNode | FakeParam }[];
  /** Every node or param with more than two connections in, as readable strings. */
  fanInProblems(): string[];
  sources(): FakeNode[];
  restore(): void;
}

/** Installs fake node constructors on globalThis. Call restore() when done. */
export function installFakeAudio(): FakeAudio {
  const graph = { nodes: [], connections: [] } as unknown as FakeAudio;
  const destination = new FakeNode(graph, 'AudioDestinationNode');
  const ctx = {
    destination,
    sampleRate: 48000,
    createBuffer: (channels: number, length: number, rate: number) => new FakeBuffer(channels, length, rate),
  };
  const saved: Record<string, unknown> = {};
  const g = globalThis as Record<string, unknown>;
  for (const kind of Object.keys(PARAMS)) {
    saved[kind] = g[kind];
    g[kind] = class extends FakeNode {
      constructor(_ctx: unknown, options?: Record<string, unknown>) {
        super(graph, kind, options);
      }
    };
  }
  Object.assign(graph, {
    ctx: ctx as unknown as BaseAudioContext,
    destination,
    fanInProblems() {
      const counts = new Map<FakeNode | FakeParam, number>();
      for (const { to } of graph.connections) counts.set(to, (counts.get(to) ?? 0) + 1);
      return [...counts]
        .filter(([, n]) => n > 2)
        .map(([to, n]) => (to instanceof FakeParam ? `${to.owner.kind}.${to.name}` : to.kind) + ` has ${n} inputs`);
    },
    sources() {
      return graph.nodes.filter((n) => n.kind === 'OscillatorNode' || n.kind === 'AudioBufferSourceNode');
    },
    restore() {
      for (const [kind, value] of Object.entries(saved)) g[kind] = value;
    },
  });
  return graph;
}

/** Whether `node` feeds `target`, directly or through other nodes (not through params). */
export function reaches(graph: FakeAudio, node: FakeNode, target: FakeNode): boolean {
  const seen = new Set<FakeNode>();
  const walk = (n: FakeNode): boolean => {
    if (n === target) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return graph.connections.some(({ from, to }) => from === n && to instanceof FakeNode && walk(to));
  };
  return walk(node);
}
