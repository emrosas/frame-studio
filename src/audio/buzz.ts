import { num } from '../rigs/parts/params';
import { envelopeGain, noiseBuffer, wanderCurve } from './parts';
import type { AudioGenerator } from './types';

/** A fly's buzz: a wandering saw tone plus band-passed noise, fluttering at the wingbeat. */
export const buzz: AudioGenerator = {
  id: 'buzz',
  description: 'An insect buzz whose pitch wanders. The seed shapes the wander.',
  params: {
    pitch: num(220, 50, 1000, 'Base pitch of the buzz in Hz.'),
    wander: num(0.5, 0, 1, 'How far the pitch drifts, up to half an octave either way.'),
    flutter: num(28, 0, 60, 'Wingbeat rate in Hz: how fast the loudness pulses.'),
    gain: num(0.25, 0, 1, 'Loudness.'),
    fade: num(0.05, 0, 2, 'Fade in and out, in seconds.'),
  },
  schedule(ctx, out, times, p, rng) {
    const pitch = p.number('pitch');
    const tone = new OscillatorNode(ctx, { type: 'sawtooth', frequency: pitch });
    // Detune in cents follows a seeded random walk, eight points a second.
    const curve = wanderCurve(times, 8, rng.fork('wander'));
    const cents = 600 * p.number('wander');
    for (let i = 0; i < curve.length; i++) curve[i] *= cents;
    tone.detune.setValueCurveAtTime(curve, times.start, times.end - times.start);

    const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx, rng.fork('noise')), loop: true });
    const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: pitch * 2, Q: 2 });
    const noiseLevel = new GainNode(ctx, { gain: 0.6 });
    noise.connect(band).connect(noiseLevel);

    // Tone and noise meet here, two connections. The flutter LFO adds to its gain.
    const body = new GainNode(ctx, { gain: 0.75 });
    tone.connect(body);
    noiseLevel.connect(body);
    const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: p.number('flutter') });
    const depth = new GainNode(ctx, { gain: 0.25 });
    lfo.connect(depth).connect(body.gain);

    const fade = p.number('fade');
    const amp = envelopeGain(ctx, times, p.number('gain'), fade, fade);
    body.connect(amp).connect(out);

    for (const source of [tone, noise, lfo]) {
      source.start(times.start);
      source.stop(times.end);
    }
  },
};
