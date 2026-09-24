# M7: Procedural audio

Type: task
Status: resolved
Blocked by: 04, 11

## Work

Build milestone M7 as written in `docs/ROADMAP.md`, using the findings from ticket 04 and the audio section of ticket 14. Encode AAC-LC at 48 kHz and 128 kbps through `AudioEncoder`, and fall back to Opus where there is no AAC encoder. Signal the AAC priming samples with an edit list and a `roll` sample group, or the audio plays 44 ms late in ffmpeg and Chromium. Mediabunny does not write the roll group.

## Answer

M7 is done and its acceptance criteria pass. `docs/PROGRESS.md` records how each was checked, and ADR 0005 records the design.

- Three generators, `pad`, `buzz` and `blip`, in `src/audio`. Cues snap to frames, sound renders at 48 kHz, scenes with audio need an fps that divides 48000, and no input gets more than two connections.
- The whole scene renders once through `OfflineAudioContext`. The viewer and the embed play that buffer in step with the clock, and exports encode it.
- MP4 audio is AAC through `AudioEncoder`, or Opus where there is no AAC encoder. `src/export/audio-track.ts` adds the AAC `roll` group and trims the audio to the video's length inside Mediabunny's reserved moov space. Blips land within 7 samples of their frames in ffmpeg and AVFoundation.
- The embed bundles only the generators a scene uses, starts muted, and plays after a click on its speaker button. Silent embeds carry no audio code.
- MCP gains `list_generators`, and `export` takes `silent`.

