# What is the first character, and what does it need to do?

Type: grilling
Status: resolved
Blocked by: 13

## Question

M2 needs one character rig built from reusable parts, with a few poses, one expression param, and one variant used through an override. The roadmap's sample scene uses a fly with a `fly.wingTorn` variant.

Is the fly the right first character? Which poses, which expression, and which variant? What should the drawing code aim for in line weight, fills, and hand-drawn wobble, so later characters can reuse its parts?

## Answer

The first character is the painted gouache bear from ticket 13, not the fly. The user liked the bears on 2026-09-23 and asked to keep building, so these defaults were chosen without a grilling session. Any of them can change later.

- **Parts.** `ears`, `body`, `paws`, `muzzle`, `nose`, `eyes`, `mouth`. Every mark sits inside one part, and each part draws from its own RNG fork. Drawing any subset of parts then gives the same marks as the full draw, which hit testing and selection masks rely on.
- **Limbs and poses.** Two stubby paws in the same paint. `pose` is `idle` (paws low), `wave` (one paw up, waving on a cycle), `cheer` (both paws up) or `shy` (paws over the muzzle).
- **Expression.** `expression` is `neutral`, `happy`, `sad` or `surprised`. It moves the brows, mouth and eyes.
- **Cycles.** Blinks follow a seeded schedule worked out in closed form from `t`. An idle breath bob runs on `t` with a seeded phase.
- **Variant.** `bear.bandaged` adds a sticking plaster across the head. It reuses every base part unchanged and accepts every base param.
- **Look.** Opaque gouache as in `scenes/bears.json`: ragged bristle edges, dry-brush streaks along the body, light scratches, washed shadows, and thin ink lines for the brows and mouth. Every length is a fraction of `width`.
