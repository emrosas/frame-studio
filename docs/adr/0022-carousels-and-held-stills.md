# 0022: Carousels, and stills held in videos

Status: accepted, 2026-11-17, on the owner's request. Changes ADR 0020: a still can now be a clip in a video, and "a carousel as a file of its own" leaves its Refused list in a smaller form. Changes ADR 0021: an html layer still belongs on a still, and that still may now be placed in a video.

## Context

The owner posts carousels: 4 to 8 stills swiped in order. ADR 0020 left them as scenes that happen to share a name, so nothing knew `launch-1` to `launch-6` were one post, in that order, and exporting them meant six folders. Some stills are single images and belong to no group. The owner also wants a still usable in a video, like any image, for as long as the video needs it. ADR 0020 had ruled that out twice over: a clip had to share its composition's fps, and it ended when its scene did, after one frame.

## Decision

- **A carousel is a list in `project.json`.** `carousels: [{ id, slides }]`, where `slides` are scene ids in the order they are swiped. No new file type: the project file already holds what spans scenes (the cast), it is validated and patched by tools that exist, and a carousel has nothing in it but order. A slide must be a still, a still is in one carousel at most, and a carousel emptied of slides is removed. A scene that leaves the folder is skipped where carousels are shown.
- **Exported together, in order.** A carousel exports to one folder, `out/<carousel>/01-<scene>.png`, `02-…`, so the files sort as the post swipes. A still on its own keeps `out/<scene>/<scene>.png`.
- **The still's dock is its carousel.** A still has no timeline, so under the selection bar the dock shows the carousel as a strip of slides. A click opens a slide, Left and Right step through them, a drag reorders, and buttons add an empty slide the size of the last, take the one on screen out, or start a carousel from a still that has none. This is the "canvas" for a post: you edit one slide large with the others in view.
- **The Library lays them out.** A Stills section shows each carousel as a row of its slides in order with its own Export, then the stills on their own, apart from scenes that move.
- **Export stills from the viewer.** The Export panel on a still exports this still, its carousel, or every still. The Library has the same per carousel and for all.
- **A still is held like an image.** A clip of a still shows its one frame for `out - in` seconds, at the composition's fps whatever the still's own. `out` is required, as it is for an image clip, since a still has no length of its own. The engine marks such a span `hold`, and `shotFrame` answers 0 across it. Dropped on the timeline it starts 3 seconds long, like an image, and its edge trims past its own second. A held still brings no sound.
- **Tools.** `edit_carousel` makes the same edits as the strip. `export_stills` takes `carousel`. `create_html_stills` groups several pages as a carousel named after them, unless told not to.

## Refused

- A free-form board where slides sit anywhere. Order is the only arrangement a carousel has, and a strip shows it. If comparing posts side by side becomes the need, the Library's rows are where that grows.
- Shared settings on a carousel (a size, a theme). Slides are whole scenes; an html carousel shares its look through its stylesheet.
- Deleting a still's file from the strip. Remove takes it out of the carousel and leaves the scene.

## Consequences

- A still with an html layer can now be in a video, so MP4 and GIF carry pages after all, through the still. Each frame of the hold is the same picture, so the determinism rule is untouched. The one-file embed still refuses, through the composition.
- A carousel edit writes `project.json`, outside the scene undo stack. Command-Z doesn't take back a reorder; drag it back.
- A carousel's id names its export folder, so it can't be a scene's id.
- Reordering doesn't rename scenes: `launch-3` can be the first slide. The exported file names carry the order.
