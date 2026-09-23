# How can the ID pass read exact layer colours when Canvas 2D antialiases every path?

Type: research
Status: resolved
Blocked by: none

## Question

`hitTest` re-renders the frame with each layer, and each named part, filled in a unique flat colour, then reads the pixel under the cursor. Canvas 2D has no setting that turns off antialiasing for paths, so an edge pixel blends two ID colours into a third colour that belongs to no layer.

What do the HTML canvas spec and Chromium actually offer here? Candidates include `imageSmoothingEnabled`, `filter`, `willReadFrequently`, the `colorSpace` context option, and snapping geometry to whole pixels. Which decoding scheme gives the right layer at edge pixels? Can premultiplied alpha or colour management change a flat fill's exact RGB value on readback?

## Answer

Canvas 2D has no way to turn off path antialiasing, and none of `imageSmoothingEnabled`, `willReadFrequently`, `colorSpace`, `filter` or pixel snapping makes flat ID colours decodable at edges, where dense IDs blended into another valid ID on half of all edge pixels. Only fully opaque sRGB fills read back exactly. For M2, drop colour decoding and draw each layer through the shared `drawLayer` into a 1x1 `willReadFrequently` `OffscreenCanvas` translated to the click, top layer first, keeping the layer that contributes most alpha to the visible pixel. For part ids, re-draw the winning layer with a `part()` hook that reads and clears the pixel at each part boundary. In tests this took 0.2 to 0.7 ms per click with 41 layers and never returned a layer absent from the pixel, though answers on the one-pixel edge band can differ from the GPU-rendered canvas.

Findings: [research/id-pass-antialiasing.md](../research/id-pass-antialiasing.md)
