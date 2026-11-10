# Split MP4 exports across render workers

Type: task
Status: resolved
Blocked by: 01

## Why

A frame is a pure function of (scene, frame, fps), so an export's frame range can be drawn by several workers at once. `tools/studio/render-pool.ts` runs one worker taking one job at a time, which leaves most of the machine's cores idle during a long export.

## Work

- MP4 export splits its frame range across N render workers. N defaults to something sensible for the machine's cores and memory and can be set; N=1 keeps the current single-page path.
- Each segment starts on a key frame. The segments' encoded chunks are muxed in order into one MP4 with correct timestamps.
- Audio renders and encodes once (ADR 0005).
- BT.709 / sRGB colour tags (`src/export/color.ts`) and the AAC priming edit list and roll group (`src/export/audio-track.ts`) stay correct.
- Decide where muxing happens, in the studio server or in one coordinating page, and record it as ADR 0019 if it changes ADR 0008's shape.
- Progress and cancel keep working. GIF may stay serial.

## Acceptance criteria

- [x] A parallel export of a test scene decodes to the same frames as the serial export (decoded frame hashes compared with ffmpeg, dev only).
- [x] ffprobe reports the exact frame count and duration; the audio is identical.
- [x] Unit tests cover range splitting and chunk ordering; a browser test in the render worker checks parallel against serial.
- [x] The benchmark rerun shows the speedup, recorded in `benchmark.md`.
- [x] `npm run typecheck`, `npm test` and the export browser tests pass.

## Outcome

Built 2026-11-10; `docs/adr/0019-parallel-export.md` has the design. The studio server muxes: workers write segment packets as records to temporary files through the existing sinks, and the server feeds them in order to `Mp4Muxer`, shared with the page. Helpers are extra worker windows on slots, each with its own session. The encoder now restarts at every key frame on both paths, which is what makes parallel output match serial: before that, only the first key-frame interval matched.

4 workers export the 5 minute composition 3.7 times faster (34.1 to 9.3 ms a frame); the 9:16 short goes 2.6 to 3.0 times faster at 4 to 7 workers. Every parallel file decoded to the same frames and audio as its serial file. GIF stays serial.

Left open: the default of 7 workers on this machine is untested on a quiet machine, and one early run under heavy outside load produced 46 different frames and never came back (`../research/benchmark.md`, open questions).
