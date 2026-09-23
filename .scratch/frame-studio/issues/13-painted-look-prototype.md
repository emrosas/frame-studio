# How far can drawing code push a painted look?

Type: prototype
Status: resolved
Blocked by: none

## Question

Can procedural canvas drawing get close to a gouache or watercolour illustration, with dry-brush streaks, rough edges, and pigment texture? The reference is a still of four stacked bears on an orange ground, kept at `references/bears-reference.png`. Build one frame of it in three techniques (gouache dry-brush, watercolour, oil pastel), compare them against the reference, and combine the best parts into one `bears` scene. Record what each technique costs per frame, so the first character's look in ticket 05 builds on what the renderer can do.

## Answer

Far enough to build on. Three studies painted one 1080x1920 frame of the reference. A judge ranked gouache first (likeness 7, paint feel 6, charm 7 out of 10), then oil pastel, then watercolour. Gouache matched the reference's flat opaque colours, and its bristle streaks and light scratches read as paint. It was also the cheapest at about 155 ms a frame in headless Chromium. Pastel and watercolour each took about 230 ms. The combined `bear` rig in `src/rigs/bear.ts` keeps the gouache technique, with the brush helpers in `src/rigs/parts/paint.ts`, and `scenes/bears.json` stacks four of them. The user liked the result on 2026-09-23, so the painted bear becomes the first character (ticket 05).

The studies stay under `src/rigs/studies/` with their scenes. The plan was to delete them once the bear settled, but on 2026-09-23 the user chose to keep them as material for testing the iteration modal and scoped edits.
