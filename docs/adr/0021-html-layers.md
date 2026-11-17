# 0021: HTML layers on stills, drawn with Chromium's HTML-in-Canvas

Status: accepted, 2026-11-17, on the owner's decision. Amends ADR 0014: "HTML authoring" leaves its Refused list for this one layer type, and "a scene that names a file is refused" gains one exception. Amends CLAUDE.md's "no fonts, images, or base64 blobs in rigs or scenes": a still's html layer points at a page whose fonts and images sit beside it in the project folder. Rigs stay as they were.

## Context

The owner makes Instagram carousels daily, 4 to 8 slides at 1080x1350, as hand-written HTML and CSS rendered with Playwright in another repo. They wanted to finish those slides here: open one, click an element, drag it or leave a note for the agent, export the image. ADR 0014 refused HTML authoring because the premise is that the agent writes drawing code. The owner asked whether Chromium's HTML-in-Canvas API changes that, since the app ships its own Chromium, and after the spike below decided to reverse the refusal for stills.

Rebuilding the slides as rigs was the other route. It keeps every premise, and it means redoing in canvas code what CSS already does for these slides: web fonts with variable axes, `backdrop-filter`, blurred photographs, `zoom`, icon fonts. The table at the end compares the routes.

## What the spike measured

Electron 44.4.5 (Chromium 152.0.7977.130), on the six slides of `business-owner-loading`. The scripts are in the session's scratchpad, and `tests/browser/html-slides.test.ts` repeats what matters.

1. **Fit.** Yes. A page loads in an iframe inside `<canvas layoutsubtree>`, and `ctx.drawElementImage(iframe, 0, 0, w, h)` draws it. The host does that ahead of the frame and keeps the result as an image, so `render()` only calls `drawImage`. This is ADR 0014's pattern unchanged: `picturesAt` lists what a frame needs, the host awaits it, `world.pictures` hands it over.
2. **Hosts.** The viewer and the render worker draw it, both hidden and shown, so PNG, JPG, `render_frame`, contact sheets, `check` and `hit_test` carry it. MP4 and GIF would too, since the frame is an ordinary picture by then, but the layer is allowed on stills only. The one-file embed can't: it has no Chromium of its own to lay a page out, and a visitor's browser has no such API. Playwright's Chromium 153 has the API behind the same flag, which is how the viewer's tests run.
3. **Fidelity.** Local woff2 fonts, Google Fonts, the SVG logo, gradients, `filter: blur(70px)`, `backdrop-filter`, `zoom: 1.9` and Material Symbols all draw. Against the Playwright renders, slides 2 and 5 differ in under 0.01% of pixels, and the rest by a mean of under 1 level of 255, which is the blurred photographs decoded by another Chromium build. Two things failed until the pages were served differently: cross-origin images don't paint at all (the API leaves them out, with cross-origin iframes, system colours, visited links and spelling marks, so a canvas can't be used to read them), and that is silent, an empty box.
4. **Stability.** The same bytes on every run and across four app starts. Not across displays: at device scale 2 the page is rasterized at 2x and scaled down, and text differs from scale 1 in up to 2% of pixels. Zooming the iframe by `1 / devicePixelRatio` gives byte-identical output at both scales, so that is what the host does. Electron 45.3.3 (Chromium 156) with the same flag gives byte-identical pixels to 44.4.5 for all six slides.
5. **Selection.** Hit testing works unchanged, since the layer is a picture to the probe. The iframe's document stays live, so `elementFromPoint` names the element under a pixel and `getBoundingClientRect` gives its box.
6. **Three traps.** A draw before the canvas's first paint succeeds and draws nothing. So does a draw from a canvas that is off-screen or at opacity 0. Neither throws. The host waits for the canvas's `paint` event before every draw, keeps the canvas in the viewport (clipped away, behind the page), and refuses a result with no pixels in it. The third is a crash: taking the canvas out of the document in the same turn as a draw kills the renderer process in Chromium 153, three times out of three. A page that is let go now leaves after its next paint, and `html-layer.test.ts` draws and lets go at once to keep that true.

## Decision

- **A layer, on a still.** `{ "id": "page", "html": "html/launch/1.html" }` shows a page at the stage's size. It takes `params` for `x`, `y`, `scale`, `rotation` and `opacity`, like a picture clip, and `offsets`. The validator refuses it off a still, in a composition, on a pixel stage, and as a background. One frame is the narrowest thing that is useful, and it keeps "frame N" out of the question: a page has no time.
- **Pages live in `html/`.** A project folder gains `html/`, where a page sits with its stylesheets, fonts and images. The studio server serves it at `/__studio/html/` with a Content-Security-Policy that runs no scripts and loads nothing from another origin, and the iframe is sandboxed. So a page's pixels depend on the files in `html/` and the browser build, never on the network or the clock. CSS animations and transitions are switched off in the page.
- **Importing brings the network in.** `create_html_stills` copies pages and what they use into `html/<name>/`, keeping their relative paths, and fetches whatever they load from the network once into `html/<name>/_remote/`, rewriting those URLs. That is the only change to a page. It is what makes cross-origin images paint and renders repeat offline.
- **`render()` stays synchronous and unchanged in shape.** `picturesAt` returns the page as a request, `PictureStore` draws it through `HtmlPages` (`src/export/html-pages.ts`), and the engine draws the image. The engine gained `src/engine/html.ts`, which is path checks and key strings, with no DOM.
- **Selection reaches inside.** On an html layer a click selects the element under it and `partId` is a CSS selector that finds it alone: its id, or the shortest unique run of tag-and-class steps, such as `div.btn`. The overlay outlines the element's box. A request carries the selector, and its description tells the agent the page and the element. `hit_test` returns the same selector.
- **A drag writes an offset on the layer, never the page.** `offsets` maps a selector to `[x, y]` in the page's pixels, applied as a CSS `translate` before the page is drawn. The page is the agent's and its author's, positioned by whatever CSS they chose (`left`, `bottom`, flex), and a drag can't know which rule to rewrite. On the layer, the move goes through the checked edit and Command-Z like every hand edit (ADR 0015), and stays visible as "moved by hand". An agent asked to restyle a moved element folds the offset into the CSS and removes the entry.
- **Hosts that can't carry it say so.** An HTML export of a scene with an html layer is refused, as it is for picture clips. A browser without the API shows "This browser can't draw HTML layers" in the error panel, and an export there fails with the same words.
- **Pages aren't code to trust.** Folder trust (ADR 0017) covers rigs and generators, which run. A page can't: no scripts, no network, no forms. So a folder's pages load without the trust prompt.

## What this depends on, and what an Electron upgrade must check

- **Pinned:** Electron 44.4.5, Chromium 152. The API exists only with `--enable-blink-features=CanvasDrawElement`, which `desktop/switches.ts` sets for the app, the worker and the tests' windows. Without it html layers say they can't be drawn and nothing else changes.
- **A Blink feature flag in a shipped app** means running code Chromium hasn't called stable. It can change shape or behaviour in any release, and its bugs are ours to find. The flag turns on nothing else, pages run no scripts, and the cost of it breaking is that html layers stop drawing with a message.
- **The API is being renamed.** Chromium 152 to 156 opt in with the `layoutsubtree` attribute. The WICG explainer now uses `content="drawable"` on the canvas and `drawable` on the child, with `drawElementImage` unchanged. `HtmlPages` sets all three attributes. Web sources say Chrome 157 turns the feature on by default with the new names; that isn't verified here.
- **On every Electron upgrade:** run `tests/browser/html-slides.test.ts` and `html-layer.test.ts`. If `drawsHtml()` is false, the flag or the method was renamed: fix the name in `desktop/switches.ts`, `tests/browser/browser.ts` and `src/export/html-pages.ts`. If pixels changed, that is ADR 0008's rule: pixels hold per Electron build. Check that an off-screen draw is still refused as blank, since that guard is what catches a silent failure. Once the feature is on by default, drop the flag.

## Refused

- HTML layers in animations, compositions and the embed. A page that moves needs a clock in the page, which is the determinism rule's opposite.
- Scripts in pages.
- Writing a drag into the page's CSS.
- Text checks inside pages. `check` reads `text` and `captions` layers; a page's text isn't measured.

## Consequences

- **Frame N is a pure function of (scene, the files under `html/`, the Electron build).** That is ADR 0014's promise for picture clips, widened to pages. Across machines, fonts are files, so text should match; decoded photographs may differ by a level or two.
- **"Scenes stay code" bends.** A still with an html layer is authored in HTML and CSS, by the agent or by hand. Rigs, animations and compositions are as they were.
- **"No fonts or images in scenes" breaks for this layer.** The scene file holds a path; the fonts and images are files in `html/`. Nothing is inlined in a scene.
- **The one-file embed is untouched and can't carry these.** It is still the edge for everything drawn in code.
- A page whose stage is far larger than the window may not paint whole. The host reports a blank draw instead of exporting one.
- `offsets` name elements by selector. If the page changes so a selector finds nothing, that offset does nothing.
- The viewer in a plain browser can open a project with html stills but not draw them.

## Three routes for the owner's slides

| | Rebuild as rigs | An html layer | Keep them outside |
| --- | --- | --- | --- |
| Work to bring one slide in | Hours: new rigs for cards, bars, glass and blurred photos, and typeface modules for three font families | One tool call | None |
| Matches today's renders | Close at best; `backdrop-filter` and blurred photos have no canvas equivalent in the engine | Yes, within the tolerance in the roadmap | They are today's renders |
| Click, drag, comment in Frame Studio | Yes, on layers and parts | Yes, on elements | No |
| Exact-size PNG and JPG | Yes | Yes | Yes, with `render.mjs` |
| One-file embed, MP4, GIF | Yes | No | No |
| Premises kept | All | Determinism per build; scenes-stay-code and no-assets bend for this layer | All, by not using the tool |
| Stability risk | None new | A flagged Chromium API under a rename, checked on each Electron upgrade | Playwright's Chromium, as now |

For slides that already exist as HTML and ship daily, the html layer is the route that gets them into the tool. Rigs remain right for anything that moves or needs the embed.
