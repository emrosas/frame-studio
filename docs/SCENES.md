# Writing scenes

A scene is one JSON file in `scenes/` at the repo root, named after its id: `scenes/shapes-test.json` holds the scene with `"id": "shapes-test"`. The viewer picks up every file in that folder. `scenes/hello.json` is the smallest working scene and a good one to copy. Give the copy its own id. While two files share an id, the file named after the id keeps it and the other file shows as invalid.

The image at any frame depends only on the scene file and the frame number. Nothing carries over from the previous frame, so a scene renders the same whether you play to frame 40 or jump straight to it.

## Scene fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique name. Match the file name. |
| `fps` | positive integer | Output frame rate. |
| `duration` | number of seconds, above 0 | The scene has `ceil(duration * fps)` frames, numbered from 0. It must give at least one frame. |
| `size` | `[width, height]`, positive integers | Stage size in scene pixels. Rigs draw in these units. |
| `seed` | integer | Seeds every random choice. Change it to get new grain and wobble with the same motion. |
| `background` | layer without `id` | Optional. Drawn first, behind every layer. Its id is always `background`, so leave `id` out. |
| `layers` | array of layers | Drawn in array order, so index 0 is at the back. |
| `audio` | array of audio cues | Optional. The scene's sound; see [Sound](#sound). |

Any field not listed here is an error. The same goes for layers, tracks, keys and overrides, so a typo such as `stepfps` or `easing` fails validation with a hint instead of being ignored.

## Layers

| Field | Meaning |
| --- | --- |
| `id` | Unique within the scene. `background` is taken, and `/` is not allowed. |
| `rig` | Which rig draws this layer, for example `circle`. |
| `params` | Fixed param values. Anything you leave out uses the rig default. |
| `tracks` | Animated params, see below. |
| `stepFps` | Optional. Holds the layer's time on a slower clock, see below. |
| `overrides` | Optional. Frame ranges where the layer changes rig or params, see below. |

For each frame the engine builds a layer's params in this order, and later entries win:

1. rig defaults
2. `params`
3. track values at the layer's time
4. the active override's `params`

## Tracks and easing

A track animates one param with keys. Key times `t` are in seconds and must strictly increase.

```json
{ "param": "x", "keys": [ { "t": 0, "v": 240 }, { "t": 3, "v": 1680, "ease": "inOutSine" } ] }
```

Before the first key the param holds the first value, and after the last key it holds the last value. Between two number keys the value blends from one to the next. The `ease` on a key shapes the stretch of time arriving at that key, and it defaults to `linear`. String and boolean values never blend. They hold until the next key, which is how you step a colour or a pose.

Easing names are `linear`, `inQuad`, `outQuad`, `inOutQuad`, `inCubic`, `outCubic`, `inOutCubic`, `inQuart`, `outQuart`, `inOutQuart`, `inSine`, `outSine`, `inOutSine`, `inExpo`, `outExpo`, `inOutExpo`, `inBack`, `outBack` and `inOutBack`.

`in` starts slow, `out` ends slow, and `inOut` does both. `inBack` first pulls back behind the start value, then moves to the target without passing it. `outBack` overshoots the target and settles back. `inOutBack` does both. Rigs clamp every number to its range, so an overshoot can push a radius to 0 but never below it.

## Held frames with stepFps

Without `stepFps` a layer moves on every output frame. With `stepFps` its time snaps down to steps of `1 / stepFps` seconds, so in a 12 fps scene a layer with `"stepFps": 6` holds each drawing for two frames. This is animating "on twos". Tracks are read at the held time, so position, colour and wobble all hold together. `stepFps` must be above 0 and at most the scene `fps`.

## Overrides

An override changes a layer over a range of output frames. This one turns a shape pink and wobbly for one second of a 12 fps scene:

```json
"overrides": [ { "from": 36, "to": 48, "params": { "fill": "#e0457b", "wobble": 10 } } ]
```

Ranges are `[from, to)`, so frame 36 is inside and frame 48 is not. `from` and `to` are whole frame numbers with `0 <= from < to <= frame count`. Overrides count output frames, so `stepFps` does not shift them. Override params beat both `params` and tracks.

An override may also set `rig` to swap the rig for its range. This is how rig variants such as `fly.wingTorn` will be used. The override's params must then exist on the new rig.

Two overrides on the same layer must not overlap. `[24, 36)` and `[36, 48)` are fine because they only touch.

## Coordinates

Positions are in scene pixels with the origin at the top-left corner of the stage. x grows to the right and y grows downward, so a rising sun has a falling `y`. Rotation is in degrees, clockwise on screen.

Shapes are placed by their centre. The default `x` and `y` of 960 and 540 are the centre of a 1920 by 1080 stage, so set both on any other stage size. A full-width ground strip 200 pixels tall on a 1920 by 1080 stage is a `rect` with `width` 1920, `height` 200, `x` 960 and `y` 980. Set its `stroke` to `none`, or the default outline draws along the stage edges.

## Rigs

Colours accept hex codes with 3, 4, 6 or 8 digits, CSS named colours such as `tomato`, `transparent`, and CSS colour functions such as `rgb()`, `hsl()`, `oklch()`, `color()` or `color-mix()`. Case does not matter. `fill` and `stroke` also take `none`, which skips that paint. The validator rejects any other colour, because a canvas paints a colour it cannot read as black. Every number is clamped to the range shown.

### paper

Background paper. It fills the whole stage with `tone`, then adds seeded grain, fibres, soft patches and a vignette so the page does not look flat. The texture depends only on the scene seed and the layer id, so it holds still from frame to frame.

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `tone` | colour | `#f4efe6` | | Base paper colour. |
| `grain` | number | 0.5 | 0 to 1 | Density of fine specks. |
| `fibres` | number | 0.5 | 0 to 1 | Density of short curved fibres. |
| `mottle` | number | 0.5 | 0 to 1 | Strength of large soft light and dark patches. |
| `vignette` | number | 0.3 | 0 to 1 | Darkening toward the edges. |
| `boil` | boolean | false | | When true the texture re-rolls each time the layer time changes. Pair it with `stepFps`. |

### Shared shape params

`circle`, `rect` and `star` all take these, plus the shape params listed under each rig.

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `x` | number | 960 | -10000 to 10000 | Centre x in scene pixels. |
| `y` | number | 540 | -10000 to 10000 | Centre y in scene pixels. |
| `scale` | number | 1 | 0 to 20 | Uniform scale about the centre. Outline width and wobble scale too. |
| `rotation` | number | 0 | -36000 to 36000 | Degrees, clockwise on screen. |
| `fill` | colour | per rig | | Fill colour. `none` skips the fill. |
| `stroke` | colour | `#2b2b2b` | | Outline colour. `none` skips the outline. |
| `strokeWidth` | number | 6 | 0 to 100 | Outline width at scale 1. 0 skips the outline. |
| `opacity` | number | 1 | 0 to 1 | Opacity of the whole shape. |
| `wobble` | number | 0 | 0 to 50 | Hand-drawn boil. How far the outline bulges in and out, in pixels at scale 1. 0 is a clean shape. Try 2 to 4 for a drawn line and 10 for an obvious wobble. |

The wobble pattern is seeded by the layer id and the layer's time. It redraws only when the layer time changes, so `stepFps` sets how fast a shape boils, and replaying a frame gives the same outline.

### circle

Default fill `#e05a4f`.

| Param | Default | Range | Meaning |
| --- | --- | --- | --- |
| `radius` | 80 | 0 to 5000 | Radius at scale 1. |

### rect

Default fill `#e8b04b`. The rectangle is centred on `(x, y)` and turns about its centre.

| Param | Default | Range | Meaning |
| --- | --- | --- | --- |
| `width` | 200 | 0 to 10000 | Width at scale 1. |
| `height` | 140 | 0 to 10000 | Height at scale 1. |
| `cornerRadius` | 0 | 0 to 5000 | Corner radius at scale 1, capped at half the shorter side. |

### star

Default fill `#f2b134`. The first tip points straight up.

| Param | Default | Range | Meaning |
| --- | --- | --- | --- |
| `points` | 5 | 3 to 24 | Number of tips. Rounded to a whole number, so a track on it steps. |
| `outerRadius` | 110 | 0 to 5000 | Centre to tip, at scale 1. |
| `innerRadius` | 48 | 0 to 5000 | Centre to the notch between tips, at scale 1. |

### bear

A tall tombstone-shaped bear painted to look like gouache. It has rounded head corners, a body that runs off the bottom of the stage, round or oval ears, dot eyes or small eye whites with a pupil, brow dashes, a pale muzzle, a glossy black nose and a line smile. `scenes/bears.json` stacks four of them.

Every length is a fraction of `width`, so changing `width` resizes the bear and keeps its proportions. `x` and `y` place the top centre of the head, and `tilt` turns the whole bear about that point. The ears and the shade patch sit in the body's frame, which turns with `tilt`. The face has a frame of its own. `faceX` and `faceY` place the nose centre, `faceTilt` turns the face about it, and the muzzle, eyes and mouth are placed relative to the nose.

The body is an opaque fill with a ragged bristle edge. Dry-brush streaks follow the lean of each side and bunch toward the edges. Thin tapered scratches come in small groups, crowd the edges and the lower part of the stage, and stay off the face. The nose bridge, chin shadow, shade patch and cast shadows are soft layered washes.

The cast shadow multiplies onto whatever the earlier layers painted, so list a bear after the bears it shades. With `fringe` above 0 the solid paint stops short of one side edge and broken bristle lines fill the gap, so the ground or the bear behind shows through.

The bear declares seven parts: `ears`, `body`, `paws`, `muzzle`, `nose`, `eyes` and `mouth`. `body` holds the cast shadow, the body paint and its shading (bridge, chin shadow, shade patch, rim). Clicking a bear in the viewer can pick out one part, and each part follows the rig rules under "Writing a rig".

Four params animate the bear, and none of them touches the ears, body, muzzle or nose, so the character stays the same from frame to frame.

- `pose` places the two paws. `idle` rests them low on the body front. `wave` raises the `wavePaw` paw beside the face and swings it `waveSpeed` times a second from a phase seeded by the layer. `cheer` puts both paws up and out past the ears. `shy` holds both paws over the muzzle and cheeks, below the eyes. The paws are painted like the body, in the body colour, with a thin `rimColor` line where a paw sits over the body.
- `expression` is `neutral`, `happy`, `sad` or `surprised`. Each one offsets the face params the bear already has (brow height and tilt, smile depth and width, eye size, where the pupils look), so per-bear tuning still shows. `neutral` changes nothing, and `surprised` hangs a small open mouth from the mouth line.
- Blinks come from a schedule seeded by the layer and worked out from `t` alone, so seeking gives the same eyes as playing. A blink lasts 0.1 to 0.2 s, and a shut eye is a short curved ink line. The eyes are always open at `t = 0`. `blink` closes the eyes by hand, part way or fully, on top of the schedule.
- `breath` bobs the whole bear up and down on a 2.8 to 3.6 s cycle with a seeded phase.

A bear whose body is laid out for the stage (`bodyLength` 0) repaints its body marks when it moves. Give a bear that moves or breathes a `bodyLength` long enough to leave the stage, for example 2, and its marks stay put on the body. `scenes/bears.json` sets `pawSize` and `breath` to 0 on every bear, which keeps the approved still exactly as it was before the paws and cycles existed. A test pins its frame 0 draw log.

**Body**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `x` | number | 540 | -10000 to 10000 | Scene x of the top centre of the head. |
| `y` | number | 700 | -10000 to 10000 | Scene y of the top of the head. The body runs from here off the bottom of the stage. |
| `width` | number | 440 | 40 to 3000 | Head width in scene pixels. Every other length is a fraction of this, so it scales the whole bear. |
| `tilt` | number | -5 | -45 to 45 | Tilt of the whole bear in degrees, clockwise, about the top centre of the head. |
| `flareLeft` | number | 0.15 | 0 to 0.8 | How fast the left side widens going down, in pixels out per pixel down. |
| `flareRight` | number | 0.15 | 0 to 0.8 | How fast the right side widens going down, in pixels out per pixel down. |
| `corner` | number | 0.24 | 0.02 to 0.5 | Width of each rounded top corner, as a fraction of width. |
| `shoulderLeft` | number | 1 | 0.1 to 5 | Height of the left top corner as a multiple of its width. Above 1 the side curves in over a longer run. |
| `shoulderRight` | number | 1 | 0.1 to 5 | Height of the right top corner as a multiple of its width. |
| `dome` | number | 0.02 | -0.1 to 0.2 | How much the top edge bulges up in the middle, as a fraction of width. |
| `bodyLength` | number | 0 | 0 to 8 | Body length below the top of the head, as a multiple of width. 0 runs the body just past the bottom of the stage and lays its paint out for that spot, which suits a still. Set it long enough to leave the stage (for example 2) on a bear that moves or breathes. |

**Ears**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `earSize` | number | 0.1 | 0 to 0.3 | Ear radius, as a fraction of width. |
| `earLeftX` | number | -0.46 | -1 to 1 | Left ear centre x in the body frame, as a fraction of width. |
| `earLeftY` | number | 0 | -0.5 to 0.5 | Left ear centre y below the top edge, as a fraction of width. Negative is up. |
| `earRightX` | number | 0.46 | -1 to 1 | Right ear centre x in the body frame, as a fraction of width. |
| `earRightY` | number | 0 | -0.5 to 0.5 | Right ear centre y below the top edge, as a fraction of width. |
| `earLeftAspect` | number | 1 | 0.5 to 2 | Left ear height over its width. 1 is round, above 1 an upright oval. |
| `earRightAspect` | number | 1 | 0.5 to 2 | Right ear height over its width. |
| `earLean` | number | 0 | -45 to 45 | How far the tall axis of an oval ear leans outward, in degrees. |
| `innerEarSize` | number | 0.6 | 0 to 1 | Size of the inner-ear patch as a fraction of the ear radius. 0 hides it. |

**Face placement**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `faceX` | number | 0 | -0.5 to 0.5 | Nose centre x in the body frame, as a fraction of width. Moves the whole face. |
| `faceY` | number | 0.35 | 0 to 1.2 | Nose centre y below the top edge, as a fraction of width. |
| `faceTilt` | number | 0 | -45 to 45 | Extra turn of the face about the nose, in degrees clockwise. |

**Nose**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `noseWidth` | number | 0.3 | 0 to 0.8 | Nose width, as a fraction of width. |
| `noseHeight` | number | 0.2 | 0 to 0.6 | Nose height, as a fraction of width. |
| `noseTaper` | number | -0.25 | -0.8 to 0.8 | Nose shape. Below 0 narrows the bottom for a bulbous, rounded-trapezoid nose. |
| `glint` | number | 1 | 0 to 1 | Size of the white highlight on the nose, 0 to 1. |

**Muzzle**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `muzzleX` | number | 0 | -0.5 to 0.5 | Muzzle centre x relative to the nose centre, as a fraction of width. |
| `muzzleY` | number | 0.2 | -0.5 to 1 | Muzzle centre y relative to the nose centre, as a fraction of width. |
| `muzzleWidth` | number | 0.36 | 0 to 1 | Muzzle width, as a fraction of width. |
| `muzzleHeight` | number | 0.42 | 0 to 1.2 | Muzzle height, as a fraction of width. |
| `muzzleTaper` | number | 0.15 | -0.8 to 0.8 | Above 0 narrows the top of the muzzle toward the nose bridge. |
| `muzzleSquare` | number | 2.4 | 2 to 6 | Muzzle squareness: 2 is an oval, higher is boxier. |

**Eyes and brows**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `eyeX` | number | 0 | -0.5 to 0.5 | Eye pair centre x relative to the nose centre, as a fraction of width. |
| `eyeY` | number | -0.13 | -0.8 to 0.5 | Eye pair centre y relative to the nose centre, as a fraction of width. Negative is above. |
| `eyeSpacing` | number | 0.38 | 0 to 1 | Distance between the eye centres, as a fraction of width. |
| `eyeSize` | number | 0.022 | 0.004 to 0.08 | Pupil radius, as a fraction of width. |
| `eyeWhite` | number | 1.7 | 0 to 3 | Eye-white radius as a multiple of the pupil radius. Below about 1.05 the eye is a plain dot. |
| `lookX` | number | 0.6 | -1 to 1 | Where the pupils look inside the eye whites, -1 left to 1 right. |
| `lookY` | number | -0.2 | -1 to 1 | Where the pupils look inside the eye whites, -1 up to 1 down. |
| `browY` | number | -0.07 | -0.3 to 0.3 | Brow height relative to each eye, as a fraction of width. Negative is above. |
| `browOut` | number | 0.01 | -0.2 to 0.2 | Shifts each brow away from the nose, as a fraction of width. |
| `browLength` | number | 0.09 | 0 to 0.3 | Brow length, as a fraction of width. |
| `browTilt` | number | 12 | -60 to 60 | Brow slant in degrees. Above 0 lifts the inner ends for a soft, worried look. |

**Mouth**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `mouthX` | number | 0 | -0.2 to 0.2 | Sideways lean of the mouth line where it meets the smile, as a fraction of width. |
| `mouthDrop` | number | 0.17 | 0 to 0.6 | Length of the line from the bottom of the nose to the bottom of the smile, as a fraction of width. |
| `smileWidth` | number | 0.18 | 0 to 0.6 | Width of the smile, as a fraction of width. |
| `smileDepth` | number | 0.045 | -0.15 to 0.15 | How far the smile dips below its ends, as a fraction of width. Negative frowns. |
| `lineWeight` | number | 0.011 | 0.002 to 0.04 | Thickness of the mouth line, as a fraction of width. Brows are 1.6 times heavier. |

**Shading**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `bridge` | number | 0.8 | 0 to 1 | Strength of the darker wedge down the nose bridge, 0 to 1. |
| `bridgeTop` | number | 0.24 | 0 to 0.8 | How far above the nose centre the bridge wedge starts, as a fraction of width. |
| `bridgeWidth` | number | 0.14 | 0 to 0.6 | Width of the rounded top of the bridge wedge, as a fraction of width. |
| `chin` | number | 0.5 | 0 to 1 | Strength of the soft shadow under the muzzle, 0 to 1. |
| `chinX` | number | -0.03 | -0.5 to 0.5 | Chin shadow offset x from the muzzle centre, as a fraction of width. |
| `chinY` | number | 0.07 | -0.5 to 0.5 | Chin shadow offset y from the muzzle centre, as a fraction of width. |
| `chinSize` | number | 1.05 | 0 to 2 | Chin shadow size as a multiple of the muzzle size. |
| `patch` | number | 0 | 0 to 1 | Strength of a soft shade patch on the body, for example where another bear overlaps. 0 hides it. |
| `patchX` | number | 0 | -1 to 1 | Shade patch centre x in the body frame, as a fraction of width. |
| `patchY` | number | 1.2 | -0.5 to 4 | Shade patch centre y below the top edge, as a fraction of width. |
| `patchWidth` | number | 0.2 | 0 to 1.5 | Shade patch width, as a fraction of width. |
| `patchHeight` | number | 0.3 | 0 to 3 | Shade patch height, as a fraction of width. |
| `castLeft` | number | 0 | 0 to 1 | Strength of the shadow this bear casts on whatever is left of it, 0 to 1. |
| `castRight` | number | 0 | 0 to 1 | Strength of the shadow this bear casts on whatever is right of it, 0 to 1. |
| `castTop` | number | 0.1 | 0 to 1 | Reach of the cast shadow just below the head corners, as a fraction of width. |
| `castWidth` | number | 0.4 | 0 to 1.5 | Reach of the cast shadow where the body leaves the stage, as a fraction of width. |
| `rim` | number | 0.6 | 0 to 1 | Strength of the thin darker line just inside the top of the head, 0 to 1. |
| `earRim` | number | 0.6 | 0 to 1 | Strength of the thin line just inside each ear, 0 to 1. |

**Colours**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `body` | colour | `#f14922` | | Body paint colour. |
| `shade` | colour | `#d6391a` | | Darker body tone for the nose bridge, chin shadow and darker streaks. |
| `rimColor` | colour | `#c8321a` | | Colour of the thin line inside the ears and the top of the head. |
| `innerEar` | colour | `#f98262` | | Colour of the scribbled loops inside the ears. A faint wash of it, half mixed with the body, goes under them. |
| `patchColor` | colour | `#c9d0e6` | | Shade patch colour. |
| `muzzle` | colour | `#ffffff` | | Muzzle paint colour. |
| `muzzleShade` | colour | `#c9cedd` | | Cool colour worked into the muzzle rim and chin. |
| `scratch` | colour | `#ffffff` | | Colour the light scratches mix toward. |
| `ink` | colour | `#0e0c0d` | | Nose, pupil, brow and mouth colour. |
| `castLeftColor` | colour | `#8fa6d6` | | Colour of the shadow cast to the left. It multiplies, so pale tints darken whatever is under them. |
| `castRightColor` | colour | `#ebccb8` | | Colour of the shadow cast to the right. It multiplies, like castLeftColor. |

**Paint texture**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `strokes` | number | 1 | 0 to 3 | Density of the tonal and dry-brush streaks on the body. 0 leaves flat paint. |
| `tonal` | number | 0.6 | 0 to 1 | How far the lighter and darker streak tints stray from the body colour, 0 to 1. |
| `scratches` | number | 1 | 0 to 3 | Density of the thin tapered light scratches. |
| `scratchWidth` | number | 1 | 0.2 to 4 | Width of the scratches as a multiple of a hairline that scales with width. |
| `edgeRough` | number | 1 | 0 to 3 | Raggedness of paint edges: how far bristles drag past the outline and how much it wobbles. |
| `dryness` | number | 0.6 | 0 to 1 | Dryness of the brush, 0 to 1. Higher gives more broken bristles. |
| `markSide` | number | 0 | -1 to 1 | Which body edge collects more streaks and scratches, -1 left to 1 right. |
| `shadeSide` | number | -0.6 | -1 to 1 | Which side of the muzzle takes the cool rim, -1 left to 1 right. |
| `fringe` | number | 0 | 0 to 1 | Width of the dry-brush fringe along the body edge, where whatever is underneath shows between bristle lines, 0 to 1. |
| `fringeSide` | number | -1 | -1 to 1 | Which body edge has the dry-brush fringe: below 0 the left, above 0 the right, 0 both. |

**Paws and pose**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `pose` | enum | `idle` | `idle`, `wave`, `cheer`, `shy` | Where the paws are. |
| `pawSize` | number | 0.2 | 0 to 0.5 | Paw width, as a fraction of width. 0 hides the paws. |
| `wavePaw` | enum | `right` | `left`, `right` | Which paw waves in the wave pose, as seen on screen. |
| `waveSpeed` | number | 1.5 | 0 to 5 | Waves per second in the wave pose. 0 holds the paw still. |

**Face animation**

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `expression` | enum | `neutral` | `neutral`, `happy`, `sad`, `surprised` | Moves the brows, mouth and eyes from their face params. |
| `blink` | number | 0 | 0 to 1 | Eyelid closure by hand, 0 open to 1 shut. From 0.8 up the eye is drawn shut. |
| `blinkRate` | number | 12 | 0 to 60 | Automatic blinks per minute, on a seeded schedule. 0 turns them off. |
| `breath` | number | 1 | 0 to 3 | Strength of the idle breathing bob. At 1 the bear rises 0.8 percent of width. 0 holds it still. |

### bear.bandaged

A variant of `bear` with a sticking plaster on its head: two crossed painted strips with a gauze pad where they cross, clipped to the head so a plaster near the edge wraps over it. It takes every `bear` param with the same defaults, and for the same params it draws exactly what `bear` draws, plus one extra part, `plaster`, painted after the body and before the face. A test checks this against the base rig's draw log. Use it through an override to bandage a bear for a stretch of frames:

```json
"overrides": [{ "from": 48, "to": 72, "rig": "bear.bandaged" }]
```

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `plasterX` | number | 0.36 | -0.7 to 0.7 | Plaster centre x in the body frame, as a fraction of width. |
| `plasterY` | number | 0.05 | -0.2 to 2 | Plaster centre y below the top edge of the head, as a fraction of width. |
| `plasterAngle` | number | -28 | -90 to 90 | Turn of the whole plaster in degrees, clockwise. |
| `plasterSize` | number | 0.28 | 0.05 to 0.8 | Length of each strip, as a fraction of width. |
| `plasterColor` | colour | `#efcb98` | | Colour of the plaster strips. |
| `plasterPad` | colour | `#fbf7ee` | | Colour of the gauze pad where the strips cross. |

## Sound

A scene's sound is a list of audio cues. Each cue names a generator, which is code that makes the sound, the way a rig is code that draws. Like the picture, the sound depends only on the scene file: the same scene gives the same samples every time.

```json
"audio": [
  { "id": "beats", "generator": "blip", "start": 0.5, "end": 1.9, "params": { "pitch": 1000, "every": 0.5 } },
  { "id": "bed", "generator": "pad", "start": 2, "end": 4, "params": { "note": 110, "chord": "minor" } }
]
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique among the cues. It also seeds the cue's randomness, with the scene seed. |
| `generator` | string | One of the generators below. |
| `start`, `end` | seconds | The cue plays over `[start, end)`, from 0 up to the scene duration. Both snap to the frame they fall in, so a sound starts exactly when its frame appears. |
| `params` | object | The generator's params. Missing ones take their defaults. |

Sound renders at 48 kHz, so a scene with audio needs an fps that divides 48000: 12, 24, 25, 30, 48 or 60 all do. The validator says so if not. Cues mix together; there is no volume field beyond each generator's `gain`.

### pad

An ambient chord that fades in and out, good under a whole scene. Two slightly detuned saw waves per note, through a soft lowpass.

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `note` | number | 220 | 30 to 2000 | Root pitch in Hz. |
| `chord` | enum | `fifth` | `fifth`, `major`, `minor`, `unison` | Intervals stacked on the root. |
| `gain` | number | 0.2 | 0 to 1 | Loudness at full volume. |
| `attack` | number | 1 | 0 to 20 | Fade-in in seconds. |
| `release` | number | 1.5 | 0 to 20 | Fade-out in seconds, ending at the cue end. |
| `brightness` | number | 0.4 | 0 to 1 | How open the filter is. 0 is muffled, 1 is buzzy. |

When `attack` and `release` add up to more than the cue, both shrink in proportion.

### buzz

An insect buzz: a saw tone plus band-passed noise, pulsing at the wingbeat. Its pitch wanders along a seeded path, so two cues with different ids buzz differently.

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `pitch` | number | 220 | 50 to 1000 | Base pitch of the buzz in Hz. |
| `wander` | number | 0.5 | 0 to 1 | How far the pitch drifts, up to half an octave either way. |
| `flutter` | number | 28 | 0 to 60 | Wingbeat rate in Hz: how fast the loudness pulses. |
| `gain` | number | 0.25 | 0 to 1 | Loudness. |
| `fade` | number | 0.05 | 0 to 2 | Fade in and out, in seconds. |

### blip

A short beep for UI moments and hits. Each blip starts exactly on a frame.

| Param | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `pitch` | number | 880 | 50 to 8000 | Pitch in Hz. |
| `wave` | enum | `sine` | `sine`, `triangle`, `square`, `sawtooth` | Tone colour. |
| `length` | number | 0.08 | 0.005 to 2 | How long each blip rings, in seconds. |
| `every` | number | 0 | 0 to 60 | Seconds between blips. 0 plays one blip at the cue start. Repeats snap to frames and are at least a frame apart. |
| `gain` | number | 0.3 | 0 to 1 | Loudness. |

## Opening a scene in the viewer

Run `npm run dev` and open the URL it prints. Add `?scene=<id>&frame=<n>` to land on a scene and frame, for example `http://localhost:5173/?scene=shapes-test&frame=36`. `frame` also takes a timecode such as `00:03:00`, and `scene` also takes the file name without `.json`. If `scene` matches nothing, the viewer shows the first scene with an error and opens the requested one as soon as its file exists. The URL follows along as you scrub, so a reload returns to the same place. Space plays and pauses, the arrow keys step one frame, Shift with an arrow steps one second, and Home and End jump to the ends.

Click the canvas to select the layer under the pointer. The viewer outlines it and shows its id in a tag above it. Clicking the same spot again steps down through the layers painted there and wraps back to the top. Alt with a click picks the part of the layer, such as `bruno › nose`. While paused, hovering shows a fainter outline on the layer the pointer is over. The selection is hidden during playback, since redrawing it costs several times the render, and it comes back on pause. I marks the frame on screen as the start of the frame range and O marks it as the last frame. You can also type a frame number or a timecode into the from and to fields. Ranges are `[from, to)`, so O on frame 30 stores `to: 31`. Escape clears the hover, then the layer, then the range. The URL carries the selection as `layer`, `part`, `from` and `to`.

While a frame range is set, playback loops inside it, the way in and out points work in an editor. Clear the range to play the whole scene.

A scene with audio gets a speaker button next to play. The viewer renders the scene's sound once when it opens the scene, and again when an edit changes the cues, then plays it in step with the picture, looping with the range and following seeks. Browsers only allow sound after a click or key press on the page, so the button stays grey until then. M or the button mutes, and the setting sticks across reloads.

The Requests panel on the right sends asks to your coding agent (`docs/MCP.md`, "Requests from the viewer"). It applies to whatever is selected: a layer or part and a range, a range alone, or with nothing selected the whole scene. Write what should change, attach, paste or drop reference images, and press **Send to agent**, or Cmd/Ctrl+Enter. The queue below shows each request's status and the agent's summary. Click one to bring its selection back, and use **View**, **Revert** or **Try again** on finished ones. The viewer also keeps `.frame-studio/selection.json` up to date, so the agent can ask what you mean by "this".

If a scene has mistakes, the viewer lists every error with its path, such as `layers[1].tracks[0].keys[2].t`. `npm test` validates every file in `scenes/` against the rigs and renders each frame, so it catches the same errors without a browser.

Scripts and agents can drive the page through `window.studio`. `studio.renderFrame(n)` pauses and draws frame `n` straight away, and `studio.canvas` is the canvas to capture. `seek(n)`, `play()`, `pause()` and `selectScene(id)` move around, and `scene`, `frame`, `frameCount`, `scenes` and `errors` report state. `studio.errors` holds the same list as the error panel and updates about 200 ms after a file save, so it is the quickest check after an edit. `studio.hitTest(x, y, { parts })` returns the layer, and optionally the part, at a scene pixel on the frame on screen without changing the selection. `select(layerId, partId?)`, `setRange(from, to)` and `clearRange()` set the selection, and `selection` and `range` read it back.

## Rendering and exporting

Three commands render a scene without the viewer. Each starts its own Vite server and Playwright's headless Chromium (except the HTML export, which needs no browser), prints the file it wrote on stdout, and puts progress on stderr. Frames and range ends take a frame number or a timecode.

```sh
npm run render -- --scene bear-test --frame 47            # out/bear-test/frame-00047.png
npm run export -- --scene bear-test --target mp4          # out/bear-test/bear-test.mp4
npm run export -- --scene bear-test --target gif --from 00:02:00 --to 00:04:00
npm run contact-sheet -- --scene bear-test --every 6      # out/bear-test/contact-sheet-...png
npm run export -- --scene bear-test --target html         # out/bear-test/bear-test.html
```

`--out` picks another path. `--to` is excluded, like every frame range, so `--to 00:08:00` on an 8 second scene means "to the end". The contact sheet takes `--every` and `--columns`, and without `--every` it shows about 24 frames.

MP4 is H.264 at the scene's fps. It is tagged sRGB, so QuickTime, browsers and ffmpeg all show the scene's colours. A range export starts at 0 s. GIF loops, keeps a 255-colour palette that holds the scene's most common colours exactly, and refuses scenes above 50 fps, which GIF can't play. H.264 needs an even width and height.

A scene with audio exports its sound into the MP4: AAC at 128 kb/s where the browser has an AAC encoder (macOS and Windows), and Opus where it doesn't (Linux). A range export takes the sound for just its frames. AAC lines up with the frames to within a sample in QuickTime and ffmpeg, and both codecs last exactly as long as the video. Opus plays 6.5 ms late in QuickTime, which ignores the start delay Opus carries. `--silent` leaves the sound out. GIFs are always silent.

### The HTML embed

`npm run export -- --scene bear-test --target html` writes `out/bear-test/bear-test.html`, a single file that draws the scene live. It holds the engine, a small player, only the rigs the scene uses and the scene itself. It makes no network requests, so it works opened from disk, dropped into a website or loaded in an iframe. The scene is validated when you export, so the file doesn't carry the validator, and rig and param descriptions are stripped since the player never reads them. `bear-test` comes to about 54 KB and `shapes-test` to 19 KB. The engine and player are about 8.5 KB of that. This export needs no browser and takes under a second.

A scene with audio also bundles the generators its cues use, about 7 KB more for `audio-test`. The embed renders the sound when it loads, but starts muted, because browsers only allow sound after a click in the page. A speaker button in the corner turns it on and off, and the sound follows play, pause and seeks. `--silent` exports the embed without sound, and then it carries no audio code at all.

The embed plays on load and loops. Add `?autoplay=0`, `?loop=0` or `?frame=47` to its URL to change that. It draws at scene size and CSS scales it to fit its box, letterboxed, so its frames match the PNG renders pixel for pixel.

A page on the same origin can call `window.studio.play()`, `pause()` and `seek(frame)` in the embed's document, and read `frame`, `playing`, `frameCount` and `fps`. A host page on another origin, such as one showing the file in an iframe, sends messages instead:

```js
iframe.contentWindow.postMessage({ type: 'frame-studio', command: 'seek', frame: 30 }, '*');
```

The commands are `play`, `pause`, `seek` (with a numeric `frame`), `mute`, `unmute` and `state`. The embed answers each one with `{ type: 'frame-studio:state', frame, playing, frameCount, fps }`, plus `muted` when it has sound and an `error` field when it could not do what was asked. `muted` stays true until the browser lets the embed play sound, so `unmute` from another page only takes effect where the browser already allows the frame to play sound. Same-origin pages can use `studio.setMuted(false)` and read `studio.sound`. It also posts that state to its parent once on load. A host that starts listening later can send `state` to ask.

### The render page and tests

The browser needs downloading once, with `npx playwright install chromium-headless-shell`. The page behind the commands is `render.html?scene=<id>`. It draws at scene size on a CPU-rastered canvas, and its `window.studio` has `renderFrame`, `pixelHash`, `audioHash`, `writePng`, `exportVideo` and `contactSheet`. `npm run test:browser` checks that every frame of every scene draws the same pixels whether played or seeked, that exports have the exact frame count and duration, and that the HTML embed matches the render page pixel for pixel with the network off. For sound, it checks that a scene renders the same samples in two browser launches, and that blips in the exported MP4 land within a frame of their frames when ffmpeg decodes it.

## The test scenes

`shapes-test` runs at 12 fps for 6 seconds and loops.

- `onOnes` and `onTwos` are circles on the same path. `onTwos` has `stepFps: 6`, so it visibly holds every other frame.
- `star` spins, pulses its scale with `outBack`, and steps its fill colour every 1.5 seconds.
- `block` is a rounded rect that rolls across the bottom. An override over frames `[36, 48)` turns it pink and wobbly while it is moving fast.

`hello` runs at 24 fps for 3 seconds at 1280 by 720, with one ball bouncing on `inQuad` and `outQuad` keys.

`bear-test` is the M2 character scene, 1920 by 1080 at 12 fps for 8 seconds on the orange of `bears`. `bruno`, a big white bear, eases in from the left over the first 2 seconds, then waves at 2 s, cheers at 5 s and rests at 7 s, going neutral, happy, surprised and neutral with it. An override swaps him to `bear.bandaged` over frames `[48, 72)`. `pip`, a smaller red bear in front of him with `stepFps: 6`, starts shy and sad and waves happily from 4 s. Both blink. The paper around them is left clear, so a click on empty paper has room to land.

`audio-test` is the M7 sound scene: 640 by 360 at 30 fps for 4 seconds. A circle swells on the three blips at 0.5, 1 and 1.5 s, a star spins while a buzz plays from 2.2 s to 3.2 s, and a minor pad fades in under it from 2 s. The browser tests use the blips to check audio alignment.

`bears` is a single 1080 by 1920 frame with four `bear` layers on a flat orange `paper` ground. It recreates a painted illustration, with the white bear at the back, then the red, blue and yellow ones.

## Writing a rig

A rig is a TypeScript object in `src/rigs`, typed as `Rig` in `src/engine/types.ts`:

```ts
interface Rig {
  id: string;
  description?: string;
  params: ParamSchema;
  parts?: readonly string[];
  draw(ctx: Ctx2D, params: Params, t: number, rng: Rng, stage: Stage, kit: DrawKit): void;
}
```

`draw` gets a context already scaled to scene pixels, the resolved params, the layer time `t` in seconds after `stepFps`, a seeded `rng` for the layer, `stage`, the scene size as `{ width, height }`, and `kit`, whose `part(id, draw)` wraps the drawing of one named part. `CLAUDE.md` still shows the four-argument form. TypeScript accepts a `draw` that leaves out the trailing arguments, and a rig without parts can ignore `kit`.

1. Add the rig to `allRigs` in `src/rigs/index.ts`. That makes it available to scenes and runs the smoke tests in `src/rigs/rigs.test.ts` on it.
2. Give the rig a `description` and give every param one. Number params need `min` and `max`, and the default must sit between them. The tests fail otherwise.
3. Read params through `readParams(schema, params)` from `src/rigs/parts/params.ts`. It falls back to the default for a missing or wrong-typed value and clamps numbers to their range, so an eased overshoot never reaches the canvas. Reading `params` directly skips both.
4. For a filled, outlined shape, use `defineShapeRig` from `src/rigs/parts/shape.ts`. You supply the geometry, and it adds the shared position, style and wobble params. For a painted look, use the brush, mark and wash helpers in `src/rigs/parts/paint.ts`. The `bear` rig uses all of them.
5. Size everything from `stage`. Never read `ctx.canvas`, because the viewer's backing store is not the scene size. The tests throw if a rig reads it.
6. Match every `save()` with a `restore()` before `draw` returns. `render` resets drawing state between layers, but it cannot undo a leaked `save()` on a real canvas.
7. Take every random choice from `rng`, forked with a fixed key per part, such as `rng.fork('grain')`. Fork keys may not contain `/`. `Math.random`, `Date`, `performance` and `requestAnimationFrame` are banned, and `tests/runtime-budget.test.ts` scans for them.
8. Add the rig and its params to the tables in this file.
9. Follow the rig rules below. `src/rigs/rig-rules.test.ts` checks them on every rig in `allRigs`.

### Rig rules

Hit testing draws one layer at a time into a 1x1 canvas, translated so the clicked pixel lands on its only pixel. To name the part under the cursor, it draws the winning layer again and reads that pixel at every part boundary. Selection masks draw a layer, or some of its parts, on their own. All of that works only if a rig follows four rules.

1. Never call `setTransform`, `resetTransform` or `reset`, and never read `ctx.canvas`. Use `save`, `translate`, `rotate`, `scale` and `restore`. The probe's transform is what puts the clicked pixel under the 1x1 canvas, and an absolute transform throws it away.
2. A rig that declares `parts` wraps every paint call (`fill`, `stroke`, `fillRect`, `strokeRect`, `fillText`, `strokeText`, `drawImage`) in `kit.part(id, ...)`, with an id from its parts list. Parts do not nest. A mark outside any part cannot be selected, and a nested part cannot be told apart from its parent.
3. Parts are independent. Drawing with `onlyParts([p])` must give exactly the marks `p` gets in the full draw. So each part draws from its own `rng.fork`, sets up its own fill, stroke and composite state, and computes anything it shares with another part (an outline, say) outside `kit.part`, where it runs whichever parts draw.
4. Inside parts, use only `source-over` or a blend mode (`multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`). The Porter-Duff operators that read or replace what is already there (`source-atop`, `source-in`, `source-out`, `destination-*`, `xor`, `copy`, `lighter`) make a part's pixels depend on what was drawn before it, which a part drawn alone does not have.

A rig with no `parts` only needs rule 1, and the tests check rules 2 to 4 on rigs that declare parts. `bear` and `bear.bandaged` follow all four.

The viewer swaps an edited rig in without a reload and keeps the frame.

## Writing a generator

A generator is a TypeScript object in `src/audio`, typed as `AudioGenerator` in `src/audio/types.ts`:

```ts
interface AudioGenerator {
  id: string;
  description?: string;
  params: ParamSchema;
  schedule(ctx: BaseAudioContext, out: AudioNode, times: CueTimes, params: ParamReader, rng: Rng): void;
}
```

`schedule` builds the cue's Web Audio graph into `out`. `times` holds the cue's span snapped to frames, as samples (`startSample`, `endSample`) and as context seconds (`start`, `end`), plus the scene `fps`. `params` is the same reader rigs use, with defaults and clamping. `rng` is seeded from the scene seed and the cue id. The same code runs in the viewer, the embed and the export, which all play one offline render of the whole scene, so what you hear while previewing is what the MP4 gets.

1. Add the generator to `allGenerators` in `src/audio/index.ts`. The unit tests in `src/audio/audio.test.ts` then run on it with a fake audio graph.
2. Give it a `description` and give every param one, with `min` and `max` on numbers, as for rigs. `list_generators` shows them to agents.
3. Build the whole graph inside `schedule`. Start and stop every source inside `[times.start, times.end]`. Nothing may be scheduled later.
4. Never connect more than two nodes into one input, a param or `out`. Chromium adds three or more in an order that changes from run to run, so the samples stop being identical. Sum with `mix(ctx, sources, dest)` from `src/audio/mix.ts`, which builds a tree of two-input gains.
5. Take every random value from `rng`, forked per use, such as `rng.fork('noise')`. `noiseBuffer(ctx, rng)` makes a second of seeded white noise to loop.
6. For automation that must land on a frame, use `paramTime(n)` for the time of sample `n`. It is half a sample early, because an exact time lands a sample late now and then. `sourceTime(n)` is for `start()` and `stop()`. `frameSample(t, fps)` gives the first sample of the frame that time `t` falls in.
7. Play buffers at `playbackRate` 1 and put loop points on whole samples. Don't automate k-rate params such as `playbackRate` or `detune` on a buffer source where timing matters. Skip `AudioWorklet`.
8. Add the generator and its params to the tables in this file.

The viewer re-renders the sound when a generator file changes.

