import { describe, expect, it } from 'vitest';
import { clampFrame, PlaybackClock, playbackFrame, wrapFrame } from './playback';

// Deterministic jitter for simulated requestAnimationFrame timestamps.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('wrapFrame / clampFrame', () => {
  it('wraps into [0, count)', () => {
    expect(wrapFrame(0, 120)).toBe(0);
    expect(wrapFrame(119, 120)).toBe(119);
    expect(wrapFrame(120, 120)).toBe(0);
    expect(wrapFrame(245, 120)).toBe(5);
    expect(wrapFrame(-1, 120)).toBe(119);
  });

  it('clamps into [0, count - 1] and truncates', () => {
    expect(clampFrame(-5, 120)).toBe(0);
    expect(clampFrame(500, 120)).toBe(119);
    expect(clampFrame(12.9, 120)).toBe(12);
    expect(clampFrame(Number.NaN, 120)).toBe(0);
    expect(clampFrame(Infinity, 120)).toBe(119);
    expect(clampFrame(-Infinity, 120)).toBe(0);
  });
});

describe('playbackFrame', () => {
  const at0 = { anchorFrame: 0, anchorMs: 0 };

  it('advances one frame per 1000/fps ms', () => {
    expect(playbackFrame(at0, 0, 12, 120)).toBe(0);
    expect(playbackFrame(at0, 83, 12, 120)).toBe(0);
    expect(playbackFrame(at0, 84, 12, 120)).toBe(1);
    expect(playbackFrame(at0, 1000, 12, 120)).toBe(12);
    expect(playbackFrame(at0, 1000, 24, 240)).toBe(24);
  });

  it('counts from the anchor frame and time', () => {
    const anchor = { anchorFrame: 40, anchorMs: 5000 };
    expect(playbackFrame(anchor, 5000, 12, 120)).toBe(40);
    expect(playbackFrame(anchor, 5500, 12, 120)).toBe(46);
  });

  it('loops at frameCount', () => {
    expect(playbackFrame(at0, 10_000, 12, 120)).toBe(0);
    expect(playbackFrame(at0, 10_084, 12, 120)).toBe(1);
    expect(playbackFrame({ anchorFrame: 115, anchorMs: 0 }, 1000, 12, 120)).toBe(7);
    expect(playbackFrame(at0, 3000, 12, 1)).toBe(0);
  });

  it('treats timestamps before the anchor as zero elapsed', () => {
    // rAF timestamps can precede a performance.now() taken in the click handler.
    expect(playbackFrame({ anchorFrame: 10, anchorMs: 1000 }, 995, 12, 120)).toBe(10);
  });

  it('does not drift over a long run of jittery rAF ticks', () => {
    for (const fps of [12, 24, 25, 30, 60]) {
      const frameCount = fps * 7 + 3;
      const anchor = { anchorFrame: 5, anchorMs: 1234.5 };
      const next = lcg(fps);
      let now = anchor.anchorMs;
      let shown = anchor.anchorFrame;
      let advanced = 0;
      const endMs = anchor.anchorMs + 60 * 60 * 1000; // one hour
      while (now < endMs) {
        now += 1000 / 60 + (next() - 0.5) * 6; // ~60 Hz with +/-3 ms jitter
        const frame = playbackFrame(anchor, now, fps, frameCount);
        advanced += wrapFrame(frame - shown, frameCount);
        shown = frame;
      }
      const expected = Math.floor(((now - anchor.anchorMs) * fps) / 1000);
      expect(advanced).toBe(expected);
      expect(shown).toBe(wrapFrame(anchor.anchorFrame + expected, frameCount));
    }
  });

  it('lands exactly on whole seconds after long runs', () => {
    const anchor = { anchorFrame: 0, anchorMs: 0 };
    // 24 hours at 24 fps with a 1000-frame loop
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(playbackFrame(anchor, oneDayMs, 24, 1000)).toBe((24 * 24 * 60 * 60) % 1000);
  });
});

describe('PlaybackClock', () => {
  function setup(frameCount = 120, fps = 12) {
    let now = 0;
    const clock = new PlaybackClock(() => now);
    clock.setTimeline({ fps, frameCount });
    return {
      clock,
      setNow: (ms: number) => {
        now = ms;
      },
    };
  }

  it('does nothing without a timeline', () => {
    const clock = new PlaybackClock(() => 0);
    expect(clock.play()).toBe(false);
    expect(clock.playing).toBe(false);
    expect(clock.seek(10)).toBe(0);
    expect(clock.tick(1000)).toBe(false);
  });

  it('plays from the current frame in real time and reports changes', () => {
    const { clock, setNow } = setup();
    clock.seek(10);
    setNow(1000);
    clock.play();
    expect(clock.tick(1000)).toBe(false);
    expect(clock.tick(1084)).toBe(true);
    expect(clock.frame).toBe(11);
    expect(clock.tick(1090)).toBe(false);
    expect(clock.tick(2000)).toBe(true);
    expect(clock.frame).toBe(22);
  });

  it('pause freezes the shown frame and resume continues from it', () => {
    const { clock, setNow } = setup();
    clock.play();
    clock.tick(500);
    expect(clock.frame).toBe(6);
    clock.pause();
    expect(clock.tick(5000)).toBe(false);
    expect(clock.frame).toBe(6);
    setNow(9000);
    clock.play();
    clock.tick(9500);
    expect(clock.frame).toBe(12);
  });

  it('seek while playing re-anchors at the new frame', () => {
    const { clock, setNow } = setup();
    clock.play();
    clock.tick(3000);
    setNow(3000);
    expect(clock.seek(100)).toBe(100);
    expect(clock.playing).toBe(true);
    clock.tick(4000);
    expect(clock.frame).toBe(112);
    clock.tick(4700);
    expect(clock.frame).toBe(0); // looped
  });

  it('seek and step clamp without wrapping; step pauses', () => {
    const { clock } = setup();
    expect(clock.seek(-3)).toBe(0);
    expect(clock.seek(999)).toBe(119);
    clock.play();
    expect(clock.step(1)).toBe(119);
    expect(clock.playing).toBe(false);
    expect(clock.step(-12)).toBe(107);
  });

  it('keeps frame and play state across a timeline swap (hot edit)', () => {
    const { clock, setNow } = setup(120, 12);
    clock.play();
    clock.tick(2000);
    expect(clock.frame).toBe(24);
    setNow(2000);
    clock.setTimeline({ fps: 24, frameCount: 240 });
    expect(clock.frame).toBe(24);
    expect(clock.playing).toBe(true);
    clock.tick(3000);
    expect(clock.frame).toBe(48);
  });

  it('clamps the frame when a swap shortens the scene, and stops on null', () => {
    const { clock } = setup();
    clock.seek(100);
    clock.setTimeline({ fps: 12, frameCount: 50 });
    expect(clock.frame).toBe(49);
    clock.play();
    clock.setTimeline(null);
    expect(clock.playing).toBe(false);
    expect(clock.frame).toBe(49);
  });
});

describe('playing once (loop off)', () => {
  it('playbackFrame holds the last frame instead of wrapping', () => {
    const anchor = { anchorFrame: 10, anchorMs: 0 };
    expect(playbackFrame(anchor, 1000, 12, 24, false)).toBe(22);
    expect(playbackFrame(anchor, 5000, 12, 24, false)).toBe(23);
    expect(playbackFrame(anchor, 5000, 12, 24)).toBe((10 + 60) % 24);
  });

  it('stops on the last frame and reports that it is no longer playing', () => {
    let now = 0;
    const clock = new PlaybackClock(() => now, { loop: false });
    clock.setTimeline({ fps: 12, frameCount: 24 });
    clock.seek(20);
    clock.play();
    now = 250;
    expect(clock.tick(now)).toBe(true);
    expect(clock.frame).toBe(23);
    expect(clock.playing).toBe(false);
    now = 2000;
    expect(clock.tick(now)).toBe(false);
    expect(clock.frame).toBe(23);
  });

  it('starts again from frame 0 when played at the end', () => {
    let now = 0;
    const clock = new PlaybackClock(() => now, { loop: false });
    clock.setTimeline({ fps: 12, frameCount: 24 });
    clock.seek(23);
    expect(clock.play()).toBe(true);
    expect(clock.frame).toBe(0);
    now = 500;
    clock.tick(now);
    expect(clock.frame).toBe(6);
  });

  it('loops by default', () => {
    let now = 0;
    const clock = new PlaybackClock(() => now);
    clock.setTimeline({ fps: 12, frameCount: 24 });
    clock.seek(20);
    clock.play();
    now = 500;
    clock.tick(now);
    expect(clock.frame).toBe(2);
    expect(clock.playing).toBe(true);
  });
});

describe('looping inside a frame range', () => {
  function clockAt(options: { loop?: boolean } = {}) {
    const time = { now: 0 };
    const clock = new PlaybackClock(() => time.now, options);
    clock.setTimeline({ fps: 12, frameCount: 96 });
    return { clock, time };
  }

  it('plays [from, to) over and over', () => {
    const { clock, time } = clockAt();
    clock.setLoopRange({ from: 10, to: 14 });
    clock.seek(10);
    clock.play();
    time.now = 500; // 6 frames at 12 fps
    clock.tick(time.now);
    expect(clock.frame).toBe(12);
    time.now = 1000; // 12 frames
    clock.tick(time.now);
    expect(clock.frame).toBe(10);
  });

  it('starts from the range when play is pressed outside it', () => {
    const { clock } = clockAt();
    clock.seek(50);
    clock.setLoopRange({ from: 10, to: 14 });
    clock.play();
    expect(clock.frame).toBe(10);
  });

  it('keeps going from the frame on screen when the range is cleared', () => {
    const { clock, time } = clockAt();
    clock.setLoopRange({ from: 10, to: 14 });
    clock.seek(12);
    clock.play();
    clock.setLoopRange(null);
    time.now = 1000;
    clock.tick(time.now);
    expect(clock.frame).toBe(24);
  });

  it('with loop off, stops on the range\'s last frame', () => {
    const { clock, time } = clockAt({ loop: false });
    clock.setLoopRange({ from: 10, to: 14 });
    clock.play();
    time.now = 2000;
    clock.tick(time.now);
    expect(clock.frame).toBe(13);
    expect(clock.playing).toBe(false);
  });

  it('ignores a range outside the timeline or with no frames', () => {
    const { clock, time } = clockAt();
    clock.setLoopRange({ from: 90, to: 200 });
    clock.seek(94);
    clock.play();
    time.now = 500;
    clock.tick(time.now);
    expect(clock.frame).toBe(90 + ((94 - 90 + 6) % 6));
    clock.setLoopRange({ from: 5, to: 5 });
    expect(clock.loopRange).toBeNull();
  });
});

describe('a loop range across timeline changes', () => {
  it('clamps against the timeline that is current, not the one it was set under', () => {
    const time = { now: 0 };
    const clock = new PlaybackClock(() => time.now);
    clock.setTimeline({ fps: 12, frameCount: 24 });
    clock.setLoopRange({ from: 20, to: 60 });
    expect(clock.loopRange).toEqual({ from: 20, to: 24 });
    clock.setTimeline({ fps: 12, frameCount: 96 });
    expect(clock.loopRange).toEqual({ from: 20, to: 60 });
  });
});
