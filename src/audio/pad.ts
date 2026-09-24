import { choice, num } from '../rigs/parts/params';
import { mix } from './mix';
import { envelopeGain } from './parts';
import type { AudioGenerator } from './types';

const CHORDS: Record<string, readonly number[]> = {
  fifth: [0, 7, 12],
  major: [0, 4, 7],
  minor: [0, 3, 7],
  unison: [0],
};

/** A soft ambient chord: detuned saw pairs through a lowpass, with slow fades. */
export const pad: AudioGenerator = {
  id: 'pad',
  description: 'An ambient chord that fades in and out. Good under a whole scene.',
  params: {
    note: num(220, 30, 2000, 'Root pitch in Hz.'),
    chord: choice('fifth', Object.keys(CHORDS), 'Intervals stacked on the root.'),
    gain: num(0.2, 0, 1, 'Loudness at full volume.'),
    attack: num(1, 0, 20, 'Fade-in in seconds.'),
    release: num(1.5, 0, 20, 'Fade-out in seconds, ending at the cue end.'),
    brightness: num(0.4, 0, 1, 'How open the filter is. 0 is muffled, 1 is buzzy.'),
  },
  schedule(ctx, out, times, p, rng) {
    const root = p.number('note');
    const oscillators: OscillatorNode[] = [];
    for (const semitones of CHORDS[p.string('chord')]) {
      const frequency = root * 2 ** (semitones / 12);
      for (const side of [-1, 1]) {
        const detune = side * rng.range(4, 9);
        const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency, detune });
        osc.start(times.start);
        osc.stop(times.end);
        oscillators.push(osc);
      }
    }
    const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 200 + p.number('brightness') * 4000, Q: 0.7 });
    mix(ctx, oscillators, filter);
    const amp = envelopeGain(ctx, times, p.number('gain') / oscillators.length, p.number('attack'), p.number('release'));
    filter.connect(amp);
    amp.connect(out);
  },
};
