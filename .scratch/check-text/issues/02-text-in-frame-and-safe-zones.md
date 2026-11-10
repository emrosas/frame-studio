# Text cut by the frame, and text under platform interface

Type: task
Status: resolved
Blocked by: 01

## Work

Compute each visible text layer's glyph boxes in output pixels on every frame, from the scene alone (`src/export/text-marks.ts`). Then two rules:

- `text-frame`: text that runs past the frame edge. Text moving through the edge is an entrance or an exit, so only frames where its box holds still count. P1, since letters are missing.
- `text-safe`: text inside the zones a platform covers. A vertical stage uses the TikTok, Reels and Shorts insets in `src/engine/safe-area.ts`, the same numbers the viewer's guide and the captions rig use; P1, since the interface hides it. Any other shape uses that file's 5% title-safe margin; P3, since nothing covers it on a phone or a web player. No new zones: the one table stays in `safe-area.ts`. Text that's cut is `text-frame`'s to report. Captions in the scene itself are `caption-safe`'s; captions inside a clip are this rule's.

Compositions: text inside clips, at the clip's placement, scale, rotation and opacity, through nested compositions.

## Acceptance criteria

- [x] The text rig and the marks share one layout-and-placement function.
- [x] Marks follow clip placement, nested compositions, the camera and the pixel stage; unit tests on synthetic scenes prove each.
- [x] `text-frame` passes text sliding in from off frame and fails text resting across the edge, with frames.
- [x] `text-safe` names the zone on a vertical stage (top, bottom, right side) and ranks P1 there, P3 elsewhere.
- [x] No check code in `src/engine`, `src/rigs` or `src/embed`; the runtime budget test passes.

## Answer

`textBlock()` in `src/rigs/type/text.ts` is the one layout-and-placement function; the rig draws from it and `src/export/text-marks.ts` measures it. Glyph ink comes from the outline's points, which can only err large, so the edge test allows 2 px. Marks follow clips (placement, opacity, centring of other sizes, nesting), the camera by depth, and the pixel stage.

Found while testing through the worker: the renderer cuts a moved clip to its own stage, and the marks didn't, so hidden letters got measured against the composition's background. Marks now carry the clips above them: `area` (where text can show) and the clip edges, used by every rule and by the contrast pixel test. Text past a moved clip's edge counts as cut.

"Holds still" means the box hasn't moved for 0.25 s either side, so a layer stepped on fours still counts as moving. No new zones: `safeArea()` is the one table. It treats any stage taller than wide as a vertical short, which may be strict for 4:5; changing it would move existing captions, so I left it.
