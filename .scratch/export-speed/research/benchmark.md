# How fast does MP4 export run, and how long will a 15 minute video take?

Research for [ticket 01](../issues/01-benchmark.md) and [ticket 02](../issues/02-parallel-export.md). Measured 2026-11-10 with `npm run bench:export`.

## Machine

Apple M1 Pro, 8 cores (6 performance, 2 efficiency), 16 GB, macOS 27.0.1, Node 26.13.0, Electron 44.4.5 (Chromium 152).

The machine wasn't idle. Other agent sessions were running browser tests and builds in other worktrees the whole time, and the one-minute load average sat between 7 and 23 for most runs, with spikes to 60 and 97. Each table row records the load at its start and end. Treat single numbers as plus or minus 15%, and the 7-worker long run as an outlier (see below).

## Short answer

Staying on canvas 2D in Electron is fine for 10 to 15 minute videos. One render worker takes 34 ms a frame on the long composition and 65 ms on `bear-test`, the heaviest scene, so a 15 minute video at 30 fps took 15 to 29 minutes. Splitting the export across 4 render workers brings the long composition to 9.3 ms a frame, 3.7 times faster: a 15 minute video at 30 fps in about 4 minutes, and one as heavy as `bear-test` in about 8. The parallel files decode to exactly the same frames and sound as the one-worker files in every run.

Where the time goes, per frame on one worker: Chromium's CPU raster (the `getImageData` readback that makes it paint what was recorded) is the largest stage, 17 to 41 ms; our RGBA to I420 conversion in JavaScript is next, 10 to 14 ms; recording the draw calls is 2 to 8 ms; encoding and muxing together are about 1 ms. Raster and conversion are both CPU work that splits cleanly across processes. Nothing here points at Rust: Skia is already native, and the next win is more processes, or moving the conversion off JavaScript, not a new language.

## Before: main (one page per export)

Exports through main's own CLI (`npm run export`) at `e4901c5`, in a temporary worktree:

| Case | Frames | Export time | ms per frame |
| --- | --- | --- | --- |
| `bear-test`, 1920x1080 at 12 fps | 96 | 6.3 s | 65.6 |
| `why-lakes-stay-liquid`, 1080x1920 at 30 fps, with sound | 600 | 10.5 s | 17.5 |
| 5 minute composition, 1920x1080 at 24 fps, with sound | 7200 | 224.1 s | 31.1 |

The export time is the page's own, so it leaves out the server and worker startup. The same command on this branch with `--workers 1`, right after, at load 10 to 12, took 223.2 s for the long composition, against main's 224.1 s at load 11. The benchmark's one-worker long row below (245.4 s wall) started at load 19. So restarting the encoder at every key frame (ADR 0019) costs nothing measurable, and the one-worker rows below are main's speed give or take load.

## After: by stage and worker count

Stage columns are milliseconds per frame summed over workers, so they read as CPU time; "wall" is what a person waits. Draw includes `prepare` (no picture clips here, so about 0). Mux on a parallel row includes the workers' writes of their packets to the server.

| Case | Workers (used) | Segments | Draw | Raster | Convert | Encode | Mux | Audio | Wall ms/frame | Wall s | Speedup | Parallel = serial | Load |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| heavy: `bear-test`, 1920x1080, 12 fps, 96 frames | 1 | 1 | 8.1 | 41.4 | 13.9 | 1.4 | 0.1 | 0.0 | 65.3 | 6.3 | 1.00x | (reference) | 21 to 20 |
| | 2 | 4 | 9.0 | 41.8 | 13.4 | 1.6 | 0.2 | 0.0 | 37.3 | 3.6 | 1.75x | identical | 20 to 19 |
| | 4 | 4 | 11.1 | 45.0 | 14.2 | 2.7 | 0.2 | 0.0 | 27.6 | 2.6 | 2.37x | identical | 19 to 21 |
| | 6 (4) | 4 | 9.1 | 42.9 | 14.6 | 1.7 | 0.2 | 0.0 | 18.7 | 1.8 | 3.49x | identical | 21 to 21 |
| | 7 (4) | 4 | 8.9 | 42.5 | 14.3 | 2.0 | 0.1 | 0.0 | 18.1 | 1.7 | 3.61x | identical | 21 to 20 |
| short: `why-lakes-stay-liquid`, 1080x1920, 30 fps, 600 frames, sound | 1 | 1 | 1.8 | 3.8 | 10.3 | 0.8 | 0.1 | 0.2 | 17.0 | 10.2 | 1.00x | (reference) | 20 to 18 |
| | 2 | 6 | 1.9 | 3.9 | 10.5 | 1.0 | 0.5 | 0.4 | 9.3 | 5.6 | 1.83x | identical | 17 to 17 |
| | 4 | 9 | 2.3 | 4.3 | 11.5 | 2.5 | 0.2 | 0.5 | 6.7 | 4.0 | 2.55x | identical | 17 to 16 |
| | 6 | 10 | 2.4 | 4.4 | 11.9 | 8.0 | 0.7 | 0.7 | 5.9 | 3.6 | 2.86x | identical | 16 to 18 |
| | 7 | 10 | 2.2 | 4.4 | 11.6 | 10.9 | 0.2 | 0.8 | 5.7 | 3.4 | 2.97x | identical | 18 to 21 |
| long: 5 minute composition, 1920x1080, 24 fps, 7200 frames, sound | 1 | 1 | 2.8 | 16.7 | 13.4 | 0.8 | 0.3 | 0.2 | 34.1 | 245.4 | 1.00x | (reference) | 19 to 10 |
| | 4 | 27 | 3.3 | 18.1 | 13.3 | 1.2 | 2.5 | 0.4 | 9.3 | 67.0 | 3.66x | identical | 8 to 23 |
| | 7 | 41 | 5.0 | 23.4 | 16.5 | 7.2 | 17.9 | 0.8 | 9.3 | 66.7 | 3.68x | identical | 16 to 63 |

"Identical" means ffmpeg decoded every frame of the parallel file to the same MD5 as the one-worker file, and the decoded audio to the same MD5. The browser test goes further and compares every stored packet, after dropping the SEI units: VideoToolbox puts a user-data SEI before each key frame whose two varying bytes differ between any two runs, serial ones included, and no decoder reads it.

The long composition cycles `bear-test`, `shapes-test`, `type-test` and `why-lakes-stay-liquid` (the 9:16 short centred on the 16:9 stage, with its sound) for 5 minutes. The benchmark copies the scenes into a temporary studio folder at 24 fps and deletes it afterwards.

## Projection for 10 and 15 minute videos

From the measured wall ms per frame. The long composition is the closest to a real promotional video; `bear-test` is the worst case, a full-screen painted character in every frame.

| Content | Workers | 10 min at 24 fps | 10 min at 30 fps | 15 min at 24 fps | 15 min at 30 fps |
| --- | --- | --- | --- | --- | --- |
| like the long composition | 1 | 8 min 11 s | 10 min 13 s | 12 min 16 s | 15 min 20 s |
| like the long composition | 4 | 2 min 14 s | 2 min 48 s | 3 min 21 s | 4 min 11 s |
| like `bear-test` throughout | 1 | 15 min 40 s | 19 min 35 s | 23 min 30 s | 29 min 23 s |
| like `bear-test` throughout | 6 or 7 | 4 min 20 s | 5 min 26 s | 6 min 31 s | 8 min 08 s |

The `bear-test` parallel row is from a 96 frame export split into 4 segments, so it runs 4 workers at a time; a long export of that weight would keep more workers busy, and the long composition suggests the gain beyond 4 is small on this chip.

## What limits the speedup

- **Contention.** With 4 workers the per-frame raster cost rose 8 to 15% and conversion stayed flat; at 7 it rose 40% and encode jumped from about 1 ms to 7 to 11 ms a frame. Six performance cores, a shared memory bus and one hardware video encoder (the M1 Pro has a single encode engine) are shared by every worker. The 7-worker long run started at load 16 and ended at 63 as another session's tests started, so its numbers say little; the short case's 6 and 7 rows are cleaner and show 2.9 to 3.0x against 2.55x at 4.
- **Startup.** A helper window takes about a second to open and load the scene, which shows on short exports: the heavy 4-worker row opened its helpers inside the timed run, while the 6 and 7-worker rows found them already open. Exports under 10 seconds stay in one page for that reason.
- **The tail.** Segments shrink toward the end of the range so workers finish together. Before that change, equal segments left one worker drawing the last segment alone for several seconds.
- **Bugs found on the way.** Six or more workers in one Electron session hung: Chromium's limit of six connections per host was used up by the workers' job streams, so their writes never went out (ADR 0019). Each helper now has a session of its own. A parallel export now also stops with an error after two minutes without progress.

## Memory

During a 7-worker export of the 9:16 short, each worker's renderer process held 175 to 325 MB, and the whole Electron worker process, GPU and network processes included, about 2 GB. The default worker count assumes 1.5 GB a worker, which leaves room.

## Open questions

- Is 7 the right default here? It is the formula's answer for 8 cores and 16 GB (one per core less one, capped by memory). The data shows little gain past 4 to 6 on this chip and more encoder contention; a quiet machine should settle it. `FRAME_STUDIO_EXPORT_WORKERS` and `--workers` override it.
- One early run, while another session was running Electron exports and the machine was heavily loaded, took 914 s instead of 5 s and decoded 46 frames differently from the serial file. It didn't come back in any later run, including one at background QoS, one under 8 busy loops, and every benchmark row above. The likeliest causes are the connection limit above combined with job retries, or VideoToolbox under contention from other processes. The benchmark compares decoded frames on every run so a repeat would show.
- RGBA to I420 in JavaScript costs 10 to 14 ms a frame, a fifth to a half of a worker's time. Integer arithmetic, or a WebGL or WebGPU pass, could cut that, as long as the output stays the same bytes the colour tests check.
