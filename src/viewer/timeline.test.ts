import { describe, expect, it } from 'vitest';
import { dragClip, dragSpan, formatClock, labelFits, markerLabels, rulerTicks, snapDelta, snapFrame, visibleSpans } from './timeline';

describe('formatClock', () => {
  it('reads minutes, seconds and hundredths', () => {
    expect(formatClock(0, 30)).toBe('0:00.00');
    expect(formatClock(30, 30)).toBe('0:01.00');
    expect(formatClock(45, 30)).toBe('0:01.50');
    expect(formatClock(1, 24)).toBe('0:00.04');
    expect(formatClock(30 * 125, 30)).toBe('2:05.00');
  });

  it('never rounds a frame down into the one before', () => {
    for (let frame = 0; frame < 3000; frame++) expect(formatClock(frame, 30)).toBe(formatClock(frame, 30));
    expect(formatClock(7, 7)).toBe('0:01.00');
  });
});

describe('rulerTicks', () => {
  it('labels as often as the width allows, always from zero', () => {
    const ticks = rulerTicks(40, 800);
    expect(ticks[0]).toEqual({ t: 0, label: '0:00' });
    const labels = ticks.filter((t) => t.label !== null);
    expect(labels[1].t).toBe(5);
    expect(labels.at(-1)?.t).toBe(35);
  });

  it('puts unlabelled ticks between labels and nothing at the end', () => {
    const ticks = rulerTicks(10, 1000);
    expect(ticks.filter((t) => t.label === null).length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.t < 10)).toBe(true);
  });

  it('goes under a second on a short timeline', () => {
    const labels = rulerTicks(2, 1000).filter((t) => t.label !== null);
    expect(labels[1].t).toBeLessThan(1);
    expect(labels[1].label).toBe('0:00.25');
  });

  it('has nothing to show without a size', () => {
    expect(rulerTicks(0, 100)).toEqual([]);
    expect(rulerTicks(10, 0)).toEqual([]);
  });
});

describe('dragClip', () => {
  const clip = { from: 30, in: 10, out: 40, length: 60 };

  it('moves a clip without leaving the composition', () => {
    expect(dragClip(clip, 'move', 12, 300).from).toBe(42);
    expect(dragClip(clip, 'move', -100, 300).from).toBe(0);
    expect(dragClip(clip, 'move', 1000, 300).from).toBe(299);
  });

  it('trims the start with the picture staying put', () => {
    const later = dragClip(clip, 'start', 5, 300);
    expect(later).toMatchObject({ from: 35, in: 15, out: 40 });
    expect(later.from - later.in).toBe(clip.from - clip.in);
  });

  it('stops a start trim at the first frame of what it places and at frame 0', () => {
    expect(dragClip(clip, 'start', -50, 300)).toMatchObject({ from: 20, in: 0 });
    expect(dragClip({ ...clip, from: 4 }, 'start', -50, 300)).toMatchObject({ from: 0, in: 6 });
  });

  it('keeps a frame when trimmed from either end', () => {
    expect(dragClip(clip, 'start', 500, 300)).toMatchObject({ in: 39, out: 40 });
    expect(dragClip(clip, 'end', -500, 300)).toMatchObject({ in: 10, out: 11 });
  });

  it('stops an end trim at the end of what it places', () => {
    expect(dragClip(clip, 'end', 500, 300).out).toBe(60);
  });
});

describe('snapFrame', () => {
  it('lands on a target within 6 px, and the nearest of several', () => {
    expect(snapFrame(20, [18, 40], 2)).toBe(18);
    expect(snapFrame(20, [17, 40], 2)).toBe(17);
    expect(snapFrame(20, [16, 19, 22], 2)).toBe(19);
  });

  it('stays put beyond 6 px, and with nothing to snap to', () => {
    expect(snapFrame(20, [16], 2)).toBe(20);
    expect(snapFrame(20, [], 2)).toBe(20);
    expect(snapFrame(20, [21], 0)).toBe(20);
  });

  it('reaches further in frames when frames are narrow', () => {
    expect(snapFrame(100, [112], 0.5)).toBe(112);
    expect(snapFrame(100, [113], 0.5)).toBe(100);
  });
});

describe('dragSpan', () => {
  it('works in either direction', () => {
    expect(dragSpan(12, 36, 72)).toEqual({ from: 12, to: 36 });
    expect(dragSpan(36, 12, 72)).toEqual({ from: 12, to: 36 });
  });

  it('keeps one frame inside the scene', () => {
    expect(dragSpan(10, 10, 72)).toEqual({ from: 10, to: 11 });
    expect(dragSpan(72, 72, 72)).toEqual({ from: 71, to: 72 });
    expect(dragSpan(0, 500, 72)).toEqual({ from: 0, to: 72 });
  });
});

describe('labelFits', () => {
  it('says whether text fits, so a band hides its label rather than clip it', () => {
    expect(labelFits('hum', 40)).toBe(true);
    expect(labelFits('background-music', 40)).toBe(false);
  });
});

describe('markerLabels', () => {
  const px = (from: number, to: number) => to - from;

  it('gives a sync point its label over the plain marker beside it', () => {
    expect(markerLabels([{ frame: 0, label: 'hook ends' }, { frame: 40, label: 'chunk lands!' }, { frame: 60, label: 'turn' }], 400, px)).toEqual([false, true, false]);
  });

  it('labels everything when there is room', () => {
    expect(markerLabels([{ frame: 0, label: 'a' }, { frame: 100, label: 'b!' }], 400, px)).toEqual([true, true]);
  });

  it('hides sync labels only against other sync points', () => {
    expect(markerLabels([{ frame: 0, label: 'chunk lands!' }, { frame: 20, label: 'crystal locks!' }], 400, px)).toEqual([false, true]);
  });
});

describe('snapDelta', () => {
  it('lands the nearest edge on a target', () => {
    expect(snapDelta([10, 30], 4, [15], 2)).toBe(5);
    expect(snapDelta([10, 30], 4, [16, 33], 2)).toBe(3);
  });

  it('keeps the delta with nothing near', () => {
    expect(snapDelta([10, 30], 4, [100], 2)).toBe(4);
  });
});

describe('visibleSpans', () => {
  const opacity = (...keys: [number, number][]) => ({ tracks: [{ param: 'opacity', keys: keys.map(([t, v]) => ({ t, v })) }] });

  it('is empty with no opacity track', () => {
    expect(visibleSpans({}, 12, 48)).toEqual([]);
    expect(visibleSpans({ tracks: [{ param: 'x', keys: [{ t: 0, v: 1 }] }] }, 12, 48)).toEqual([]);
  });

  it('covers the frames above zero, with the keys of each fade', () => {
    const spans = visibleSpans(opacity([1, 0], [1.5, 1], [3, 1], [3.5, 0]), 12, 48);
    expect(spans).toEqual([{ from: 13, to: 42, start: [0, 1], end: [2, 3] }]);
  });

  it('handles keys between frames, as the lakes film has them', () => {
    const spans = visibleSpans(opacity([3.45, 0], [3.6, 1], [8.3, 1], [8.45, 0]), 24, 240);
    expect(spans).toEqual([{ from: 83, to: 203, start: [0, 1], end: [2, 3] }]);
  });

  it('gives several spans', () => {
    const spans = visibleSpans(opacity([0, 0], [0.5, 1], [1, 0], [2, 0], [2.5, 1], [3, 0]), 12, 48);
    expect(spans.map((s) => [s.from, s.to])).toEqual([[1, 12], [25, 36]]);
    expect(spans[1].start).toEqual([3, 4]);
  });

  it('has no fade at an end that reaches the edge of the scene', () => {
    expect(visibleSpans(opacity([0, 1], [4, 1]), 12, 48)).toEqual([{ from: 0, to: 48 }]);
  });

  it('is nothing for a layer that never shows', () => {
    expect(visibleSpans(opacity([0, 0], [4, 0]), 12, 48)).toEqual([]);
  });

  it('holds on stepFps as the layer does', () => {
    const spans = visibleSpans({ ...opacity([1, 0], [1.25, 1]), stepFps: 4 }, 12, 48);
    expect(spans[0].from).toBe(15);
  });
});
