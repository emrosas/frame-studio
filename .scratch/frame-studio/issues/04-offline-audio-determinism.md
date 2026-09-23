# Is OfflineAudioContext output identical run to run?

Type: research
Status: resolved
Blocked by: none

## Question

M7 requires the same scene to render identical audio twice, and exported audio to line up with scene timings within one frame.

Is `OfflineAudioContext` output bit-identical across runs in Chromium for oscillators, seeded noise buffers, biquad filters, and gain envelopes? What breaks it, for example resampling in `AudioBufferSourceNode`, denormals, render quantum boundaries, or the chosen sample rate? How should a generator's start time map to a sample offset so it lands on a frame boundary?

## Answer

On one machine with the pinned Chromium, `OfflineAudioContext` output is bit-identical run to run for every node tested, except when three or more connections feed one input, `AudioParam` or `destination`. Chromium sums those in hash-set order, which changes per run. M7 should keep fan-in at two (a binary `GainNode` mix helper, or per-clip contexts mixed in JS) and assert that with a `connect()` counter in tests. Output is not identical across CPUs, macOS versions or Chromium versions (differences below -110 dB), so hash checks stay on one machine and cross-machine checks use a tolerance. Export at 48000 Hz with `48000 % fps === 0`, start sources at `n / 48000` with `n = frame * 48000 / fps`, and schedule frame-exact `AudioParam` events at `(n - 0.5) / 48000`, because a plain `ceil` makes about 6% of them land one sample late at 25, 30 and 60 fps.

Findings: [research/offline-audio-determinism.md](../research/offline-audio-determinism.md)
