# 0020: A still is a scene with one frame

Status: accepted, 2026-11-17. Fills in M16. Adds one case to ADR 0015's rule for a canvas drag. ADR 0022 changes two things here: stills are grouped as carousels in `project.json`, and a still can be held as a clip in a video.

## Context

The owner designs still images for social posts, 4 to 8 slides a day at 1080x1350, and wants to finish them here: open a still, click an element, drag it or leave a note for the agent, and export an image at the exact size. Until now the only image the tools wrote was `render_frame`'s PNG, the viewer exported MP4, GIF and HTML only, and every scene showed a timeline.

Two ways to model a still were on the table. A field, `still: true`, would be explicit, but the validator, both libraries, the embed and every tool that reads a scene would have to learn it, and a scene could then say `still` while its `fps` and `duration` say otherwise. The other way needs nothing new: a scene already has a frame count, and one frame is a still.

## Decision

- **A still is a scene whose frame count is 1.** `isStill(scene)` in `src/engine/time.ts` is `frameCount(scene) === 1`. No field is added. `render()`, hit testing, the embed, the render worker and the scene format don't change, and frame 0 of a still renders as frame 0 of any scene does. New stills are written as `"fps": 1, "duration": 1`, which reads plainly in the file. A scene someone shortens to one frame becomes a still, and a still given a longer `duration` becomes an animation again, with the same layers.
- **Image export is a target, for one frame.** `png` and `jpg` join `mp4`, `gif` and `html` on the `export` tool, the Export panel and the CLI. They take `frame` (0 when left out) and write the canvas at the scene's size through the render worker, which Chromium encodes. `jpg` takes `quality` from 1 to 100, 90 when left out, and has no alpha, so the frame is drawn over white first. A still's file is `out/<scene>/<scene>.png`; a frame of a longer scene is `out/<scene>/<scene>-00047.png`. `render_frame` stays what it was, a look for the agent.
- **A new still.** `create_scene` and the viewer's New scene take `still: true` in place of `fps` and `duration`. New scene offers the sizes social posts use: 1080x1350, 1080x1080, 1080x1920 and 1200x628.
- **The viewer steps aside.** On a still the dock keeps the selection bar and drops the transport, the timeline and the range fields. Space, the arrows, I, O and X do nothing. Selecting, hovering, dragging on the canvas and sending a request work as before, and the selection's range is `[0, 1)`.
- **A drag on a still writes the param.** ADR 0015's rule would write a key when the axis has a track. On a still a key means nothing, so the drag removes that axis's track and writes the param. An override that already sets the axis on frame 0 still takes the value, since it outranks the param.
- **`check` on a still.** The checks that need time pass with "Skipped: a still has one frame": `duration`, `freeze`, `opening`, `loop-seam`, `flashing`, `sparse` and `reading-time`. `format`, `black`, `text-frame`, `text-safe` and `text-contrast` run. Sound checks run as they do for any scene, which for a still without cues is a pass.
- **Several stills in one call.** `export_stills(sceneIds?, format?, quality?)` exports each scene given, or every still in the folder, and reports each file or the reason it failed. A carousel is a handful of scenes, so this is the loop an agent would write anyway.

## Refused

- A `still` field on the scene, for the reasons above.
- A carousel or post as a file of its own. Slides are scenes named in order, like `launch-1` to `launch-6`. If ordering and shared settings start to hurt, a composition-like file can come later.
- Hiding MP4 and GIF by rewriting the exporter. The Export panel offers PNG, JPG and HTML on a still; the tools still accept `mp4` and `gif` and make a one-frame file, which nobody is stopped from wanting.

## Consequences

- A still at 1 fps can't sit as a clip in a 30 fps composition, since a clip shares its composition's fps (ADR 0013), and a one-frame clip would show for one frame anyway. Holding a still in a video is a later question.
- The 4:5 size counts as vertical, so `text-safe` judges it against the TikTok, Reels and Shorts zones, which an Instagram feed post doesn't have. The safe areas are approximations already (PROGRESS, known issues); a feed-post area is a follow-up.
- JPG bytes come from Chromium's encoder, so they hold per Electron build, as PNG pixels do.
- Stills in films made before compositions aren't offered: such a scene must take its film's fps and has no use for one frame.
