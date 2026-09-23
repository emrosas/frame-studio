# Is OfflineAudioContext output identical run to run?

Research for ticket [04](../issues/04-offline-audio-determinism.md). Consumed by M7 ([12](../issues/12-m7-procedural-audio.md)). Checked 2026-09-22.

## Question

M7 requires the same scene to render identical audio twice, and exported audio to line up with scene timings within one frame. Is `OfflineAudioContext` output bit-identical across runs in Chromium for oscillators, seeded noise buffers, biquad filters, and gain envelopes? What breaks it: resampling in `AudioBufferSourceNode`, denormals, render quantum boundaries, the sample rate? How should a generator's start time map to a sample offset so it lands on a frame boundary?

## Short answer

On one machine with one Chromium build, the output is bit-identical run to run. That held for oscillators, seeded noise buffers, biquads, gain envelopes, and every other node I tried, with one exception. When three or more connections feed a single input (a node input, an `AudioParam`, or `destination`), Chromium sums them in an order that changes from render to render, and the float result changes with it. Two connections per input is safe. So is mixing in JS.

Across machines it is not identical. Chromium has separate x86 (SSE/AVX), ARM (NEON), and macOS (Accelerate) code paths that round differently. The FFT library that builds oscillator wave tables has changed. Chromium's own cross-device audio consistency test was disabled on macOS and Android and then deleted. The output also changes between Chromium versions. The differences sit around -110 dB and below, so nobody will hear them, but they break hash comparisons.

For timing, use 48000 Hz. It divides evenly by 12, 24, 25, 30 and 60 fps, so every frame boundary is a whole sample. Start sources at `n / 48000`, where `n = frame * (48000 / fps)`. Chromium snaps those start times onto the exact sample. `AudioParam` events use a plain `ceil`, so at 25, 30 and 60 fps about 6% of frame-boundary events land one sample late. Scheduling them at `(n - 0.5) / 48000` fixes that. One sample is 21 microseconds, far inside the one-frame budget, so this only matters for tests that assert exact sample positions.

## Findings

### How Chromium renders offline

- The spec renders in blocks called render quanta, 128 frames by default. `renderSizeHint` can change the size ([Web Audio API, section 2.6 Rendering an audio graph](https://webaudio.github.io/web-audio-api/#rendering-loop)). In Chromium the configurable quantum is still a runtime feature at `status: "experimental"`, so stable builds use 128 (`runtime_enabled_features.json5`, visible in the diff of commit [0d3c3f47](https://chromium.googlesource.com/chromium/src/+/0d3c3f478f9c4d1c5e2ce9f9c6fae6c0f19a41a0)).
- `OfflineAudioDestinationHandler::DoOfflineRendering` loops over render quanta on a single render thread until the requested length is done. Each quantum runs inside a `DenormalDisabler` scope that "will take care of all AudioNodes" ([offline_audio_destination_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/offline_audio_destination_handler.cc), `RenderIfNotSuspended`).
- Before each quantum, `OfflineAudioContext::HandlePreRenderTasks` takes the graph lock and applies any pending graph changes from the main thread ([offline_audio_context.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/offline_audio_context.cc)). A `connect()` or `start()` made after `startRendering()` therefore lands on whichever quantum grabs the lock first. That is a race. The spec offers `suspend(t)` for changing the graph at a known time, and it quantizes that time to the render quantum ([section 1.3.3 OfflineAudioContext methods](https://webaudio.github.io/web-audio-api/#OfflineAudioContext-methods)).
- Most of the math Web Audio uses comes from a bundled copy of V8's fdlibm fork, not the OS math library. The 2021 commit says it did this to "achieve consistent results on different devices" as a fingerprinting mitigation ([f45416a0](https://chromium.googlesource.com/chromium/src/+/f45416a0f76ad2609f2dca70caa9d86f750224df), [aa95a901](https://chromium.googlesource.com/chromium/src/+/aa95a9015fa8f2e19dff63836c9225bcf1395ce9)). Current `biquad.cc`, `audio_utilities.cc`, `reverb.cc` and the automation code call `fdlibm::sin/cos/exp/pow/log`. A few spots still use the platform library. The oscillator's detune path calls `std::exp2` ([oscillator_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/oscillator_handler.cc)), and `PeriodicWaveImpl::NumberOfPartialsForRange` calls `pow` ([periodic_wave.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/periodic_wave.cc)). A later commit moved some calls back to `math.h` for speed ([71258f52](https://chromium.googlesource.com/chromium/src/+/71258f5226fb4201d2e39cb64d155a8baee56a3f)).
- Chromium compiles with `-ffp-contract=off` ([build/config/compiler/BUILD.gn](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/build/config/compiler/BUILD.gn)). The compiler therefore never fuses a C++ `a * b + c` into an FMA, so scalar C++ code rounds the same on x86-64 and arm64. Hand-written SIMD intrinsics are a separate matter, covered below.

### Run to run on one machine

Every node type I tested produced the same bytes across renders in one page, across fresh browser launches, and with many contexts rendering at once (see [Experiments](#experiments)). I found nothing in the offline render loop that reads the clock or a random source, and no background threads doing DSP. The convolver's stages run synchronously inside `ReverbConvolver::Process` ([reverb_convolver.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/reverb_convolver.cc)). An HRTF `PannerNode` in an offline context waits for its database to load before it renders (`WaitForHRTFDatabaseLoaderThreadCompletion` in [panner_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/panner_handler.cc)). The same function has one timing hazard. `PannerHandler::Process` only tries the listener lock, and if another thread holds it the panner outputs a quantum of silence ("Too bad - The tryLock() failed"). Nothing takes that lock if the graph is finished before rendering starts, and my HRTF case matched across every run. `StereoPannerNode` has no such lock.

### Fan-in of three or more breaks it

The spec says an input mixes its connections by "a straight-forward summing together" and gives no order ([section 4 Channel up-mixing and down-mixing](https://webaudio.github.io/web-audio-api/#channel-up-mixing-and-down-mixing)). Chromium keeps an input's connections in `HashSet<AudioNodeOutput*> outputs_` and copies them into the rendering list by iterating that set (`AudioSummingJunction::UpdateRenderingState` in [audio_summing_junction.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/audio_summing_junction.cc)). `AudioNodeInput::SumAllConnections` then adds them in that order ([audio_node_input.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/audio_node_input.cc)). A pointer-keyed hash set iterates in an order that depends on heap addresses, and those change every run. `AudioParamHandler` sums its inputs through the same junction class.

Float addition is commutative but not associative. With two connections the result is `0 + a + b`, which equals `0 + b + a` exactly. With three, `(a + b) + c` and `(a + c) + b` can differ in the last bit. In 12 renders I saw 3 distinct outputs for fan-in 3, which matches the 3 possible orderings, and 7 to 10 distinct outputs for fan-in 4. That held for a `GainNode`, for `destination`, and for an `AudioParam`, on both Chromium versions. Fan-in 2 gave 1 distinct output every time. Replay.io's Chromium fork patched this exact set to get deterministic iteration for record and replay ([replayio/chromium#1491](https://github.com/replayio/chromium/pull/1491), citing their "RUN-597"), which backs up the source reading.

Minimal repro, run in any Chromium page:

```js
async function render() {
  const c = new OfflineAudioContext({ numberOfChannels: 1, length: 96000, sampleRate: 48000 });
  for (let i = 0; i < 3; i++) {
    const o = new OscillatorNode(c, { type: 'sawtooth', frequency: 100 + 37.3 * i });
    o.connect(c.destination); // three connections into one input
    o.start(0);
  }
  return new Uint32Array((await c.startRendering()).getChannelData(0).buffer);
}
// Render a handful of times and compare the words. Different orderings show up within a few runs.
```

This is the one real hazard for M7's "identical twice" test. Most generator code connects several things straight to `destination`, and a chord is three oscillators into one gain.

### Across machines, CPUs and Chromium versions

Nothing guarantees cross-machine equality, and the code has several places that break it:

- **macOS uses Apple's Accelerate library.** `vector_math.cc` routes `Vadd`, `Vmul`, `Vsma`, `Vsvesq`, `Conv` and the rest to vDSP on Mac, NEON intrinsics on other ARM builds, and SSE/AVX elsewhere ([vector_math.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/vector_math.cc), [mac/vector_math_mac.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/mac/vector_math_mac.h)). On Mac a biquad with fixed coefficients runs through `vDSP_deq22D`. Every other platform uses a C++ loop (`Biquad::Process` and `ProcessFast` in [biquad.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/biquad.cc)). Accelerate ships with the OS and its source is closed. Chromium disabled its Web Audio fingerprint test on Mac because "Different macOS versions are producing different DynamicsCompressor fingerprints" ([0c633ff4](https://chromium.googlesource.com/chromium/src/+/0c633ff43dd31cd69648666d4579bfe96928b25a), tracked as [issue 40167066](https://issues.chromium.org/issues/40167066)).
- **x86 and ARM oscillator kernels differ.** They live in separate files that do not round the same way. The SSE2 k-rate kernel seeds its four lanes from a `double` read index. The NEON kernel first casts the index to `float` (`virtual_read_index_flt`) and adds the increments in single precision ([cpu/x86/oscillator_kernel_sse2.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/cpu/x86/oscillator_kernel_sse2.cc), [cpu/arm/oscillator_kernel_neon.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/cpu/arm/oscillator_kernel_neon.cc)).
- **Automation has an x86-only SSE path.** `ProcessLinearRamp`, `ProcessSetTarget` and `ProcessSetValueCurve` in [audio_param_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/audio_param_handler.cc) have `#if defined(ARCH_CPU_X86_FAMILY)` blocks. On x86 they seed four lanes once per quantum and then add a float increment, `v_value += v_inc`. ARM evaluates the formula per sample instead. So the same gain envelope rounds differently on Intel and Apple Silicon. I could not run x86 here (no Rosetta), so I reimplemented both paths in float32 JS. My scalar version reproduced the real arm64 output of a 3-second `linearRampToValueAtTime` bit for bit (0 mismatches in 144,000 samples). The SSE version differed from it on 100,450 of those samples, by at most 1.8e-7.
- **AVX changes reductions.** On non-Mac x86, `Vsvesq` (sum of squares) splits work between AVX, SSE and scalar code depending on `base::CPU().has_avx()` ([cpu/x86/vector_math_x86.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/cpu/x86/vector_math_x86.h)). A different lane count means a different summation order. `ConvolverNode` normalization uses `Vsvesq` to compute its scale (`CalculateNormalizationScale` in [reverb.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/reverb.cc)).
- **The FFT backend has changed.** `PeriodicWave` builds oscillator wave tables, including the ones for the built-in types, with an inverse FFT (`frame.DoInverseFFT` in [periodic_wave.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/periodic_wave.cc)). The spec itself suggests an inverse FFT for normalization ([section 1.28.5](https://webaudio.github.io/web-audio-api/#waveform-normalization)). Until mid-2026 the FFT was vDSP on Mac and PFFFT elsewhere (`fft_frame.h` before [0d3c3f47](https://chromium.googlesource.com/chromium/src/+/0d3c3f478f9c4d1c5e2ce9f9c6fae6c0f19a41a0)). That commit switched to RustFFT and loosened oscillator test thresholds, for example `osc-440hz.html` SNR from 59.280 to 59.279.
- **Chromium stopped testing cross-device consistency.** Its fingerprint test compared one hard-coded value across devices. The test file says "Changes to Web Audio code that alter the below fingerprints are fine... the issue is if different devices return different fingerprints." In June 2026 the test was disabled on Android because "SIMD/NEON on physical ARM devices vs scalar math on x86 emulators cause minor differences in RustFFT outputs", which "diverge the audio output" of `OscillatorNode` ([1e8d7828](https://chromium.googlesource.com/chromium/src/+/1e8d7828033a0a541209d0d786c2f5f6d1e43c26)). The RustFFT reland "completely removes the fingerprinting test" ([0d3c3f47](https://chromium.googlesource.com/chromium/src/+/0d3c3f478f9c4d1c5e2ce9f9c6fae6c0f19a41a0)). Even with fdlibm, the original commit already saw amd64 Linux differ from aarch64 Android ([f45416a0](https://chromium.googlesource.com/chromium/src/+/f45416a0f76ad2609f2dca70caa9d86f750224df)). The test kept a separate expected value for Arm64, and Windows on Arm64 turned out to match the Android Arm64 value ([ffaa15ba](https://chromium.googlesource.com/chromium/src/+/ffaa15ba728b2bbd722445ed16a3b8be03671228)).
- **The spec allows it.** For oscillators it says "it is reasonable to consider lower-quality, less-costly approaches on lower-end hardware" ([section 1.26](https://webaudio.github.io/web-audio-api/#OscillatorNode)). For buffer playback, "Resampling of the buffer may be performed arbitrarily by the UA" ([section 1.9.6](https://webaudio.github.io/web-audio-api/#playback-AudioBufferSourceNode)).

I saw version drift directly. Chromium 140 and a local Chromium 151 on the same Mac gave identical oscillators, noise, gain envelopes, compressor, convolver and HRTF output. Biquads and the 4x-oversampled `WaveShaperNode` differed, by at most 5.4e-6 (-112 dB relative to peak) in the worst case.

### Denormals

- The spec never mentions denormals or flush-to-zero. The words "denormal", "subnormal" and "flush to zero" do not appear in the [editor's draft](https://webaudio.github.io/web-audio-api/).
- Chromium turns on flush-to-zero for native nodes during offline rendering. On x86 it sets MXCSR bits `0x8040` (FTZ and DAZ). On ARM it sets FPCR bit 24 (FZ) ([denormal_disabler.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/denormal_disabler.h)). Biquad state is also flushed at the end of each block (`FlushDenormalFloatToZero` in `biquad.cc`).
- Whether a denormal survives depends on the code path, not the value. In my test, a `ConstantSourceNode` at 1e-20 through a gain of 1e-20 rendered as exact zeros. A buffer full of 1e-40 played at rate 1 came out unchanged, because the fast path copies samples. The same buffer through a `GainNode` came out zero for the first quantum, where automation made the node multiply. After that it passed through unchanged, because `AudioBus::CopyWithGainFrom` returns early when `gain == 1` and the copy is in place ([audio_bus.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/audio_bus.cc), [gain_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/gain_handler.cc)). That is still deterministic for a given build. It just means denormals in generator buffers behave oddly.
- Main-thread JS runs with normal IEEE semantics, so noise generated in JS keeps its denormals. AudioWorklet JS changed recently. Until July 2026 AudioWorklet threads, including the offline one, ran JS with FTZ/DAZ on. [d3b91cca](https://chromium.googlesource.com/chromium/src/+/d3b91ccae2842f11bad90ce73e600e1dd771b8a7) turns that off behind `kAudioWorkletJSDenormalEnabler`, enabled by default, because it caused V8 miscompilation. The same worklet code can therefore produce different output on Chromium 140 and on newer builds. A 2023 WPT recorded that "Chrome's JS execution in AudioWorkletGlobalScope does not handle the denormals properly" ([06785476](https://chromium.googlesource.com/chromium/src/+/067854762d3396a37d84fe6e9498322161f9da8c)).

### Start times, sample rate and frame boundaries

- The spec says `start(when)` uses "the exact value of when... without rounding to the nearest sample frame" ([section 1.7.2](https://webaudio.github.io/web-audio-api/#AudioScheduledSourceNode-methods)). It says automation event times "are not quantized with respect to the prevailing sample rate" ([section 1.6](https://webaudio.github.io/web-audio-api/#AudioParam)).
- Chromium rounds a source's start and stop up to a sample with `TimeToSampleFrame(..., kRoundUp)`. That function first rounds `time * sampleRate` to 1/1024 of a sample, to absorb float error such as "Fs * (k / Fs) != k" ([audio_utilities.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/audio_utilities.cc), called from `UpdateSchedulingInfo` in [audio_scheduled_source_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/audio_scheduled_source_handler.cc)). The leftover fraction becomes `start_frame_offset`. The oscillator uses it to advance its starting phase, and `AudioBufferSourceNode` uses it to start between two buffer samples.
- `AudioParam` events use a plain `ceil(time2 * sample_rate)` with no snapping (`audio_param_handler.cc`). If the double for `k / fps` sits a hair above the true value, the event moves to the next sample. This is correct behavior for that double, not a bug, but it is inconsistent with source starts.
- With 48000 Hz, samples per frame are whole numbers: 4000 at 12 fps, 2000 at 24, 1920 at 25, 1600 at 30, 800 at 60. At 44100 Hz, 24 fps gives 1837.5, so every odd frame boundary falls halfway between two samples.
- Render quanta do not line up with frames. At 24 fps a frame is 15.625 quanta. This matters only for k-rate parameters, which the spec samples once at the start of each quantum ([section 1.6](https://webaudio.github.io/web-audio-api/#AudioParam)): up to 127 samples (2.6 ms) of lag. `AudioBufferSourceNode.playbackRate` and `.detune` and all `DynamicsCompressorNode` parameters are k-rate. Gain, oscillator frequency, biquad parameters, `ConstantSourceNode.offset`, `DelayNode.delayTime` and `StereoPannerNode.pan` are a-rate.
- `PeriodicWave` uses 4096-point tables for any sample rate from 24001 to 88200 Hz (`PeriodicWaveImpl::PeriodicWaveSize`), so 44100 and 48000 get the same table resolution.

### Buffer playback and resampling

- Chromium takes a fast path that copies samples verbatim only when the computed playback rate is exactly 1 and the read position is a whole sample (`computed_playback_rate == 1 && virtual_read_index == floor(...)` in [audio_buffer_source_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/audio_buffer_source_handler.cc)). Otherwise it linearly interpolates between neighboring samples. A buffer whose sample rate differs from the context's gets a playback rate of `bufferRate / contextRate`, so it always takes the interpolated path.
- Measured: a ramp buffer started at `1/24` s at 48000 Hz came out verbatim. At 44100 Hz the same start (sample 1837.5) produced 1.5, 2.5, 3.5... instead of 1, 2, 3, meaning every sample was interpolated.
- Interpolated playback is still deterministic on one build. It is also Chromium-specific (the spec leaves the method to the UA), and it slightly low-passes the buffer.

### Things I could not settle

- I found no primary source on whether Accelerate on Apple Silicon fuses `vDSP_vsma` into an FMA, or behaves differently across chip generations. Chromium's own macOS observation is the best evidence available.
- In this environment `audioWorklet.addModule()` never resolved in headless Chromium 140 or 151, and the module URL was never requested. I did not dig into why. If M7 ever wants an AudioWorklet generator, check headless support first.
- Chromium is building fingerprinting-protection noise for canvas and says it intends to reuse the noise token "in WebAudio" ([e75e787d](https://chromium.googlesource.com/chromium/src/+/e75e787d16f57f11dca607b1878509e22b149a10)). Commit search found nothing that adds audio noise yet. My cross-launch hashes matched, which rules out per-session noise in 140 and 151. Worth rechecking whenever Playwright bumps Chromium.

## Experiments

Setup: MacBook Pro, Apple M1 Pro (arm64), Darwin 27. Chromium 140.0.7339.16 is Playwright 1.55.0's `chromium_headless_shell-1187`. Chromium 151.0.7880.0 is `/Applications/Chromium.app`, run headless. All runs used `OfflineAudioContext`, 48000 Hz, stereo, 3 s. Scripts lived in a temp directory outside the repo.

I rendered 26 cases, each in its own context: sine, square, sawtooth, triangle and custom `PeriodicWave` oscillators; an oscillator with a-rate frequency automation and audio-rate FM; a seeded mulberry32 noise buffer played at rate 1, the same from a 44100 Hz buffer, and at playbackRate 0.73 with detune 30; a fixed biquad, an automated bandpass sweep, and a six-filter chain; a gain envelope using all five automation methods; a 3 s linear ramp; a `setTargetAtTime` decay; 8 sources into one gain (fan-in 8) and the same 8 through a binary tree of gains (fan-in 2); a compressor; a convolver with and without normalization; a 4x waveshaper; a stereo panner sweep; a fractional delay with feedback; an HRTF panner sweep; and three denormal probes.

| Check | Result |
|---|---|
| 3 renders in one page, Chromium 140 | 25 of 26 cases identical. `mix8_fanin` gave 3 different hashes. |
| Second browser launch vs first | Same 25 identical, `mix8_fanin` differs (max 2.4e-7, about -135 dB). |
| 4 more launches, all cases rendering at once in one page | All 25 non-fan-in cases matched the first run. |
| Fan-in sweep, 12 renders each, Chromium 140 / 151 | Distinct outputs: gain fan-in 2 = 1/1, fan-in 3 = 3/3, fan-in 4 = 7/10, destination fan-in 2 = 1/1, destination fan-in 3 = 3/3, AudioParam fan-in 3 = 6/5, ChannelMerger = 1/1. |
| Chromium 140 vs 151, same Mac | Identical except `biquad_static` (max 2.4e-7), `biquad_auto` (3.0e-8), `biquad_chain` (5.4e-6) and `waveshaper` (5.4e-7). |
| x86 SSE ramp path, emulated from source | Would differ from arm64 on 100,450 of 144,000 samples (max 1.8e-7). |

Frame-boundary scheduling, 60 s per combination, compared against the exact sample `k * sampleRate / fps`:

| Sample rate, fps | Source `start(k/fps)` off | `setValueAtTime(k/fps)` one sample late |
|---|---|---|
| 48000, 12 / 24 | 0 | 0 |
| 48000, 25 | 0 | 96 of 1498 |
| 48000, 30 | 0 | 95 of 1798 |
| 48000, 60 | 0 | 188 of 3598 |
| 44100, 12 / 24 | 0 | 0 |
| 44100, 25 / 30 / 60 | 0 | 95 / 124 / 248 |

Writing the event time as `n / sampleRate` gave the same late counts as `k / fps`. Writing it as `(n - 0.5) / sampleRate` gave 0 late events in every combination tested (48000 at 25, 30 and 60 fps, and 44100 at 30). A JS reimplementation of both rounding rules over 2 hours of frames predicted the same pattern, including the first late frame (7 at 25 fps, 31 at 30 and 60 fps).

## Recommendation for M7

1. **Export at 48000 Hz and require `48000 % fps === 0` in scene validation.** That covers 12, 24, 25, 30 and 60. Reject 29.97 and anything else that puts frame boundaries between samples.
2. **Map time to samples through the engine's frame math.** Use `frame = timeToFrame(t, fps)` from `src/engine/time.ts` so audio and video agree, then `n = frame * (48000 / fps)`. Add two helpers in `src/audio`: `sourceTime(n) = n / 48000` for `start()`/`stop()`, and `paramTime(n) = (n - 0.5) / 48000` for `setValueAtTime` and ramp endpoints that must land exactly on a frame.
3. **Never let more than two connections reach one input.** That applies to node inputs, `AudioParam`s and `destination`. Give `src/audio` a `mix(ctx, sources, dest)` helper that builds a binary tree of unity `GainNode`s. Generator authors use it for chords, layers and the master bus. Alternatively, render each clip in its own `OfflineAudioContext` and sum the results in JS in scene order. That is deterministic by construction and lets clips cache. In tests, wrap `AudioNode.prototype.connect` to count connections per destination input or param and fail above 2. That check is exact, whereas a hash comparison of two renders misses fan-in 3 one time in three.
4. **Build the whole graph before `startRendering()`.** Don't connect, start or automate from the main thread during a render, and don't schedule work from `onended`. If something truly has to change mid-render, use `suspend(t)` and accept 128-frame quantization.
5. **Rules for generator authors.**
   - Make noise from `src/engine/rng.ts` (integer sfc32) into a `Float32Array` at 48000 Hz, and never use `Math.random()`.
   - Play buffers at `playbackRate` 1 and `detune` 0, start them on whole samples, and put loop points on whole samples. That keeps playback on the verbatim fast path.
   - Avoid k-rate automation (`playbackRate`, `detune`, compressor params) for anything that must hit a frame.
   - Clamp generated values smaller than about 1e-30 to 0 so denormals never reach the graph.
   - Skip AudioWorklet for M7.
   - Prefer `StereoPannerNode` to `PannerNode`, and never touch a panner or the listener while a render runs.
   - Oscillators, `PeriodicWave`, biquads, gain automation, delay, stereo panner, convolver, waveshaper and compressor are all fine on one build.
6. **Test determinism on one machine and one pinned Chromium.** The "identical twice" test renders the scene twice, ideally in two browser launches, and compares SHA-256 of the float32 PCM before encoding. Render with the same Playwright-pinned headless shell that renders frames, and write the Chromium version into export metadata. When Playwright bumps Chromium, expect new hashes and re-record them. Any cross-machine check, such as CI on Linux x64, should compare with a tolerance (max abs diff under 1e-4 is generous) instead of a hash.
7. **Check alignment on the MP4, not the WAV.** Put a click at a known frame, decode the muxed MP4's audio with ffmpeg, and assert the click lands within one frame's worth of samples of `frame * 48000 / fps`. That catches encoder delay and container offsets, which this research did not cover. If byte-identical MP4 files are wanted too, ffmpeg's `-fflags +bitexact` writes "only platform-, build- and time-independent data" ([ffmpeg formats documentation](https://ffmpeg.org/ffmpeg-formats.html)).

## Sources

- W3C Web Audio API editor's draft, sections 1.3.3, 1.6, 1.6.3, 1.7.2, 1.9.6, 1.26, 1.28.5, 2.4 to 2.6 and 4: https://webaudio.github.io/web-audio-api/
- Chromium source, `main` as of 2026-09-22, under `third_party/blink/renderer/`: `modules/webaudio/{offline_audio_destination_handler, offline_audio_context, audio_scheduled_source_handler, audio_buffer_source_handler, oscillator_handler, periodic_wave, audio_param_handler, audio_summing_junction, audio_node_input, gain_handler, panner_handler}.cc`, `modules/webaudio/cpu/{x86/oscillator_kernel_sse2, arm/oscillator_kernel_neon}.cc`, `platform/audio/{audio_utilities, biquad, reverb, reverb_convolver, vector_math, audio_bus}.cc`, `platform/audio/{denormal_disabler, fft_frame, mac/vector_math_mac, cpu/x86/vector_math_x86}.h`. Also `build/config/compiler/BUILD.gn`.
- Chromium commits: f45416a0, aa95a901, 17b55dcb, 0c633ff4, 71258f52, ffaa15ba, 1e8d7828, 0d3c3f47, d3b91cca, 06785476, e75e787d (linked inline).
- Chromium issue 40167066, "Investigate why there are different DynamicsCompressor fingerprints on different macOS versions".
- V8 `src/base/ieee754.{h,cc}` ("adapted from fdlibm"), the library behind both `Math.*` in JS and Chromium's Web Audio math: https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/base/ieee754.cc
- ffmpeg formats documentation, `fflags bitexact`: https://ffmpeg.org/ffmpeg-formats.html
- Secondary corroboration of the fan-in finding: replayio/chromium PR 1491.
