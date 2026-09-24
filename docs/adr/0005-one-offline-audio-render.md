# 0005: One offline audio render feeds preview, embed and export

Status: accepted, 2026-09-24 (M7, ticket 12)

## Context

A scene's sound comes from generators: code that builds a Web Audio graph for a cue, the way a rig draws a layer. The sound has to follow the same rule as the picture, where the same scene always gives the same result, and it has to line up with the frames in the viewer, the single-file embed and the MP4.

Ticket 04 found that `OfflineAudioContext` output is bit-identical run to run on one machine and one Chromium build, as long as no input gets three or more connections. A live `AudioContext` gives no such promise, and scheduling a generator live after every seek would mean building half-played graphs mid-cue. Ticket 14 found that WebCodecs AAC plays 44 ms late in ffmpeg and Chromium unless the file signals the encoder's 2112 priming samples with an edit list and a `roll` sample group, and that Mediabunny writes only the edit list.

## Decision

- **One render.** The whole scene's audio renders once, offline, at 48 kHz stereo and exactly as long as its frames. The viewer and the embed play that buffer through an `AudioBufferSourceNode`, and exports encode it, sliced for a range. What you hear while previewing is what the file gets.
- **Frames decide time.** A scene with audio needs an fps that divides 48000, so every frame starts on a whole sample. Cue starts and ends snap to their frames through the engine's `timeToFrame`.
- **Two connections per input at most.** Generators sum with `mix()`, a tree of two-input gains, and a unit test and a browser test check fan-in.
- **Live sync follows the clock.** The playback clock stays the master. `PlaybackClock.position()` gives the playhead with a fraction, and `LivePlayback` starts the buffer there, ahead by the output latency, loops it over the clock's active loop, and starts over when it drifts more than 40 ms, on a seek, or on a loop change.
- **AAC with its priming signalled.** Packets shift back by 2112 samples, so Mediabunny writes the edit list. Then `finishAudioTrack` patches the moov Mediabunny reports through `onMoov`, adding the `roll` group and trimming the audio to the video's length. It grows into the free space fastStart `'reserve'` leaves, so `mdat` never moves and exports still stream. Opus is the fallback where there is no AAC encoder. It carries its own start delay, so its packets aren't shifted, and the same patch gives it an edit list that trims the end.
- **Silent unless asked.** The embed renders its sound on load but starts muted, with a speaker button, because browsers allow sound only after a gesture. Embeds of silent scenes, and silent exports, carry no audio code.

## Consequences

- A scene's sound costs one offline render when it opens, and again when its cues or a generator change. It is milliseconds for short scenes, and it grows with length and graph size. Nothing is rendered for silent scenes.
- Generators can't react to anything but their cue, params and seed. A sound that follows the picture, such as a buzz panning with a fly, has to be written as params or cues.
- Cross-machine and cross-build output differs at around -110 dB, so determinism tests compare hashes on one machine and one pinned Chromium only.
- Opus plays 312 samples (6.5 ms) late in AVFoundation, which ignores the start delay Opus carries. ffmpeg plays it on time, and so did Chromium when ticket 14 measured the same stream without the trimming edit list.
- The 2112 priming count is AudioToolbox's, on macOS. Media Foundation's count on Windows is unmeasured, so Windows AAC exports may be off by a few milliseconds until someone measures it.
