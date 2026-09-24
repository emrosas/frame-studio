import { describe, expect, it } from 'vitest';
import { FpsMeter, PlaybackClock } from './clock';

describe('FpsMeter', () => {
  it('returns null until it has two samples', () => {
    const meter = new FpsMeter();
    expect(meter.fps(0)).toBeNull();
    meter.record(0);
    expect(meter.fps(0)).toBeNull();
  });

  it('measures the displayed frame rate over the trailing window', () => {
    const meter = new FpsMeter(1000);
    const clock = new PlaybackClock(() => 0);
    clock.setTimeline({ fps: 12, frameCount: 120 });
    clock.play();
    let now = 0;
    for (let i = 0; i < 180; i++) {
      now = i * (1000 / 60);
      if (clock.tick(now)) meter.record(now);
    }
    const fps = meter.fps(now);
    expect(fps).not.toBeNull();
    expect(fps!).toBeGreaterThan(11);
    expect(fps!).toBeLessThan(13);
  });

  it('forgets samples older than the window', () => {
    const meter = new FpsMeter(1000);
    meter.record(0);
    meter.record(100);
    expect(meter.fps(500)).toBeCloseTo(10);
    expect(meter.fps(5000)).toBeNull();
  });
});
