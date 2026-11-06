import { describe, expect, it } from 'vitest';
import {
  buildReport,
  checkBlack,
  checkDuration,
  checkFlashing,
  checkFormat,
  checkFreeze,
  checkLoopSeam,
  checkLoudness,
  checkMarkers,
  checkOpening,
  checkSize,
  checkSparse,
  checkTruePeak,
  detectOnsets,
  FrameMeter,
  findDropouts,
  integratedLoudness,
  truePeak,
  type CheckResult,
} from './check';

const WIDTH = 16;
const HEIGHT = 9;
const RATE = 48000;

function solid(r: number, g = r, b = r): Uint8ClampedArray {
  const out = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < out.length; i += 4) out.set([r, g, b, 255], i);
  return out;
}

/** A frame with one mid-grey block on a darker ground, the block's left edge at `x`: a picture that isn't blank. */
function picture(x: number): Uint8ClampedArray {
  const out = solid(40);
  for (let row = 2; row < 7; row++) for (let col = x; col < x + 6; col++) out.set([200, 200, 200, 255], (row * WIDTH + col) * 4);
  return out;
}

function meter(frames: readonly Uint8ClampedArray[]): FrameMeter {
  const m = new FrameMeter();
  for (const f of frames) m.add(f);
  return m;
}

const stats = (frames: readonly Uint8ClampedArray[]) => meter(frames).stats;
const moving = (count: number) => Array.from({ length: count }, (_, i) => picture(i % 10));

function sine(frequency: number, db: number, secs: number, phase = 0): Float32Array {
  const amp = 10 ** (db / 20);
  return Float32Array.from({ length: Math.round(secs * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * frequency * i) / RATE + phase));
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const silence = (secs: number) => new Float32Array(Math.round(secs * RATE));

describe('checkSize', () => {
  it('scales the long side down and never up', () => {
    expect(checkSize(1920, 1080)).toEqual([320, 180]);
    expect(checkSize(1080, 1920)).toEqual([180, 320]);
    expect(checkSize(160, 90)).toEqual([160, 90]);
  });
});

describe('format and duration', () => {
  it('fails an fps that does not divide 48000, only with audio', () => {
    expect(checkFormat({ fps: 23, width: 1920, height: 1080, audio: true }).status).toBe('fail');
    expect(checkFormat({ fps: 23, width: 1920, height: 1080, audio: false }).status).toBe('pass');
  });

  it('fails odd dimensions', () => {
    expect(checkFormat({ fps: 24, width: 1921, height: 1080, audio: false }).status).toBe('fail');
  });

  it('notes a vertical short', () => {
    const r = checkFormat({ fps: 30, width: 1080, height: 1920, audio: true });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('short');
  });

  it('reports the length, and warns when it falls between frames', () => {
    expect(checkDuration(3, 24)).toMatchObject({ status: 'pass', value: 3 });
    expect(checkDuration(1.01, 24).status).toBe('warn');
  });
});

describe('black frames', () => {
  it('finds runs with their frames, offset by the range', () => {
    const frames = [picture(0), solid(0), solid(10), picture(0), solid(0)];
    expect(checkBlack(stats(frames), 10, 100)).toMatchObject({ status: 'warn', frames: [[101, 103], [104, 105]], value: 0.3 });
  });

  it('passes a dark picture that has something in it', () => {
    expect(checkBlack(stats([picture(0)]), 10, 0).status).toBe('pass');
  });

  it('fails when every frame is black', () => {
    expect(checkBlack(stats([solid(0), solid(0)]), 10, 0).status).toBe('fail');
  });
});

describe('freeze', () => {
  it('passes held frames from stepFps and a run of exactly 1.5 s', () => {
    const onTwos = Array.from({ length: 48 }, (_, i) => picture(Math.floor(i / 2) % 10));
    expect(checkFreeze(stats(onTwos), 24, 0).status).toBe('pass');
    const hold = Array.from({ length: 36 }, () => picture(1));
    expect(checkFreeze(stats([...hold, picture(2)]), 24, 0).status).toBe('pass');
  });

  it('warns on a run over 1.5 s and gives its frames', () => {
    const frames = [picture(0), ...Array.from({ length: 37 }, () => picture(1)), picture(2)];
    expect(checkFreeze(stats(frames), 24, 10)).toMatchObject({ status: 'warn', frames: [[11, 48]], value: 1.54 });
  });
});

describe('opening', () => {
  it('passes a picture that moves in the first second', () => {
    expect(checkOpening(stats(moving(24)), 24, 0).status).toBe('pass');
  });

  it('warns when the first second is static', () => {
    const frames = [...Array.from({ length: 24 }, () => picture(1)), picture(4)];
    expect(checkOpening(stats(frames), 24, 0)).toMatchObject({ status: 'warn', frames: [[0, 24]] });
  });

  it('warns on a fade from blank, however quick', () => {
    const frames = [solid(0), solid(0), picture(0), picture(1), picture(2)];
    expect(checkOpening(stats(frames), 24, 0)).toMatchObject({ status: 'warn', frames: [[0, 2]] });
  });

  it('does not call a small thing on a plain ground blank', () => {
    const dot = (x: number) => {
      const out = solid(230);
      out.set([20, 20, 20, 255], (40 + x) * 4);
      return out;
    };
    expect(checkOpening(stats([dot(0), dot(1), dot(2), dot(3)]), 24, 0).status).toBe('pass');
  });

  it('skips a range that starts later', () => {
    expect(checkOpening(stats([solid(0), solid(0)]), 24, 12).status).toBe('pass');
  });
});

describe('loop seam', () => {
  const away = meter(moving(11)); // ends on the block at 0 again, so it closes
  const open = meter([...moving(6), solid(255)]);

  it('always reports a value, and warns only when asked', () => {
    expect(checkLoopSeam(open.stats, open.seam, 0, false).status).toBe('pass');
    expect(checkLoopSeam(open.stats, open.seam, 0, false).value).toBeGreaterThan(0.1);
    expect(checkLoopSeam(open.stats, open.seam, 0, true)).toMatchObject({ status: 'warn', frames: [[6, 7]] });
  });

  it('passes a seam no bigger than an ordinary step', () => {
    expect(away.seam).toBe(0);
    expect(checkLoopSeam(away.stats, away.seam, 0, true).status).toBe('pass');
  });
});

describe('flashing', () => {
  const alternate = (count: number, every: number) => Array.from({ length: count }, (_, i) => solid(Math.floor(i / every) % 2 === 0 ? 0 : 255));

  it('fails more than 3 flashes a second, with the frames', () => {
    const calm = moving(24);
    const r: CheckResult = checkFlashing(stats([...calm, ...alternate(24, 1), ...calm]), 24, 100);
    expect(r.status).toBe('fail');
    expect(r.frames).toHaveLength(1);
    const [[from, to]] = r.frames!;
    expect(from).toBeGreaterThanOrEqual(123);
    expect(from).toBeLessThanOrEqual(125);
    expect(to).toBeGreaterThanOrEqual(147);
    expect(to).toBeLessThanOrEqual(150);
  });

  it('passes 3 flashes a second, and fails 4', () => {
    // A flash is a swing up and back: 3 a second at 24 fps is a change every 4 frames.
    expect(checkFlashing(stats(alternate(48, 4)), 24, 0)).toMatchObject({ status: 'pass', value: 3 });
    expect(checkFlashing(stats(alternate(48, 3)), 24, 0).status).toBe('fail');
  });

  it('ignores small swings and slow fades', () => {
    const small = Array.from({ length: 48 }, (_, i) => solid(i % 2 === 0 ? 120 : 130));
    expect(checkFlashing(stats(small), 24, 0)).toMatchObject({ status: 'pass', value: 0 });
    const fade = Array.from({ length: 48 }, (_, i) => solid(Math.round((i / 47) * 255)));
    expect(checkFlashing(stats(fade), 24, 0).status).toBe('pass');
  });

  it('ignores swings between very bright frames', () => {
    const bright = Array.from({ length: 48 }, (_, i) => solid(i % 2 === 0 ? 245 : 255));
    expect(checkFlashing(stats(bright), 24, 0).status).toBe('pass');
  });
});

describe('sparse', () => {
  it('warns on over 3 s of one colour, whichever colour', () => {
    const frames = [...moving(2), ...Array.from({ length: 31 }, () => solid(200, 120, 60)), ...moving(2)];
    expect(checkSparse(stats(frames), 10, 0)).toMatchObject({ status: 'warn', frames: [[2, 33]], value: 3.1 });
  });

  it('passes exactly 3 s, and a busy picture', () => {
    expect(checkSparse(stats(Array.from({ length: 30 }, () => solid(200))), 10, 0).status).toBe('pass');
    expect(checkSparse(stats(moving(40)), 10, 0).status).toBe('pass');
  });

  it('counts faint grain as one colour', () => {
    const grain = solid(200);
    for (let i = 0; i < grain.length; i += 4) grain.set([200 + (i % 16), 200 - (i % 12), 200, 255], i);
    expect(stats([grain])[0].blank).toBe(true);
  });
});

describe('integrated loudness, against EBU Tech 3341', () => {
  /** Tech 3341 allows +/- 0.1 LU. */
  const within = (lufs: number | null, expected: number) => expect(Math.abs(lufs! - expected)).toBeLessThanOrEqual(0.1);

  it('reads a stereo 1 kHz sine at -23 dBFS as -23 LUFS', () => {
    const tone = sine(1000, -23, 20);
    within(integratedLoudness([tone, tone]), -23);
  });

  it('reads the same tone at -33 as -33', () => {
    const tone = sine(1000, -33, 20);
    within(integratedLoudness([tone, tone]), -33);
  });

  it('reads -3 LUFS for a full-scale 997 Hz sine in one channel, as BS.1770 states', () => {
    within(integratedLoudness([sine(997, 0, 10)]), -3.01);
  });

  it('gates out silence (absolute gate, case 3 shape)', () => {
    const tone = sine(1000, -23, 20);
    const part = concat(silence(10), tone, silence(10));
    within(integratedLoudness([part, part]), -23);
  });

  it('gates out quiet passages by the relative gate (case 4 shape)', () => {
    const part = concat(sine(1000, -36, 10), sine(1000, -23, 60), sine(1000, -36, 10));
    within(integratedLoudness([part, part]), -23);
  });

  it('averages passages within the gate (case 5)', () => {
    const part = concat(sine(1000, -26, 20), sine(1000, -20, 20.1), sine(1000, -26, 20));
    within(integratedLoudness([part, part]), -23);
  });

  it('weights out sub-bass, and has nothing to read in silence or a sliver of sound', () => {
    expect(integratedLoudness([sine(20, -23, 10)])!).toBeLessThan(-35);
    expect(integratedLoudness([silence(5)])).toBeNull();
    expect(integratedLoudness([sine(1000, -10, 0.2)])).toBeNull();
  });

  it('warns outside -18 to -12 LUFS', () => {
    expect(checkLoudness(-14).status).toBe('pass');
    expect(checkLoudness(-18).status).toBe('pass');
    expect(checkLoudness(-12).status).toBe('pass');
    expect(checkLoudness(-18.1).status).toBe('warn');
    expect(checkLoudness(-11.9).status).toBe('warn');
    expect(checkLoudness(null).status).toBe('warn');
  });
});

describe('true peak', () => {
  it('finds the peak between samples, which a sample peak misses', () => {
    // At a quarter of the rate and 45 degrees, every sample lands at 0.707, 3 dB under the real peak.
    const tone = sine(12000, 0, 0.5, Math.PI / 4);
    const samplePeak = Math.max(...tone.subarray(1000, 2000).map(Math.abs));
    expect(20 * Math.log10(samplePeak)).toBeCloseTo(-3.01, 1);
    expect(truePeak([tone])).toBeCloseTo(0, 0);
    expect(Math.abs(truePeak([tone])!)).toBeLessThan(0.3);
  });

  it('reads an ordinary sine at its level, on the loudest channel', () => {
    expect(truePeak([sine(997, -12, 0.5), sine(997, -6, 0.5)])).toBeCloseTo(-6, 0);
  });

  it('warns above -1 dBTP', () => {
    expect(checkTruePeak(-1).status).toBe('pass');
    expect(checkTruePeak(-0.9).status).toBe('warn');
    expect(checkTruePeak(null).status).toBe('pass');
    expect(truePeak([silence(0.1)])).toBeNull();
  });
});

describe('dropouts', () => {
  it('finds a silence over a second between sounds', () => {
    const part = concat(sine(440, -20, 1), silence(1.5), sine(440, -20, 1));
    const gaps = findDropouts([part, part]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0][0] / RATE).toBeCloseTo(1, 1);
    expect(gaps[0][1] / RATE).toBeCloseTo(2.5, 1);
  });

  it('leaves out silence before the first sound and after the last, and short pauses', () => {
    expect(findDropouts([concat(silence(2), sine(440, -20, 1), silence(0.8), sine(440, -20, 1), silence(3))])).toEqual([]);
  });
});

describe('onsets and markers', () => {
  const click = (at: number, secs: number) => {
    const out = silence(secs);
    const start = Math.round(at * RATE);
    for (let i = 0; i < 960; i++) out[start + i] = 0.5 * Math.exp(-i / 200) * Math.sin(i / 3);
    return out;
  };

  it('finds clicks in silence, once each', () => {
    const on = detectOnsets([click(1, 3)]);
    expect(on).toHaveLength(1);
    expect(on[0]).toBeGreaterThanOrEqual(1);
    expect(on[0]).toBeLessThan(1.01);
  });

  it('finds a hit over a steady bed, and stays quiet through the bed alone', () => {
    const bed = sine(220, -30, 3);
    expect(detectOnsets([bed]).filter((t) => t > 0.2)).toEqual([]);
    const hit = click(1.5, 3);
    const both = Float32Array.from(bed, (v, i) => v + hit[i]);
    const on = detectOnsets([both]).filter((t) => t > 0.2);
    expect(on).toHaveLength(1);
    expect(on[0]).toBeCloseTo(1.5, 1);
  });

  it('keeps a sound that starts on a frame on that frame', () => {
    const [t] = detectOnsets([click(1, 3)]);
    expect(Math.floor(t * 30)).toBe(30);
  });

  it('passes a marker with a sound within 2 frames, and fails one without', () => {
    const on = detectOnsets([click(1, 3)]); // frame 24 at 24 fps
    expect(checkMarkers([{ t: 22 / 24, label: 'hit!' }], on, 24, 0, 72).status).toBe('pass');
    expect(checkMarkers([{ t: 26 / 24, label: 'hit!' }], on, 24, 0, 72).status).toBe('pass');
    const late = checkMarkers([{ t: 27 / 24, label: 'hit!' }], on, 24, 0, 72);
    expect(late).toMatchObject({ status: 'fail', frames: [[27, 28]], value: 1 });
    expect(late.message).toContain('frame 24');
  });

  it('checks only markers with a trailing !, inside the range', () => {
    expect(checkMarkers([{ t: 1, label: 'beat' }], [], 24, 0, 72).status).toBe('pass');
    expect(checkMarkers([{ t: 1, label: 'hit!' }], [], 24, 48, 72).status).toBe('pass');
    expect(checkMarkers([{ t: 1, label: 'hit!' }], [], 24, 0, 72).status).toBe('fail');
  });
});

describe('buildReport', () => {
  const base = { scene: 's', fps: 24, duration: 1, width: 1920, height: 1080, from: 0, to: 24 };

  it('is plain JSON, with every check in order', () => {
    const report = buildReport({ ...base, frames: meter(moving(24)), audio: null });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(['format', 'duration', 'black', 'freeze', 'opening', 'loop-seam', 'flashing', 'sparse', 'loudness', 'true-peak', 'dropouts', 'markers']);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('is not ok when a check fails, and stays ok on warnings', () => {
    const flashing = Array.from({ length: 24 }, (_, i) => solid(i % 2 === 0 ? 0 : 255));
    expect(buildReport({ ...base, frames: meter(flashing), audio: null }).ok).toBe(false);
    const still = Array.from({ length: 24 }, () => picture(0));
    const warned = buildReport({ ...base, frames: meter(still), audio: null });
    expect(warned.ok).toBe(true);
    expect(warned.checks.find((c) => c.id === 'opening')?.status).toBe('warn');
  });

  it('measures only the range of the sound', () => {
    const quiet = sine(1000, -40, 2);
    const loud = sine(1000, -14, 2);
    const part = concat(quiet, loud);
    const report = buildReport({ ...base, duration: 4, from: 48, to: 96, frames: meter(moving(48)), audio: [part, part] });
    expect(report.checks.find((c) => c.id === 'loudness')).toMatchObject({ status: 'pass', value: -14 });
  });

  it('fails a marker when the scene is silent', () => {
    const report = buildReport({ ...base, frames: meter(moving(24)), audio: null, markers: [{ t: 0.5, label: 'hit!' }] });
    expect(report.ok).toBe(false);
  });

  it('reports sound that could not render, instead of losing the frame checks', () => {
    const report = buildReport({ ...base, frames: meter(moving(24)), audio: "media/a.wav isn't in media/." });
    expect(report.checks.find((c) => c.id === 'loudness')).toMatchObject({ status: 'fail', message: "media/a.wav isn't in media/." });
    expect(report.checks.some((c) => c.id === 'black')).toBe(true);
  });
});
