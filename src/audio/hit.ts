import { num } from '../rigs/parts/params';
import { noiseBuffer, toSamples } from './parts';
import { paramTime } from './timing';
import type { AudioGenerator } from './types';
import { mix } from './mix';

/** A landing: a falling tone under a burst of noise, starting on the cue's first frame. */
export const hit: AudioGenerator = {
  id: 'hit',
  description: 'A thud, tick or impact at the start of the cue: a falling tone under a short burst of noise. Low pitch for a thump, high for a click.',
  params: {
    pitch: num(120, 20, 4000, 'Starting pitch in Hz.'),
    drop: num(0.5, 0, 1, 'How far the pitch falls, as a share.'),
    length: num(0.18, 0.01, 2, 'Seconds it rings.'),
    noise: num(0.4, 0, 1, 'Share of noise in the sound.'),
    gain: num(0.5, 0, 1, 'Loudness.'),
  },
  schedule(ctx, out, times, p, rng) {
    const stop = Math.min(times.startSample + toSamples(p.number('length')), times.endSample);
    const pitch = p.number('pitch');
    const osc = new OscillatorNode(ctx, { type: 'triangle', frequency: pitch });
    osc.frequency.setValueAtTime(pitch, paramTime(times.startSample));
    osc.frequency.linearRampToValueAtTime(pitch * (1 - p.number('drop')), paramTime(stop));
    const noise = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx, rng), loop: true });
    const noiseAmp = new GainNode(ctx, { gain: p.number('noise') });
    const toneAmp = new GainNode(ctx, { gain: 1 - p.number('noise') });
    osc.connect(toneAmp);
    noise.connect(noiseAmp);
    const amp = new GainNode(ctx, { gain: 0 });
    mix(ctx, [toneAmp, noiseAmp], amp);
    amp.connect(out);
    amp.gain.setValueAtTime(p.number('gain'), paramTime(times.startSample));
    amp.gain.linearRampToValueAtTime(0, paramTime(stop));
    osc.start(times.start);
    osc.stop(times.end);
    noise.start(times.start);
    noise.stop(times.end);
  },
};
