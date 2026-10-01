# 0012: Frame Studio mixes recorded media into code-drawn work

Status: accepted, 2026-10-02. Changes the founding rule that a scene has no media assets (CLAUDE.md, "Runtime budget").

## Context

Frame Studio began as a tool for animations drawn entirely in code, with procedural sound, no media files, and a single-file HTML export as its edge. Making real videos shows the limit: a voiceover can't be synthesized, and music rarely should be. The finished work is mostly an MP4 or a still image, where a file of recorded sound costs nothing, and the HTML export is the only output that suffers.

## Decision

- **Frame Studio is a suite for making videos and images from code that mixes in recorded media.** The picture stays drawn in code. Recorded sound comes first, as files in a studio folder's `media/`. Images as input are a separate decision for later.
- **Sound files are cues.** A cue with `file` instead of `generator` plays `media/<name>` from `start` to `end` in scene seconds, snapped to frames like every cue, starting `in` seconds into the file (any sample, so a trim can be finer than a frame), with optional `fadeIn` and `fadeOut` in seconds and volume keys. A placed shot brings its files with its sound, as it already brings its generators.
- **One render, as before.** The hosts (the viewer, the render worker, the HTML player) decode the files the scene uses, resampled to 48 kHz, and hand them to `renderSceneAudio`, which copies the samples into the scene's one buffer. Decoding is deterministic for a given Chromium, like the rest of the pixels and samples.
- **The studio server keeps the files.** `media/` holds them; the server lists them, serves them to its pages, takes uploads from the viewer, and copies a file from disk into it (`import_media`). The viewer imports by picker or drop and places a file at the playhead.
- **The HTML export leaves sound files out by default** and says so. On request it inlines them, as base64 of the file as it is, which keeps the export one file and makes it as big as its sound. MP4 carries them always; GIF has no sound.
- **The timeline becomes a simple editor next** (M13): tracks for shots and sound, move, trim, split, duplicate, fades and transition presets, undo, and a lock while an agent works on the scene. Speed changes (slow motion, freeze, reverse) wait.
- **Stills export** (PNG, JPG) follows (M14).

## Consequences

- The runtime rule against blobs gives way in one place: an HTML export asked to carry its sound files. Rigs still never load media, and the picture is still code.
- A scene can depend on files outside its JSON. Moving a scene to another studio folder means moving its media too; a missing file is an error in the viewer and the tools, and its cue is silent.
- Agents can't hear. They see each file's length and can place cues by time; lining a voiceover up with the picture is the user's job in the timeline, until something like local transcription gives word timings.
- Media files can be large. Uploads stream to disk; the viewer decodes the files the scene on screen uses.
