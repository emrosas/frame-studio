# 0016: A voice's words live on its cue, and animation can follow them

Status: accepted, 2026-11-06. Changes ADR 0015's "values stay the agent's": a word's text and timing are hand-editable. Answers ADR 0012's "lining a voiceover up with the picture is the user's job, until something like local transcription gives word timings".

## Context

A short needs captions in step with the voice, and the picture should follow it too: "when I say freezes, lock the crystal". Agents can't hear. Until now they placed a cue by its length and guessed, and a person lined things up by eye, in English and in Spanish, and again after every re-record.

We tried word timing on the samples in both languages. whisper.cpp's small model lands every word within 150 ms of faster-whisper's. It's MIT, it's one binary, it needs no Python, and it runs offline once the model is here. It also hears "Porque" where the script says "¿Por qué" often enough that a known script has to win over what it heard.

## Decision

- **The cue owns its words.** `AudioCue` gains `words: [{ id, text, start, end, p? }]`, `script?` and `lang?`. Times are seconds into the file, so moving or trimming the cue carries them. They live in the scene file, so a frame is still a pure function of the scene. What Whisper said is a disposable cache at `media/<file>.words.json`, keyed by the file's sha256, and the renderer never reads it.
- **`kit.speech(cueId)` gives a rig its words in scene time**, shifted and trimmed the way the cue plays, from the frame the sound starts on. A word the trim cuts through stops at the cut.
- **A captions rig**: `captions`, with styles `word-highlight`, `pop-in` and `line`. Vector text from `src/rigs/type/layout.ts`, or the pixel font on a pixel stage. It sits inside the safe area by default, in the numbers the viewer's guide draws (`src/engine/safe-area.ts`), centred on the stage. The pixel font gains Á É Í Ó Ú Ñ Ü ¿ ¡.
- **The timing job.** `whisper-cli` at a pinned version, with `-dtw small -nfa` for each token's end. A word starts where the last one ended, and only after punctuation do a token's own offsets say there was a gap; elsewhere they wander. The model, small q5, about 190 MB and sha256-pinned, downloads on first use to `~/.frame-studio/models/`, after a card asks. No ffmpeg: the render worker decodes to 16 kHz mono. `npm run voice:setup` builds the binary for the repo, and `tools/desktop/package.ts` builds it into the app. Language comes from `cue.lang`, else `project.json`'s `lang`, else detection.
- **With a script, words and punctuation come from the script and timing from Whisper.** The two line up letter by letter, so a heard "Porque" splits into "¿Por" and "qué". A script word with too little lined up shares out the time around it, with `p: 0`.
- **A key or marker can name a word**: `{ t, word: "voice#w12" }`. A pure pass, `anchorWords`, overwrites `t` from the word. It runs in the library, the one door every host gets a scene through, so the viewer, the worker, the embed and the tools can't disagree. The file's `t` is only the last time known.
- **Re-recording keeps anchors.** New words match old ones by text, in order, and matches keep their ids, so anchored keys follow. An anchor whose word went, or was trimmed off, is an orphan: it keeps its last `t`, and the check tool reports it. An orphan is not a validation error, since a re-record can't be allowed to break a scene.
- **A voice row on the timeline.** A cue with words shows its waveform and a chip per word. Click for the playhead, drag across words for a range, double-click to fix the text, drag an edge to retime, right-click to anchor the selected key or marker. A word that touches its neighbour shares that edge, because timing leaves no gap between most words, and a drag stops a frame short of the neighbour's far side.
- **Hand edits to words go the way of ADR 0015**: the same checked edit, the same lock, the same undo stack, with a cue's words and the markers as targets beside the layers. Dragging an anchored key detaches it, and the diamond shows that: anchored is hollow.
- **The check tool reads words**: `word-sync`, `word-orphans`, `caption-speed` (20 characters a second in English, 17 in Spanish, the usual subtitling ceilings) and `caption-safe`. A sync marker on a word is tested against the word, not against sound onsets, since a word in mid sentence starts no new sound.
- **The HTML export keeps captions when it leaves sound out.** A dropped cue's words stay behind as `spoken`, and captions count as text for the glyph cut.

## Refused

Python, a shipped ffmpeg, a cloud speech API, and reading the cache at render time. The picture must not depend on a file the export doesn't carry.

## Consequences

- A scene file grows by a line or so per word. Agents read that in `get_scene`, which is the point.
- `t` in a file can be stale. Anything that reads a scene's keys must come through the library. `get_scene` shows the file as it is.
- A rig that reads `kit.speech` draws nothing in a host that gives it no words. The engine's stub kits return none, so a rig's own tests need words of their own.
- Timing depends on a binary. A folder rendered on a machine without one still renders: words are data. Only timing needs it.
- A stage's safe-area numbers now live in the engine, and the viewer's guide imports them.
