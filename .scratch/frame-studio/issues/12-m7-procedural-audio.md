# M7: Procedural audio

Type: task
Status: open
Blocked by: 04, 11

## Work

Build milestone M7 as written in `docs/ROADMAP.md`, using the findings from ticket 04 and the audio section of ticket 14. Encode AAC-LC at 48 kHz and 128 kbps through `AudioEncoder`, and fall back to Opus where there is no AAC encoder. Signal the AAC priming samples with an edit list and a `roll` sample group, or the audio plays 44 ms late in ffmpeg and Chromium. Mediabunny does not write the roll group.
