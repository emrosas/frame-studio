# M1: Engine and viewer

Type: task
Status: resolved
Blocked by: none

## Work

Build milestone M1 as written in `docs/ROADMAP.md`. The ticket resolves when every M1 acceptance criterion passes.

It also has to make the scene creation flow testable. An agent writes or edits a file in `scenes/`, and the open viewer shows the change at the same frame.

## Answer

M1 is built and all four acceptance criteria pass. The checks are 544 tests, a clean typecheck and build, and a frame-by-frame look in headless Chromium. A five-lens review found 26 real problems, and all are fixed. The main ones were that the validator ignored misspelled fields, invalid colours painted black, a reload could land on a stale frame, and decimal `stepFps` floored one step low.

Four decisions came out of the build, and `docs/PROGRESS.md` records them. `render` takes the rig registry. `draw` gets a fifth `stage` argument. Tracks evaluate at the layer's quantized time. Override params beat track values. The scene loop works: edit a file in `scenes/` and the open viewer swaps it in at the same frame without reloading. `docs/SCENES.md` is the authoring guide.
