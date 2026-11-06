# 0014: Pixel stages, a camera, measured checks, and recorded pictures in compositions

Status: accepted, 2026-11-06. Changes CLAUDE.md's "no image, video or font assets in the picture" and ADR 0012's "the picture stays drawn in code". Moves the camera out of "Later".

## Context

Research on Science in 8bit and HyperFrames (`.scratch/frame-studio/research/science-in-8bit-and-hyperframes.md`) found no secret tool. Science in 8bit's MP4s are tagged as Remotion renders, drawn on a 180x320 canvas and scaled up, and its quality comes from a brief, a beat sheet, sync points by frame, and films measured before anyone sees them. HyperFrames places video and images next to HTML. It has about 450 catalog blocks and a full editor, which we won't beat by copying.

Our engine couldn't make those films. Vectors downscaled to 180x320 go soft and off-palette, there was no camera, an agent couldn't measure motion or sound, and nothing recorded could enter the picture.

## Decision

- **A pixel stage is a scene field.** `pixel: { scale, palette?, dither? }`. `size` stays the output size, and rigs draw on `size / scale`. `render()` draws the layers on a small CPU surface, snaps it to the palette with ordered dither, and blows it up with square pixels, so every host gets it and no host changes. Dither is a pure function of (x, y). Coordinates, tracks and `Stage` are the small stage's. A pixel stage places nothing, and a composition has no pixel stage: each clip brings its own and renders as it does alone.
- **A camera is a scene field, with depth on layers.** `camera: { x, y, zoom, tracks }` and `layer.depth`. It is applied in `drawLayer`, so hit testing and selection follow it. Depth 0 stays put, 1 is the world, in between is far away; the background defaults to 0. On a pixel stage, each layer moves by whole pixels.
- **Markers name moments.** `markers: [{ t, label }]` on scenes and compositions show on the timeline. They draw nothing. A label ending in `!` is a sync point the check tool tests against the audio.
- **Checks are measured, on the render worker.** `check` covers format, black, freeze, opening, loop seam, flashing, sparse stretches, loudness and sync. Agents run it before calling a film done, because they can't watch or hear.
- **Compositions can place recorded pictures.** A clip takes `file` (image or video in `media/`) in place of `scene`, with `in`, `out`, `fit`, and `sound` to keep a video's audio. **Scenes stay code.** The agent-authored premise lives there, and a scene that names a file is refused.
- **`render()` stays synchronous.** As with sound files (ADR 0012), hosts decode. `picturesAt` says what a frame needs, the host awaits that, and `world.pictures` hands it to the render. A video frame is the last one starting at or before t, reached the same way by playing or seeking. An export fails if it can't read a file; the viewer holds the nearest decoded frame while one arrives.
- **The embed stays free of decoders.** Mediabunny stays in the viewer and the worker. An HTML export of a composition with picture clips is refused with the reason, and MP4 and GIF carry them.

## Refused

A catalog of blocks, an office of crew characters, a layer panel, GSAP, HTML authoring, video in scenes or rigs. A shipped ffmpeg stays refused (CLAUDE.md).

## Consequences

- With picture clips, frame N is a pure function of (scene, frame, media files, browser build). Video decoders can differ by machine, so we ask for software decoding and promise pixels per Electron build, as ADR 0012 does for sound.
- Picture clips need `out`, since the validator doesn't read files. Agents get lengths from `list_media`.
- The one-file embed covers pure scenes and compositions of them. That is still the edge, and it's why the picture stays code by default.
