# Check: text and ranks

Status: resolved

## Why

`check` (ADR 0014) measures the picture as a whole: black, freezes, flashing, sound. It says nothing about the words on screen, which is what an explainer lives on. An agent can't watch the film, so it can't tell a title is cut off by the frame edge, hidden under TikTok's buttons, gone before anyone could read it, or pale grey on paper.

It also reports everything as `pass`, `warn` or `fail`, and a warning about a partial last frame reads the same as a warning about a static opening. People and agents need to know what to fix first.

## What we have that others don't

Text here is data. The `text` rig and `captions` lay out vector glyphs from typeface modules (ADR 0010, ADR 0016), the same layout on every machine. So the boxes of every glyph on a frame come from the scene by arithmetic: no OCR and no guessing from pixels. Only contrast needs pixels, and only for what's behind the text.

## Decisions

- **Ranks.** Every result gets `rank`: `P0` breaks the piece (an export fails, seizure risk, nothing on screen), `P1` makes an audience stop watching or miss something, `P2` costs attention, `P3` is polish. `status` stays as it was, so `ok` and old readers don't change. The rank says how much a result matters when it doesn't pass; a pass keeps its rule's rank so the list sorts the same way every time. Reports list findings by rank, then failures before warnings, then passes.
- **Text marks.** A tooling module (`src/export/text-marks.ts`) walks a scene at a frame the way `render()` does: clips with their placement and opacity, the camera, the pixel stage. For each `text` and `captions` layer it records the glyph ink boxes in output pixels, what text is shown, whether all of it is shown, its opacity and its colours. The text rig's own layout and placement come from one function both the rig and the check call, so they can't drift. `src/engine` gets no check code and the runtime gains no dependency.
- **Only built-in type rigs.** A studio rig that calls `drawText` itself isn't measured. Reaching it would need a hook in the runtime path, and nothing in the repo needs it yet.
- **Thresholds from public standards**, each in its ticket: WCAG 1.4.3 and 1.4.11 for contrast, the platform zones already in `src/engine/safe-area.ts` for safe areas, and a reading rate for time on screen.

## Tickets

1. `01-ranks.md`
2. `02-text-in-frame-and-safe-zones.md`
3. `03-reading-time.md`
4. `04-text-contrast.md`

## Out of scope

Text drawn by studio rigs or the pixel font in `pixel-text`. Bold weights counting as large text earlier, as WCAG allows. Contrast against an outline that's too thin to see at the output size is treated as no outline.
