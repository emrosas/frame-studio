# 0015: Hand edits on the timeline and the canvas

Status: accepted, 2026-11-06. Changes ADR 0013's "the timeline editor edits compositions only": a scene's keys edit on the timeline too.

## Context

The roadmap left two things for after M15's first pass: moving keys in time, and dragging a layer on the canvas. Until now a scene changed only through an agent or a file edit. The timeline showed key times as thin ticks nobody could read, and a pair of ticks was usually one fade. The agent still writes the drawing, so these edits have to stay narrow, and they have to land in the same scene JSON an agent reads next.

## Decision

- **Hand edits change when and where, not what.** A key's time moves by hand; its value stays the agent's and the canvas drag's. Rigs, colours, easing and overrides' contents are the agent's. The engine, rigs, the embed and the selection shape don't change, and every frame still comes from `render(ctx, scene, frame, registry)`. The one addition to the engine is exporting `cameraView`, so a drag reads the camera the render uses.
- **What a key edit writes.** Times on tracks. A diamond on the row moves every param's key in that frame, and a diamond on a lane moves that param's. It lands on a frame, inside the scene, and stops short of the next key of the same param. Dragging a row's bar shifts all the layer's keys and overrides. Dragging a bar's end moves that fade's two opacity keys. A row with no opacity track has no fades to show, so its quiet bar stays what it was, an empty row to drag a range on. Deleting a track's last key removes the track and writes its value to the param, so the look doesn't jump.
- **The three-way rule for a canvas drag.** With a range set and the playhead inside it, the axes it moved go in an override on that range: the override with exactly that range is updated, and one that only overlaps refuses the drag with a notice. Otherwise each axis goes by itself: into an override already setting it on this frame, since that outranks the rest; else a key at the playhead if the axis has a track, taking the ease of the key after it, since a key's ease shapes the way into it, or else the one before; else the param. An axis the drag didn't move stays as it is. A key lands on the layer's held time, so a `stepFps` layer shows it on this frame.
- **A drag is viewer-only until it lands.** While it runs the viewer renders a patched copy of the scene through the normal path, and the overlay follows. The layer stays held after the save until the file shows the same thing, so the picture doesn't flicker back. Nothing is written until the pointer lifts, and Escape puts it back.
- **One checked edit.** `POST /layers` takes `{ scene, layer, set }`, where each field of `set` replaces that field of the layer, and null removes it. It takes scene layers, the background, composition clips and old films' qualified ids. It goes through the same validation as `update_scene`, and answers with the layer on either side. Only timing and placement fields can be set.
- **The lock.** While an agent has a turn working on a scene or composition, hand edits on it are refused: the server answers 409, the same as for clips, and the viewer shows keys and layers as fixed. An agent's edits and a hand edit never race for one file, and a checkpoint taken at claim time stays good.
- **Undo is one stack.** Command-Z covers key edits, canvas drags and clip moves. Each entry stores the layer's JSON before and after, as the server read it, and restores it through the checked edit, so an override a clip move pushed off the end comes back. As before, a change from outside clears the stack, since an inverse is no longer known to be right. Each save's answer says what it wrote, and a file change seen while a save is out waits for that answer.

## Refused

Editing values on the timeline, curve editing, and multi-select of keys. A value change is a prompt, or a drag. A selection is still one target (ADR 0003).

## Consequences

- A scene's file can now change between turns. Revert restores a turn's checkpoint, so it takes back hand edits made after that turn too.
- Canvas drags, and the snapping to centre lines, assume a rig's x and y are its place on the stage. A rig that uses them otherwise moves strangely.
- A rig without numeric x and y can't be dragged, and the dock says so once for each layer.
- A run of Left and Right presses saves once, 250 ms after the last, as one undo step.
