# 0018: The timeline as an editor

Status: accepted, 2026-11-07. Widens ADR 0015: a hand can now add and remove clips and sound, not only retime them. Values, drawing and easing stay the agent's, with one exception, the transition presets below.

## Context

M15 asked for a simple video editor's timeline. ADR 0015's stack holds one layer's JSON per edit, which can't describe a clip that appears, a split that touches two, or a video that grows. Rows laid out by overlap hid the stacking order, and a scene could only reach a composition through an agent or the JSON.

## Decision

- **One route, one module.** `POST /timeline` takes an edit named in `src/studio/timeline-edit.ts`: add, split, duplicate and delete a clip, move one to another track, add and delete tracks, edit, split, duplicate and delete a cue, set a transition. The module is pure work on the file's JSON, and the workspace checks the result like `update_scene`. The lock is ADR 0015's: 409 while an agent works there.
- **Undo restores the whole.** A timeline edit answers with `duration`, `tracks` and `audio` on either side, and undo sets those three through the existing `POST /layers` under the target `structure/`. Whole lists, since an edit can touch several clips at once. The history tells our saves from anyone else's by content, as before: a structural save registers each clip and cue's words it wrote.
- **Real tracks.** The viewer draws a composition's tracks, top of the stack first. Clips that overlap on one track take a row each, so none hides. A drag up or down moves a clip to another track, on top of that track's clips.
- **A split changes nothing on screen.** Each half keeps the keys inside it and the nearest on either side, so the curve through the cut is exact. Overrides divide at the cut. A test hashes every frame and the audio before and after.
- **The video grows.** A clip added or duplicated past the end extends `duration`. A scene's length belongs to its drawing, so a duplicated cue stops at a scene's end instead.
- **No ripple.** Delete leaves a gap, and split and duplicate act on the one selected clip or sound. A selection is still one target (ADR 0003).
- **Snapping.** Clip and sound drags land on the playhead, markers and every other edge, within 6 px. The playhead joins the targets of key, bar and word drags too.
- **Sound stays in `audio[]`.** Rows by overlap, no format change, and moving, trimming, fades, split, duplicate and delete work on scenes and compositions alike, since voices live in scenes. Volume keys follow a moved cue. A video clip's own sound follows its clip.
- **A generator doesn't split.** It would start over at the cut.
- **A voice that captions or anchors read doesn't split.** A `captions` rig reads one cue, so the second half would lose its captions without a word. The refusal says to trim instead. A voice nothing reads splits, and each half keeps the words it says.
- **Transitions are plain keys.** A preset writes `opacity` keys or a mask on the clip's start, half a second long, so an agent can edit the result and a move carries it. No `transition` field and no engine work. Wipe and iris use the rigs `mask-wipe` and `mask-iris`, ids of their own so a folder's `iris` rig stays legal. A preset also runs the clip before on under the new one, where that clip ends at the join and has more to show. Removing a preset takes off what presets write and leaves an agent's masks and keys alone. This is the exception to ADR 0015: these keys hold values, written from a fixed recipe.
- **The composition cue limit stays.** A clip still renders the same inside its composition and alone (ADR 0013). "Move to a voice scene" moves a cue into a new scene with a `captions` layer and places that as a clip on its own track, so sound and captions move together with one copy of the words.
- **The Edit menu asks the viewer.** Undo and Redo are menu items of ours, not roles: the viewer runs a text field's own, else the hand edits'. The key takes the same path once the page declines it.

## Refused

Multi-select and marquee (ADR 0003), ripple, per-cue tracks, a `transition` field, and clips reading a parent's cues, which would break ADR 0013's rule.

## Consequences

- Undoing "Move to a voice scene" leaves the new scene in the library, with nothing playing it.
- Word anchors in a composition that pointed at a moved cue become orphans. They keep their last time, and the check tool reports them.
- Trimming a clip's start leaves its transition keys where they were, cut off. Apply the preset again.
- A mask rig that uses its rng draws differently on the second half of a split, since the seed comes from the layer's id. The preset rigs don't use it.
- `/timeline` can set a file's duration, and `/layers` under `structure/` its tracks and sound. Both run the same validation as an agent's edit.
