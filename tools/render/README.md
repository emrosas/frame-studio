# Render tools

Headless rendering and export for M3. `cli.ts` behind `npm run render`, `npm run export` and `npm run contact-sheet`; `studio.ts` opens `render.html` in Playwright's headless Chromium with a Vite server behind it, and is shared with `tests/browser/`. Usage is in `docs/SCENES.md`, "Rendering and exporting".

The files run as TypeScript through Node's type stripping, so relative imports carry their `.ts` extension and the code sticks to erasable syntax (no enums, namespaces or parameter properties).

Encoding happens in the page, not here (ticket 14). Node only receives bytes: the page calls `window.__studioWrite(sinkId, base64, position)`, which `studio.ts` installs with `exposeFunction`, and each sink id maps to an open file. Chromium launches with ticket 03's flags, `--disable-accelerated-2d-canvas --disable-skia-runtime-opts`, and Playwright is pinned exactly in `package.json`. An upgrade changes the browser, so run `npm run test:browser` after one.
