import { choice, num, str } from '../rigs/parts/params';
import { toSamples } from './parts';
import { frameSample, paramTime } from './timing';
import type { AudioGenerator } from './types';

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A note name like "C4", "F#3" or "Bb2" to Hz, or null. */
export function noteHz(name: string): number | null {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return null;
  const semitone = SEMITONES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((semitone - 69) / 12);
}

/** One voice of chiptune: a written line of notes on the frame grid. */
export const chip: AudioGenerator = {
  id: 'chip',
  description:
    'One chiptune voice playing a written line. notes is a list split by spaces: a note like C4, F#3 or Bb2; "." holds the last note; "-" rests. ' +
    'It repeats until the cue ends, and every note starts on a frame. Stack cues for melody, bass and arpeggio.',
  params: {
    notes: str('C4 E4 G4 C5', 'Notes split by spaces. "." holds and "-" rests.'),
    step: num(0.2, 0.02, 4, 'Seconds a step.'),
    wave: choice('square', ['square', 'triangle', 'sawtooth', 'sine'], 'Tone colour.'),
    decay: num(0.9, 0.05, 1, 'Share of a step a note rings for.'),
    gain: num(0.12, 0, 1, 'Loudness.'),
  },
  schedule(ctx, out, times, p) {
    const steps = p.string('notes').split(/\s+/).filter(Boolean);
    if (steps.length === 0) return;
    const osc = new OscillatorNode(ctx, { type: p.string('wave') as OscillatorType, frequency: 440 });
    const amp = new GainNode(ctx, { gain: 0 });
    osc.connect(amp).connect(out);
    osc.start(times.start);
    osc.stop(times.end);
    const level = p.number('gain');
    const step = Math.max(p.number('step'), 1 / times.fps);
    const rise = toSamples(0.002);
    for (let k = 0; ; k++) {
      const n = frameSample(times.start + k * step, times.fps);
      if (n >= times.endSample) break;
      const hz = noteHz(steps[k % steps.length]);
      if (hz === null) continue;
      // A note rings through the "." steps after it, and always ends inside the steps it owns.
      let held = 1;
      while (held < steps.length && steps[(k + held) % steps.length] === '.') held++;
      const next = Math.min(frameSample(times.start + (k + held) * step, times.fps), times.endSample);
      const stop = Math.min(n + toSamples(step * (held - 1 + p.number('decay'))), next);
      const up = Math.min(n + rise, stop);
      osc.frequency.setValueAtTime(hz, paramTime(n));
      amp.gain.setValueAtTime(0, paramTime(n));
      amp.gain.linearRampToValueAtTime(level, paramTime(up));
      amp.gain.setValueAtTime(level, paramTime(Math.max(up, stop - rise)));
      amp.gain.linearRampToValueAtTime(0, paramTime(stop));
    }
  },
};
