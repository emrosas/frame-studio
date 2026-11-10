# Text contrast against what's behind it

Type: task
Status: resolved
Blocked by: 02

## Work

`text-contrast`: the contrast ratio (WCAG 2.x relative luminance) between a text layer's fill and the pixels behind its glyphs, at its worst moment.

How: the render worker draws the frame without that text layer, at check size, and reads the pixels inside the text's line boxes. The fill colour comes from the layer's params, mixed over each background pixel at the layer's opacity. Each background pixel is the mean of its 3x3 neighbourhood, and the text is measured at its 10th-percentile pixel, so a few stray background pixels don't decide it and a bright patch behind a tenth of the words still does. An outline at least 2 output pixels wide (and 1/20 of the em) sits between fill and background, so the ratio is the better of fill against background and fill against outline. Captions are measured for their colour and their highlight colour.

Thresholds: 4.5:1, and 3:1 for large text (WCAG 1.4.3; 1.4.11 asks 3:1 of graphics). WCAG calls 24 CSS px large. A video has no CSS pixels, so large here is an em of at least 1/30 of the frame's short side: 24 px on a 720 px tall player. Under 3:1 is P1, between 3:1 and 4.5:1 for small text P2. Frames sampled: every half second of each readable appearance, plus its first frame.

## Acceptance criteria

- [x] The ratio and the percentile are arithmetic in `src/export/text-check.ts`, unit tested on synthetic pixels: plain ground, translucent fill, outline, busy ground.
- [x] The report names the layer, the ratio, the threshold, and the frame of the worst moment.
- [x] Compositions work: the layer is removed from the scene its clip places.
- [x] A browser test checks a pale title on paper and a clear one through the real worker.

## Answer

Built as specified, plus one change: each background pixel is the mean of its 3x3 neighbourhood at check size before the ratio, so grain a pixel wide reads as its mean. Colours resolve in the worker by painting a pixel, so any CSS colour works. A layer is removed from the scene its clip places, so two clips of one scene on screen at once both lose it; acceptable for a check.

Over the repo, `type-test` gets two P2 findings: the kicker (`#d4410a`, 30 px) at 3.4:1, and the missing-glyph line (`#6f6a63`, 28 px) at 3.8:1. Both sit in corners where the paper's vignette and mottling darken the ground below its base tone; against the flat tone they'd be about 4.0:1 and 4.6:1. Both are small text, so 4.5:1 applies. Real findings, left in.
