import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRIFT_TOLERANCE, LivePlayback, wrapInto, wrappedDifference, type Playhead } from './live';
import { installFakeAudio, type FakeAudio, type FakeNode } from './testing/fake-audio';

describe('wrapInto / wrappedDifference', () => {
  it('wraps into [from, to)', () => {
    expect(wrapInto(5, 2, 4)).toBe(3);
    expect(wrapInto(1.5, 2, 4)).toBe(3.5);
    expect(wrapInto(3, 2, 4)).toBe(3);
  });

  it('measures the short way round a loop', () => {
    expect(wrappedDifference(0.1, 3.9, 4)).toBeCloseTo(0.2, 9);
    expect(wrappedDifference(3.9, 0.1, 4)).toBeCloseTo(-0.2, 9);
    expect(wrappedDifference(2, 1, 4)).toBe(1);
  });
});

describe('LivePlayback', () => {
  let audio: FakeAudio;
  let ctx: { state: string; currentTime: number; outputLatency: number; baseLatency: number; destination: unknown; resume(): Promise<void>; close(): Promise<void> };
  let live: LivePlayback;
  const buffer = { duration: 4 } as AudioBuffer;
  const head = (seconds: number, loop = { from: 0, to: 4 }, playing = true, repeat = true): Playhead => ({ playing, seconds, loop, repeat });
  const sources = () => audio.nodes.filter((n) => n.kind === 'AudioBufferSourceNode');
  const current = () => sources().filter((n) => !n.disconnected);

  beforeEach(async () => {
    audio = installFakeAudio();
    ctx = {
      state: 'suspended',
      currentTime: 10,
      outputLatency: 0.02,
      baseLatency: 0.01,
      destination: audio.destination,
      resume: async () => void (ctx.state = 'running'),
      close: async () => void (ctx.state = 'closed'),
    };
    live = new LivePlayback(() => ctx as unknown as AudioContext);
    live.setBuffer(buffer);
  });
  afterEach(() => audio.restore());

  it('stays silent until unlocked by a gesture', async () => {
    live.update(head(1));
    expect(sources()).toHaveLength(0);
    await live.unlock();
    live.update(head(1));
    expect(sources()).toHaveLength(1);
  });

  it('starts ahead by the output latency, looping over the loop span', async () => {
    await live.unlock();
    live.update(head(1, { from: 0.5, to: 2 }));
    const [s] = sources() as FakeNode[];
    expect(s.startTime).toBe(10);
    expect(s.startOffset).toBeCloseTo(1.03, 9);
    expect(s.options).toMatchObject({ loop: true, loopStart: 0.5, loopEnd: 2 });
  });

  it('keeps playing while in step, and starts over once it drifts', async () => {
    await live.unlock();
    live.update(head(1));
    ctx.currentTime += 0.5;
    live.update(head(1.5 + DRIFT_TOLERANCE / 2));
    expect(sources()).toHaveLength(1);
    live.update(head(1.5 + DRIFT_TOLERANCE * 2));
    expect(sources()).toHaveLength(2);
    expect(current()).toHaveLength(1);
  });

  it('counts a wrap at the loop end as in step', async () => {
    await live.unlock();
    live.update(head(3.9));
    ctx.currentTime += 0.2; // heard 4.1, which is 0.1 into the loop
    live.update(head(0.1));
    expect(sources()).toHaveLength(1);
  });

  it('played once, stops by itself at the loop end and never wraps', async () => {
    await live.unlock();
    live.update(head(3, { from: 0, to: 4 }, true, false));
    const [s] = sources() as FakeNode[];
    expect(s.options).toMatchObject({ loop: false });
    expect(s.startOffset).toBeCloseTo(3.03, 9);
    expect(s.startDuration).toBeCloseTo(0.97, 9);
    // Near the end, a heard time past the end is not "in step" with the start.
    ctx.currentTime += 0.5;
    live.update(head(3.5, { from: 0, to: 4 }, true, false));
    expect(sources()).toHaveLength(1);
    // Nothing starts once the end is already on its way out.
    live.update(head(3.98, { from: 0, to: 4 }, true, false));
    expect(current()).toHaveLength(0);
  });

  it('starts over when the loop changes, and stops on pause, mute or a new buffer', async () => {
    await live.unlock();
    live.update(head(1));
    live.update(head(1, { from: 1, to: 2 }));
    expect(sources()).toHaveLength(2);
    live.update(head(1, { from: 1, to: 2 }, false));
    expect(current()).toHaveLength(0);
    live.update(head(1));
    live.setMuted(true);
    expect(current()).toHaveLength(0);
    live.update(head(1));
    expect(current()).toHaveLength(0);
    live.setMuted(false);
    live.update(head(1));
    live.setBuffer(null);
    expect(current()).toHaveLength(0);
    live.update(head(1));
    expect(current()).toHaveLength(0);
  });
});
