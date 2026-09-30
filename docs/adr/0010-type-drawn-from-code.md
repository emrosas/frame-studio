# 0010: Type is drawn from typefaces compiled to code

Status: accepted, 2026-09-30.

## Context

Explainers and social posts need real typography: several typefaces, weights, kerning, wrapping and alignment. The runtime rules forbid font files, images and base64 blobs (CLAUDE.md), and allow text drawn as vector paths in code or in generic system families. System families look different on every machine, so a scene would stop being a pure function of its data: the HTML embed would show whatever fonts the viewer has, and `measureText` would wrap lines differently on another computer.

## Decision

- **A typeface is a code module.** `npm run typeface` (a dev tool, `tools/type/`) reads a font file with fontkit and writes a TypeScript module of plain data: each glyph's advance and outline as path commands in font units, the pair kerning for the characters it keeps, and the vertical metrics. The module has no runtime imports. A variable font is fixed at one instance per module, such as Inter at weight 700.
- **Latin only, for now.** A module keeps ASCII, Latin-1, Latin Extended-A and common punctuation (curly quotes, dashes, ellipsis, bullet, euro). A character outside it draws the font's missing-glyph box. No ligatures and no shaping, so scripts that need shaping (Arabic, Devanagari) are out of scope.
- **Layout is ours.** `src/rigs/type/layout.ts` lays text out from the module alone: advances, kerning, tracking, line breaks at spaces and explicit newlines, a wrap width, alignment and line height with CSS-like half-leading. It never calls `measureText` or sets `ctx.font`, so a line breaks in the same place on every machine and in every export.
- **The `text` rig** draws a layout: text, font, size, anchor and alignment, wrap width, line height, tracking, case, fill, outline, opacity, rotation, scale, and `reveal` for typing it on. Other rigs can draw text with the same `drawText` from `@frame-studio/rigs/type/layout`.
- **Built-in typefaces** come from fonts under the SIL Open Font License 1.1 with no Reserved Font Name, so converting and subsetting them is allowed. Each module carries its copyright and license line, and `src/rigs/type/faces/OFL.txt` has the license. The first set: Inter (regular, bold, display black), Instrument Serif (regular, italic), Fraunces (semibold) and JetBrains Mono (regular). `tools/type/builtins.ts` records where each came from and the instance, and regenerates them.
- **The embed carries only what it draws.** When the HTML export bundles the `text` rig, it swaps the typeface index for one holding only the typefaces the scene names, plus the default, each cut to the characters in the scene's strings. A rig of the folder's that imports the typefaces itself turns this off, since its text is in code the bundler doesn't read. The embed keeps each typeface's copyright and license line.

## Consequences

- Text renders identically in the viewer, the render worker, exports and the embed, and a still re-renders the same years later.
- Each typeface costs its outline data: tens of kilobytes of code per weight in the viewer, and in an embed only the glyphs used.
- Adding a typeface is a dev step for now: run the converter on an open-licensed font and add the module to the index. Typefaces in a studio folder, converted by the app from a font file the user owns, are the next step; they raise licensing questions a built-in doesn't.
- No hinting, so small text at low resolution is softer than a browser's. Posts and explainers use large type, where it doesn't show.
