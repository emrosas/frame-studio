# Benchmark exports through the render worker

Type: task
Status: resolved

## Why

Promotional videos will run 10 to 15 minutes. The only number we have is bear-test at 1080p: 58 ms a frame (45 ms Chromium CPU raster, 10 ms recording draw calls, 3 ms encode), measured in the dev server rather than the render worker. Before deciding whether canvas 2D in Electron is fast enough, or rewriting anything, we need repeatable numbers from the path exports actually take.

## Work

- A command, `npm run bench:export`, under `tools/`, that exports MP4 through a real render worker in Electron and reports milliseconds per frame by stage: draw (recording draw calls), raster (the pixel readback that forces Chromium to rasterize), convert (RGBA to I420), encode, mux and audio.
- Three cases: a heavy repo scene at 1080p, a 9:16 short with sound, and a long composition of 5 to 15 minutes built from existing scenes in a temporary studio folder. Nothing new goes in `scenes/`.
- Results in `.scratch/export-speed/research/benchmark.md` with the machine (`sysctl -n machdep.cpu.brand_string`, cores, RAM) and a projection for 10 and 15 minute videos at 24 and 30 fps.

## Acceptance criteria

- [x] `npm run bench:export` runs from a clean checkout with Electron installed and prints a per-stage table for each case.
- [x] The numbers come from the render worker, not the dev viewer.
- [x] The long composition is generated in a temp folder and cleaned up afterwards.
- [x] `benchmark.md` records the machine, the per-stage numbers and the 10 and 15 minute projections at 24 and 30 fps.

## Outcome

Built 2026-11-10 as `tools/bench/export.ts`. It starts a studio server with a render worker in Electron, warms up, then exports each case at each worker count and prints per-stage tables and projections; with ffmpeg it also compares each parallel file's decoded frames and sound with the one-worker file. Results in `../research/benchmark.md`: one worker takes 34 ms a frame on a 5 minute composition and 65 ms on `bear-test`, mostly CPU raster (17 to 41 ms) and RGBA to I420 conversion (10 to 14 ms). The machine was shared with other sessions' test runs, so load averages are recorded per row.
