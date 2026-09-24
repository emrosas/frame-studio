import { choice, num } from '../rigs/parts/params';
import { toSamples } from './parts';
import { frameSample, paramTime } from './timing';
import type { AudioGenerator } from './types';

/** A short tone at the cue start, optionally repeating. Each blip starts exactly on a frame. */
export const blip: AudioGenerator = {
  id: 'blip',
  description: 'A short beep, for UI moments and hits. Set every to repeat it.',
  params: {
    pitch: num(880, 50, 8000, 'Pitch in Hz.'),
    wave: choice('sine', ['sine', 'triangle', 'square', 'sawtooth'], 'Tone colour.'),
    length: num(0.08, 0.005, 2, 'How long each blip rings, in seconds.'),
    every: num(0, 0, 60, 'Seconds between blips. 0 plays one blip.'),
    gain: num(0.3, 0, 1, 'Loudness.'),
  },
  schedule(ctx, out, times, p) {
    const osc = new OscillatorNode(ctx, { type: p.string('wave') as OscillatorType, frequency: p.number('pitch') });
    const amp = new GainNode(ctx, { gain: 0 });
    osc.connect(amp).connect(out);
    osc.start(times.start);
    osc.stop(times.end);

    const onsets: number[] = [];
    // Under one frame apart, blips would share frames, so the gap is at least a frame.
    const every = p.number('every') > 0 ? Math.max(p.number('every'), 1 / times.fps) : 0;
    // At most one blip a frame, so the cue's frames bound the count.
    for (let k = 0; ; k++) {
      const n = every > 0 ? frameSample(times.start + k * every, times.fps) : times.startSample;
      if (n >= times.endSample) break;
      if (onsets.length === 0 || n > onsets[onsets.length - 1]) onsets.push(n);
      if (every <= 0) break;
    }

    const level = p.number('gain');
    const ring = toSamples(p.number('length'));
    const rise = Math.min(48, ring); // 1 ms, so the onset doesn't click
    onsets.forEach((n, i) => {
      const stop = Math.min(n + ring, onsets[i + 1] ?? times.endSample, times.endSample);
      const peak = Math.min(n + rise, stop);
      amp.gain.setValueAtTime(0, paramTime(n));
      amp.gain.linearRampToValueAtTime(level, paramTime(peak));
      amp.gain.linearRampToValueAtTime(0, paramTime(stop));
    });
  },
};
