# How can the Electron app load, reload and bundle rig code without Vite's dev server?

Research for [issue 19](../issues/19-m10-electron-app.md). Checked 2026-09-25 on an Apple M1 Pro with macOS 27.0. Versions: Electron 44.4.5, which carries Node 24.21.0 and Chromium 152.0.7977.130, plus Node 26.8.1 on the host. Vite is 8.3.0, and Rolldown is 1.2.9 in the repo and 1.2.11 in a fresh install of Vite 8.3.0, since Vite asks for `~1.2.6`. The other tools were esbuild 0.28.2, esbuild-wasm 0.28.2, es-module-lexer 3.0.2 and acorn 8.18.0. Every experiment ran on copies of the repo in `/tmp`, including the working tree's edited `bear-test.json`, and nothing in the repo changed. I had no Windows or Linux machine. The shell on this machine sets `ELECTRON_RUN_AS_NODE=1`, so every Electron GUI run had to unset it first.

## Question

Rigs and audio generators are TypeScript modules with extensionless relative imports such as `./parts/params`. Project rigs reach the shared parts with `../../../src/rigs/parts/params`. Today Vite loads all of them. The viewer uses `import.meta.glob` and HMR (`src/viewer/scenes.ts`, `src/viewer/main.ts`), the Node tools use `ssrLoadModule` (`tools/scene-files.ts`), and the HTML export bundles with Vite's `build`, which runs Rolldown (`tools/bundle/embed.ts`).

The packaged app won't run a Vite dev server, and it still has three jobs:

1. Load rig and generator modules that an agent writes or edits into the viewer page, and reload them on change without a restart.
2. Load the same modules in Node, in the studio server, for validation and `list_rigs`.
3. Bundle the embed: the engine, the player, only the rigs the scene uses and the scene data, minified into one inline IIFE.

Which approach should M10 build, and what does each cost in size, run time and fidelity with the dev workflow?

## Short answer

Don't ship Vite. Ship Rolldown on its own for the embed. Load rig code at run time through a small module service in the studio server, using Node's built-in type stripping.

Vite 8.3.0 does run under Electron 44's Node, both with `ELECTRON_RUN_AS_NODE` and inside a `utilityProcess`. It built embeds byte-identical to the ones Node 26 built. But it's 29.9 MB on darwin-arm64, 11.3 MB gzipped, and the app would use two pieces of it: the Oxc transform and Rolldown. The prebuilt viewer has no `import.meta.hot`, so Vite's HMR client can't drive it. Middleware mode also opens a WebSocket server on port 24678 on every interface unless `server.ws` is `false`. Rolldown alone is 17.1 MB, with a 6.9 MB gzipped binding. It carries the bundler, the Oxc transform and the parser that `stripDescriptions` already uses. Its JS API built all four test embeds within 46 bytes of Vite's output, and every frame I rendered from them matched Vite's embeds pixel for pixel.

For loading, Node's `module.stripTypeScriptTypes` costs no bytes, because Electron's Node already contains it. It also keeps every line and column in place, so a stack trace from a rig points at the real source line. Oxc, which Vite uses, reported a throw on source line 12 as line 3. Strip-only mode rejects TypeScript that needs a transform, and Node 26 removed the transform mode. In the repo that means three constructors with parameter properties, in `src/rigs/parts/paint.ts` and `src/rigs/studies/gouache/brush.ts`. Once those three are rewritten, `tsc` passes with `erasableSyntaxOnly` and `verbatimModuleSyntax` on every runtime file. Plain Node 24 and 26 then load the engine, every rig, every generator and the project rig with only a 15-line resolve hook.

A 119-line prototype module server fed Electron 44's renderer the whole rig graph. It rendered 20 frames of 8 scenes with the same pixel hashes as Vite's dev server and as the embeds. Editing `parts/math.ts` changed the frames on the next reload, and reverting it brought the original hashes back.

Reloads have a memory cost. The HTML module map never drops an entry, and neither does Node's ESM cache, so each reload leaves the old modules behind. Re-importing the whole graph cost 0.95 MB of renderer heap each time. Versioning each URL by a hash of the module and everything it imports reloads only what changed. That cut the cost to 6 kB for an edit to the project rig `iris.ts`, 120 kB for `bear.ts` and 513 kB for `parts/math.ts`. It also keeps unchanged generators as the same objects, which matters because the viewer's audio cache compares generators by identity. The dev viewer has the same growth today, since Vite's HMR re-imports with a new `?t=` query.

The renderer side is simple if the studio server also serves the viewer. Module imports are then same-origin, need no CORS headers, and pass under `script-src 'self'`. A privileged `app://` page needs CORS headers and a CSP that names the server's port. `file://` pages imported cross-origin even without CORS, but only because Electron's `grantFileProtocolExtraPrivileges` fuse is on by default, and Electron's security checklist says to avoid `file://`.

A reload does rebuild the whole library, and that's fine. `buildLibrary` took 3 to 5 ms for every scene in the repo, so the viewer's existing `setLibrary` swap stays the place to apply it.

## 1. What the repo does now

- `src/viewer/scenes.ts` is the HMR boundary. It imports `src/rigs/index.ts` and `src/audio/index.ts` statically, globs `/projects/*/rigs/*.ts`, and `main.ts` accepts updates for it and calls `app.setLibrary(loadLibrary())`.
- `tools/scene-files.ts` starts a Vite server and loads the engine, `src/viewer/library.ts`, `src/viewer/selection.ts`, the rigs, the audio index and every project rig through `ssrLoadModule`. The MCP workspace, the CLI and the embed builder all go through it.
- `tools/bundle/embed.ts` builds the embed with Vite's `build()` in library mode, `formats: ['iife']`, `minify: true`, `target: 'es2022'`. A `post` plugin runs `stripDescriptions` on rig and audio modules after Vite's TypeScript transform, parsing with Vite's `parseAst`, which is Rolldown's.
- Rig modules import only types from the engine. The one runtime engine import in reach of rigs is `src/rigs/index.ts`, which calls `createRegistry`. Generators reach `src/engine/time.ts` through `src/audio/timing.ts`.
- I found no import cycles among the 69 runtime files in `src/engine`, `src/rigs`, `src/audio`, `src/embed` and `projects/*/rigs`, no bare specifiers, no specifiers with an extension, and no dynamic imports.
- Module-level state in reach of rigs is limited to a lazily built table in `src/rigs/studies/pastel/tooth.ts` and a depth counter in `src/engine/render.ts`. Neither breaks if a module exists twice, once in the viewer's bundle and once as a served file. That matters, because any runtime loader gives served rigs their own copies of shared modules.

## 2. Option A: ship Vite

### Size

A fresh `npm i vite@8.3.0` in `/tmp` added 15 packages, 29.9 MB on disk. Most of it is two native binaries.

| Package | Size |
| --- | --- |
| `@rolldown/binding-darwin-arm64` 1.2.11 | 16.6 MB |
| `lightningcss-darwin-arm64` | 8.4 MB |
| `vite` | 2.4 MB |
| `rolldown` JS | 1.0 MB |
| `lightningcss` JS, `postcss`, `source-map-js`, `picomatch`, `nanoid`, `fdir`, `tinyglobby`, `@oxc-project/types`, `@rolldown/pluginutils`, `detect-libc`, `picocolors` | 1.6 MB together |

The same packages in the repo's `node_modules` add up to 29.3 MB, since the repo has Rolldown 1.2.9. Gzipped as one tarball the fresh install is 11.3 MB. Vite 8 made lightningcss "a normal dependency to provide better CSS minification out of the box" ([Vite 8 announcement](https://vite.dev/blog/announcing-vite8)). With lightningcss and postcss deleted, the embed builds still ran and matched byte for byte, at 20.1 MB, but that pruning isn't supported and could break on any Vite update.

### Does it run on Electron's Node?

Yes. `tools/bundle/embed.ts` ran unchanged, with Node's own type stripping, under `ELECTRON_RUN_AS_NODE=1` with Electron 44.4.5 and inside `utilityProcess.fork`. It built `bear-test`, `bears-gouache` and `bears-story/film`, and all three HTML files were byte-identical to the ones Node 26.8.1 built. A cold build, including server start, took 207 to 567 ms.

### What the app would use

The packaged viewer is a production build. Its modules aren't served by Vite, so none of them has `import.meta.hot`, and the dev viewer's `import.meta.hot.accept('./scenes')` has nothing to attach to. The app would either have the viewer import rig URLs from Vite's middleware and handle reloads itself, which is the same loader Option B needs, or serve a small virtual module through Vite that keeps `import.meta.glob` and HMR and have the prebuilt viewer import `/@vite/client` from it. I didn't try the second variant. It would keep today's reload path, at the cost of running Vite's HMR client and its WebSocket in the shipped app.

Other costs I measured:

- Vite in middleware mode listened on `*:24678`, every interface, even with `hmr: false`. The source is `if (config.server.middlewareMode && !isWsServerSpecified) port ||= 24678;` in `vite/dist/node/chunks/node.js`. A shipped app would need `server.ws: false`, which the docs say disables the WebSocket connection entirely ([server options](https://vite.dev/config/server-options)). The repo's own embed builder has the same default.
- `ssrLoadModule` after `moduleGraph.invalidateAll()` took 297 ms per full reload of the engine, rigs, audio and the project rig, because it re-transforms every file. Heap grew only 8 kB per reload, since Vite's module runner evaluates code itself and doesn't fill Node's ESM cache.

## 3. Option B: a module service on Node's type stripping

### The transform

`module.stripTypeScriptTypes` was added in Node v23.2.0 and v22.13.0. Its stability is "1.2 - Release candidate" in both the Node 24.21.0 and 26.10.0 docs. Node 24 offers `mode: 'strip'` and `mode: 'transform'`. Node 26's history table says "v26.0.0: Removed `transform` and `sourceMap` options" ([Node 26 module docs](https://nodejs.org/docs/latest/api/module.html#modulestriptypescripttypescode-options), [Node 24 module docs](https://nodejs.org/docs/latest-v24.x/api/module.html)). On Node 26.8.1, passing `mode: 'transform'` threw `The property 'options.mode' must be one of: 'strip'`, and `--experimental-transform-types` is a bad option. Electron 44's Node 24.21.0 still accepts both, reports `process.features.typescript` as `'strip'` and `process.versions.amaro` as 1.1.11, and prints an `ExperimentalWarning` the first time the function runs.

Type stripping of `.ts` files as Node loads them is a separate feature, and it is stable: "v25.2.0, v24.12.0: Type stripping is now stable" ([Node TypeScript docs](https://nodejs.org/docs/latest/api/typescript.html)). The same page lists what strip-only mode can't handle: enums, namespaces with runtime code, parameter properties and import aliases. It also requires the `type` keyword on type imports, because "Without it, Node.js treats the import as a value import, causing a runtime error." Node ignores `tsconfig.json`, so `paths` do nothing, and it "refuses to handle TypeScript files inside folders under a `node_modules` path."

I stripped all 69 runtime files on both Node versions. Two failed with "TypeScript parameter property is not supported in strip-only mode": `src/rigs/parts/paint.ts`, lines 278 and 540, and `src/rigs/studies/gouache/brush.ts`, line 34. Running `tsc` on the same files with `erasableSyntaxOnly` and `verbatimModuleSyntax` flagged exactly those five parameters and nothing else. So every type import in the runtime code already uses `import type` or an inline `type`. TypeScript's docs describe `erasableSyntaxOnly` as the check for Node's mode and suggest combining it with `verbatimModuleSyntax` ([TypeScript 5.8 notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html)). In a second copy I rewrote the three constructors to assign fields in the body. `tsc` then passed with both flags, and the served modules rendered the same pixels as Vite on all 8 scenes.

Stripping replaces types with spaces, so line and column stay where they are. I threw an `Error` on line 12 of a test module behind 8 lines of types. The page's `error.stack` said `:12:21` through the strip server and `:3:20` through both Oxc paths, Rolldown's `transformSync` and Vite's dev server. V8 doesn't apply source maps to `error.stack`, so today's dev viewer reports transformed positions too. An agent reading a rig error would get the true line with stripping.

All 69 files, 470 KB of source, took about 21 ms to strip. Oxc through Rolldown's `transformSync` took 15 ms, native esbuild 21 ms and esbuild-wasm 200 ms. One edited file costs well under a millisecond with any of them except esbuild-wasm.

### Specifiers and cache busting

Browsers don't guess extensions. The HTML standard resolves a specifier that starts with `/`, `./` or `../` by URL-parsing it against the base URL and returning the result ([resolve a URL-like module specifier](https://html.spec.whatwg.org/multipage/webappapis.html#resolving-a-url-like-module-specifier)). The module map is "keyed by tuples consisting of a URL record and a string", and it exists "to ensure that imported module scripts are only fetched, parsed, and evaluated once per Document or worker" ([module map](https://html.spec.whatwg.org/multipage/webappapis.html#module-map)). A new query string therefore loads a fresh module, and nothing ever removes the old one.

I tried three URL schemes in the prototype:

- **Rewrite with a global generation.** The server strips types, parses the result with es-module-lexer, and rewrites each relative specifier to `/m/<path>.ts?v=<generation>`. A file watcher bumps the generation. Every reload re-evaluates the whole graph: 33 to 48 ms warm, 0.95 MB of heap each time. This is about how Vite's HMR busts caches too. Vite's client re-imports `?t=<timestamp>`, and its import analysis adds `t=` to imports of modules with a newer `lastHMRTimestamp`. Vite 8 bundles es-module-lexer for that import analysis.
- **Generation in the path.** The server serves `/g/<generation>/<path>` and rewrites nothing. Relative imports inherit the generation from the importer's URL. An extensionless request gets a 302 to the `.ts` file, and a directory request gets a 302 to its `index.ts`, so each module's base URL becomes the real file. This needs no parser at all, and it rendered identical pixels and picked up an edit. It re-evaluates the whole graph on every change, like the first scheme. The HTML standard keys the module map by the request URL, so the same file imported under two spellings, `./params` and `./params.ts`, would become two modules. Every import in the repo is extensionless, so the spelling is consistent today.
- **Deep hash.** Each rewritten URL carries a hash of the module's stripped text and the hashes of everything it imports, as `?h=<hash>`. Editing a file changes the URLs of that file and its importers only. Unchanged modules keep their URLs, stay in the module map, and stay the same objects. A reload took a median of 4 ms after editing `iris.ts`, 8 ms after `bear.ts` and 21 ms after `parts/math.ts`, and the server re-stripped one file per edit.

The deep hash is the one to build. It costs a parse per file, which the strip server already caches by modification time. Cycles need care. There are none today, but a real version should hash each strongly connected component as one unit.

### Loading in Node

The studio server needs the same modules in Node. `module.registerHooks` adds synchronous, in-thread resolve and load hooks. It was added in v23.5.0 and v22.15.0 and is "1.2 - Release candidate" since v24.13.1 and v25.4.0 ([registerHooks](https://nodejs.org/docs/latest/api/module.html#moduleregisterhooksoptions)). A resolve hook of about 15 lines was enough. For a relative specifier inside the studio folders, it tries the path, then `.ts`, then `/index.ts`, and copies the parent URL's query onto the child, so a new version query reloads the whole graph. With the parameter properties rewritten, Node's own `.ts` loading did the rest on Node 24.21.0 and 26.8.1, with no load hook. It loaded the engine, 14 rigs, 3 generators, `src/viewer/library.ts` and `iris.ts` in 80 to 91 ms. With the original sources it failed on the parameter properties.

Node's ESM cache can't be cleared either. That has been asked for since at least 2021 ([nodejs/node#38322](https://github.com/nodejs/node/issues/38322), [nodejs/node#49442](https://github.com/nodejs/node/issues/49442)). Reloading the whole graph with a new query took 35 to 39 ms and kept 764 to 894 kB each time. Two ways out:

- Load rig code in a worker thread and replace the worker when files change. A fresh worker that loaded the graph and validated `bear-test` took a median of 285 ms, from 238 to 447 ms, and its memory goes when it ends. It also means a rig that loops forever at import time hangs a worker that the server can terminate, not the server.
- Use deep-hash queries in the Node hook as well, so an edit reloads only what changed.

### Pitfalls

- Type imports without `type` become runtime errors. `verbatimModuleSyntax` catches them at type-check time, and the repo is clean.
- Non-erasable syntax fails at load. Turn on `erasableSyntaxOnly` so `npm run typecheck` fails first, and have the server report the file, line and column.
- A failed module fetch hides its reason. Chromium reported only "Failed to fetch dynamically imported module: http://127.0.0.1:5301/m/src/engine/index". The server should answer a strip or resolve error with a module that throws the message, or push the error over the studio WebSocket.
- A module served under two URLs runs twice. Rewrite every import to one canonical URL.
- The viewer's bundle and the served files each have their own copy of shared code such as `parts/params.ts`. It's harmless today, per section 1. The rig rules in `docs/SCENES.md` should say that rigs must not depend on sharing module state or class identity with the viewer.
- `export * from`, `export { x } from` and inline `type` specifiers all came through es-module-lexer's rewrite correctly, for example in `src/audio/index.ts`. es-module-lexer 3 changed its API. `init` is a function, and imports carry `specifier`, `start`, `end` and `type`.
- Project rigs import `../../../src/rigs/parts/params`. In the packaged app, projects live in the user's folder, not next to `src/`, so that path points nowhere. The shared parts need a stable specifier that the module service, the Node hook, Rolldown's `resolve.alias`, Vite's alias in dev and `tsconfig` `paths` all map. This applies to every option here, Vite included.
- The service runs agent-written code from disk in the page and in Node. It must bind `127.0.0.1`, serve only the rig and generator folders, reject `..`, and take the studio server's pairing token. `import()` can't send headers, so the token has to travel in a cookie or the URL.

## 4. Option C: esbuild, or Rolldown without Vite

### esbuild

esbuild 0.28.2 ships one native binary per platform through optional `@esbuild/*` packages: 10.6 MB on darwin-arm64, 11.7 MB on win32-x64 and 11.4 MB on linux-x64, or 4.3 MB gzipped on darwin-arm64. esbuild-wasm is 14.2 MB for every platform, 3.7 MB gzipped. esbuild's docs say "The WebAssembly version is much, much slower than the native version. In many cases it is an order of magnitude (i.e. 10x) slower" ([getting started](https://esbuild.github.io/getting-started/)). The native package runs its binary as a child process, so the binary has to sit outside `app.asar`.

The embed build ports easily: `stdin` for the entry, `bundle`, `format: 'iife'`, `globalName`, `minify` and `target: 'es2022'`. One gap is the description stripping. esbuild has no AST API, so `stripDescriptions` needs its own parser. I used acorn, 0.57 MB, inside an `onLoad` plugin that transforms TypeScript first. The outputs rendered identical pixels and came out 0.9% larger than Vite's raw and 2.8 to 3.1% larger gzipped. The bundle step took 12 to 28 ms warm, or 82 to 153 ms with esbuild-wasm. It is a second toolchain next to the Oxc and Rolldown pair that dev and `npm run build` use.

### Rolldown on its own

`rolldown` 1.2.11 exports `rolldown()` and `build()`, and `rolldown/utils` exports `transform`, `transformSync`, `parse`, `minify` and `minifySync`. `rolldown/parseAst` exports the same `parseAst` that `tools/bundle/embed.ts` imports through Vite. The package plus its darwin-arm64 binding, `@oxc-project/types` and `@rolldown/pluginutils` is 17.1 MB. The binding is 16.4 MB on darwin-arm64, 20.8 MB on win32-x64 and 19.1 MB on linux-x64-gnu, per npm.

Porting the embed build meant one plugin change. Vite's `enforce: 'post'` ran after its TypeScript transform, and raw Rolldown hands plugins TypeScript. So the plugin calls `transformSync(id, code, { lang: 'ts', target: 'es2022' })`, runs `stripDescriptions` on the JavaScript and returns `moduleType: 'js'`. The output kept `/* @__PURE__ */` comments and used `let` where Vite emitted `var`, and still came out 46 bytes smaller on `bear-test`. Output options might close the gap. I didn't try. Every frame matched.

Rolldown also ships a WASI build, `@rolldown/binding-wasm32-wasi`: a 10.9 MB `.wasm`, 3.5 MB gzipped, plus 3 MB of runtime packages. Rolldown's docs say to force it with `NAPI_RS_FORCE_WASI=error` ([getting started](https://rolldown.rs/guide/getting-started)). With the native binding removed, it ran under Electron's Node, warned "WASI is an experimental feature", and built all four embeds byte-identical to native Rolldown. It took 160 to 1,124 ms per embed, against 16 to 382 ms native.

## 5. Other options

- **Precompiled JavaScript only.** Agents would write `.js` rigs with JSDoc types, or the app would compile TypeScript into a cache folder on save. The first gives up the TypeScript every rig in the repo uses. The second is the module service with files in the middle. Both still need cache busting and a bundler for the embed.
- **SWC.** `@swc/wasm-typescript` is 3.7 MB and is the strip-only transform that amaro wraps, and Node already contains amaro. `@swc/core-darwin-arm64` is 26.6 MB. Neither adds anything here.
- **Sucrase**, 1.1 MB of plain JavaScript, strips types and keeps line numbers. It could run in a browser tab. I didn't test it.
- **Standalone Oxc packages.** `oxc-transform` with its darwin-arm64 binding is 3.5 MB, `oxc-parser` 1.8 MB, `oxc-minify` 3.4 MB. They have no bundler, so they don't cover the embed.
- **`@rolldown/browser`**, 12.2 MB, bundles inside a page. It could let a web app with no backend export embeds. I didn't test it.
- **Transforming in the renderer** with a service worker or blob URLs. Blob URLs can't resolve relative imports, and the studio server needs the modules in Node anyway, so this adds work for nothing.

## 6. Importing modules in Electron's renderer

I loaded a harness page in a hidden Electron 44 window. It imported the engine, rigs, audio, `library.ts` and `surfaces.ts` and rendered frames. I ran it from each kind of page against two servers, one without CORS headers and one sending `Access-Control-Allow-Origin: *`.

| Page | Module server | Result |
| --- | --- | --- |
| `http://127.0.0.1:<port>`, the server's own origin | same origin | Works |
| Same, with CSP `script-src 'self' 'unsafe-inline'` | same origin | Works |
| `file://` | no CORS headers | Works |
| `file://` | CORS `*` | Works |
| `app://`, registered `standard`, `secure`, `supportFetchAPI`, `corsEnabled` | no CORS headers | Fails: "Failed to fetch dynamically imported module" |
| `app://` | CORS `*` | Works |
| `app://` with CSP `script-src 'self' 'unsafe-inline'` | CORS `*` | Fails: the load "violates the following Content Security Policy directive" |
| `app://` with CSP listing `http://127.0.0.1:5303` in `script-src` and `connect-src` | CORS `*` | Works |

The HTML standard fetches module scripts with mode `"cors"` ([fetch a single module script](https://html.spec.whatwg.org/multipage/webappapis.html#fetch-a-single-module-script)), which is why `app://` needs the header. `file://` passes without it because Electron's `grantFileProtocolExtraPrivileges` fuse, on by default, gives `file://` pages "privileges beyond what they would receive in a traditional web browser", cross-origin fetch among them ([fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)). Electron's checklist item 18 is "Avoid usage of the `file://` protocol and prefer usage of custom protocols", and item 7 is "Define a Content Security Policy" ([security](https://www.electronjs.org/docs/latest/tutorial/security)). A secure `app://` page loading `http://127.0.0.1` raised no mixed-content error, as expected for a loopback address, which Secure Contexts counts as potentially trustworthy ([is origin potentially trustworthy](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)).

ADR 0001 already has the renderer connect to the studio server "like any browser". Serving the built viewer from the studio server gives the page the same origin as the modules. Then the page needs no CORS headers, a CSP of `script-src 'self'` covers everything, and there is no port to write into the CSP at run time. The web app works the same way.

Dynamic `import()` with a changed query or hash reloads a module. Immutable caching headers are safe with deep-hash URLs, because a URL's content never changes.

## 7. Reloading and the library

`app.setLibrary()` already swaps a new library in place. For M10 it only needs a new trigger. The viewer re-imports the entry URLs the server lists, rebuilds the registries, calls `buildLibrary` and passes the result to `setLibrary`. In the harness, `buildLibrary` took 3 to 5 ms over every scene and project in the repo. Importing the whole graph cold took 43 to 254 ms through the strip server, depending on how busy the machine was, and 584 ms through the Oxc server on its first request, which included transforming every file. So rebuilding the whole library on each change is cheap enough, and nothing finer is worth building.

Keeping object identity matters for audio. `sameGenerators` in `src/audio/render.ts` compares generators with `===`, and the viewer re-renders a scene's sound when that check fails. Deep-hash URLs keep every unchanged generator the same object, so editing a rig doesn't re-render audio. A global generation would re-render it on every edit. Editing `parts/params.ts` still changes every generator, which is correct.

The module map keeps growing, whichever scheme is used. With deep hashes, a session of 200 edits to `parts/math.ts` would hold about 100 MB of old modules, and 200 edits to a leaf rig about 1 MB. The viewer can reload the page past a threshold. `prepareForReload()` already keeps the scene, frame and play state across reloads.

## 8. Where the studio server runs in Electron

- `utilityProcess.fork` ran an `.mjs` entry with `execArgv: ['--expose-gc']`. Inside it, the `registerHooks` loader and the whole Vite embed build both worked. The utility process stayed alive after its script finished until the script called `process.exit`. Electron's docs describe it as "a child process with Node.js and Message ports enabled", the equivalent of `child_process.fork` through Chromium's Services API ([utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)).
- Turning off the `runAsNode` fuse makes `child_process.fork` throw, and the docs point to utility processes instead ([fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)). Turning it off also protects the app from an inherited `ELECTRON_RUN_AS_NODE=1`. This machine's shell had exactly that set, and with it any Electron app launched from that shell starts as plain Node.
- Native modules loaded through `process.dlopen` can't load from inside `app.asar` without extraction, and "all Node APIs that can modify files will not work" there ([asar archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)). Rolldown's binding should be unpacked. Rolldown reads source files with its own Rust code, not Node's patched `fs`, so the engine, player, built-in rigs and generators it bundles into embeds should ship as plain files too, for example under `Resources/`. I didn't test Rolldown against an asar.

## 9. Sizes

Measured with `du` for darwin-arm64 unless marked npm, which is the registry's `unpackedSize`.

| What ships | Unpacked | Gzipped |
| --- | --- | --- |
| Electron 44.4.5, for scale | 330 MB | 128.1 MB |
| Vite 8.3.0 and its 14 dependencies | 29.9 MB | 11.3 MB |
| Vite without lightningcss and postcss, unsupported | 20.1 MB | |
| Rolldown 1.2.11 with its darwin-arm64 binding | 17.1 MB | 6.9 MB for the binding |
| Rolldown binding, win32-x64 and linux-x64-gnu, npm | 20.8 MB, 19.1 MB | |
| Rolldown WASI binding and its runtime, plus 1 MB of Rolldown JS | 13.8 MB | 3.5 MB for the `.wasm` |
| esbuild 0.28.2 with its darwin-arm64 binary | 10.6 MB | 4.3 MB for the binary |
| esbuild-wasm 0.28.2 | 14.2 MB | 3.7 MB for the `.wasm` |
| Node's type stripping, already inside Electron | 0 | 0 |
| es-module-lexer 3.0.2 | 0.25 MB | |
| acorn 8.18.0, only needed with esbuild | 0.57 MB | |

The recommendation adds about 17.4 MB unpacked and 7 MB compressed to the darwin-arm64 app.

## Experiments

### Setup

- `rsync` of the repo to `/tmp/rt-repo` without `.git`, `node_modules` or `.scratch`, with `node_modules` linked to a fresh `npm i vite@8.3.0`. A second copy, `/tmp/rt-repo2`, had the three constructors rewritten without parameter properties.
- `npm i electron@44` resolved to 44.4.5. Its postinstall didn't download the binary until I ran `node node_modules/electron/install.js` with `ELECTRON_RUN_AS_NODE` unset.
- A prototype module server, `/tmp/rt-b/server.mjs`, 119 lines, ran under `ELECTRON_RUN_AS_NODE=1`. It handles strip mode with a transform fallback on Node 24, an optional Rolldown `transformSync` mode, es-module-lexer rewriting with generation or deep-hash URLs, path-generation routes, a modification-time cache, `fs.watch` with `recursive: true`, and an allowlist. Instances ran on ports 5301 to 5307 with different settings, next to a Vite 8.3.0 middleware server on 5302 serving the same harness.
- The harness page imported `src/engine/index.ts`, `src/rigs/index.ts`, `src/audio/index.ts`, `src/viewer/library.ts`, `src/embed/surfaces.ts` and the project rigs. It built the library as `scenes.ts` does and rendered with `render(ctx, scene, frame, registry, { ...world, surfaces })` on a canvas with `willReadFrequently: true` and `colorSpace: 'srgb'`. It hashed `getImageData` with SHA-256. Electron ran with `--disable-accelerated-2d-canvas`.
- The embed variants used the repo's `buildEmbed` with `bundle()` swapped for Rolldown's JS API, esbuild or esbuild-wasm. Each variant ran the same description stripping, and I checked that the output had no description strings. The embeds were loaded in hidden windows, sought with `window.studio.seek(n)`, and their canvases hashed.

### Pixel parity

| Scenes and frames | Compared | Result |
| --- | --- | --- |
| `bear-test` 0, 17, 48, 95; `bears-gouache` 0; `bears-story/film` 0, 30, 60, 100, 143; `audio-test` 0, 60, 119 | Embeds from Vite, Rolldown, esbuild, esbuild-wasm | Identical in 4 runs. In the first run, frame 60 of the first page loaded differed once and never again. I put that down to the harness. |
| `audio-test` 0, 15, 30, 45, 60, 90, 119 | Same four embeds | Identical |
| 8 scenes, 20 frames: the four bear studies, `film`, `together`, `shapes-test`, `hello` | Strip server, Rolldown Oxc server, Vite dev server | Identical |
| Same 20 frames | Strip-only server on the rewritten copy, Vite on the original | Identical |
| `bear-test`, `film`, `bears-gouache` | Served modules against the embeds | Same hashes |

### Reload and memory in the renderer

| Case | Reload time | Heap kept |
| --- | --- | --- |
| Same generation re-imported 100 times, the control | | 2.0 to 2.2 MB in total |
| Whole graph re-imported at a new generation, 200 times | 33 to 48 ms | 0.95 MB each |
| Deep hash, 100 edits to `projects/bears-story/rigs/iris.ts` | 4 ms median | 6 kB each |
| Deep hash, 50 edits to `src/rigs/bear.ts` | 8 ms median | 120 kB each |
| Deep hash, 50 edits to `src/rigs/parts/math.ts` | 21 ms median | 513 kB each |
| Vite `ssrLoadModule` after `invalidateAll()`, in Node, 100 times | 297 ms | 8 kB each |
| Native ESM with `registerHooks`, whole graph, 100 times, Node in Electron | 35 ms | 764 kB each |
| Same inside `utilityProcess` | 39 ms | 894 kB each |
| New worker thread per reload, 20 times | 285 ms median | freed with the worker |

### Embed builds

Script bytes and gzipped bytes per bundler. Warm build times reuse one module server and run only the bundle step, as a median of 5 on Node 26.

| Scene | Vite | Rolldown alone | esbuild | esbuild-wasm |
| --- | --- | --- | --- | --- |
| `bear-test` | 63,806 / 23,909, 35 ms | 63,760 / 23,857, 34 ms | 64,357 / 24,571, 26 ms | same as esbuild, 124 ms |
| `bears-gouache` | 44,299 / 16,798, 24 ms | 44,275 / 16,776, 19 ms | 44,702 / 17,214, 17 ms | same, 82 ms |
| `bears-story/film` | 71,376 / 26,558, 41 ms | 71,376 / 26,477, 38 ms | 71,964 / 27,310, 28 ms | same, 153 ms |
| `audio-test` | 31,901 / 12,263, 20 ms | 31,909 / 12,241, 17 ms | 32,224 / 12,438, 12 ms | same, 87 ms |

The engine and player alone came to 16,011 bytes minified, the same under Node 26 and Electron's Node.

## Recommendation for M10

1. **Keep Vite out of the app.** Ship `rolldown` with its per-platform binding, unpacked from `app.asar`, plus `es-module-lexer`. Keep the WASI binding in mind as a fallback for a platform without a working native binding. It gave byte-identical embeds at 3 to 10 times the time.
2. **Give shared parts a stable specifier.** Project rigs and studio-folder rigs must stop importing `../../../src/rigs/parts/...`. Pick one bare prefix and map it in `tsconfig` `paths`, Vite's `resolve.alias` for dev, the module service, the Node resolve hook and Rolldown's `resolve.alias`. Move `iris.ts` to it and update the rig guide in `docs/SCENES.md`.
3. **Make runtime TypeScript erasable.** Rewrite the three parameter-property constructors, and turn on `erasableSyntaxOnly` and `verbatimModuleSyntax` for `src/engine`, `src/rigs`, `src/audio`, `src/embed`, `src/viewer/library.ts` and project rigs. Add the rule to the rig rules. It holds on Node 24 and 26 alike and needs no transform code of ours.
4. **Build the module service in the studio server.** It serves the app's built-in rigs and generators read-only, plus the studio folder's `rigs/` and each project's `rigs/`. It strips with `stripTypeScriptTypes`, rewrites imports with es-module-lexer to canonical deep-hash URLs, hashing cycles as a unit, and caches by modification time. It answers an error with a module that throws a message naming the file, line and column. It sends immutable caching headers, allows only its folders, and checks the pairing token. A file watcher pushes "modules changed" over the studio WebSocket that ADR 0001 already plans. Mount the same code in the Vite dev plugin, so `npm run dev` exercises the path the app ships. The prototype suggests a few hundred lines.
5. **Load rigs in the viewer from the service, in dev and in the app.** Replace the rig and generator half of `src/viewer/scenes.ts` with a loader that fetches the list of entry modules, imports them, builds registries, and calls `buildLibrary` and `setLibrary` on every push. Scene files come from the file-backed scene store that ADR 0001 already requires. Reload the page past a memory threshold through `prepareForReload()`. Serve the built viewer from the studio server's origin with CSP `script-src 'self'`.
6. **Load rigs in Node through a rig host.** Run a worker thread that registers the resolve hook: extensionless paths, `index.ts`, the shared-parts prefix, and version queries inherited by children. It loads `.ts` files with Node's own stripping and answers `list_rigs`, validation and registry questions for the MCP workspace and the embed builder. Replace it when files change, and terminate it if it stops answering. This retires `ssrLoadModule` from `tools/scene-files.ts`, and the CLI can use the same host.
7. **Port the embed to Rolldown's API.** Keep `entryPlugin`. Make `stripDescriptions` run `transformSync` before `parseAst`. Get the rig definitions from the rig host, and call `rolldown()` then `generate({ format: 'iife', name: 'frameStudioEmbed', minify: true })`. Tune output options to drop the `/* @__PURE__ */` comments, then check sizes against today's and re-run the embed pixel tests.
8. **Run the studio server in a `utilityProcess`.** Turn off the `runAsNode` fuse, unless the external agent's stdio MCP server has to run through `ELECTRON_RUN_AS_NODE`. See the open questions. Ship the engine, player and built-in rig sources as plain files, since Rolldown reads them from disk.
9. **Test the path the app runs.** Add a parity test that renders frames through served modules and compares them with an embed of the same scene. Add a reload test: edit a leaf part, check the pixels change, revert, check they return. Put a heap budget on repeated reloads, and make `npm run typecheck` fail on non-erasable syntax.

## Open questions

- Which specifier should shared parts use, and should the studio folder get a `tsconfig.json` and `.d.ts` files, so an agent can type-check rigs without the repo?
- Built-in rigs ship read-only in the app. When an agent wants to change `bear`, should it copy the rig into the studio folder under the same id, a new id, or a variant? The registry also needs a precedence rule for the app, studio-folder and project scopes.
- Does the external agent's MCP server run as a stdio child through `ELECTRON_RUN_AS_NODE`, or connect to the studio server's MCP over HTTP (`tools/studio/mcp-http.ts`)? The first keeps the `runAsNode` fuse on.
- Should the viewer keep the built-in rigs in its bundle for a fast first paint, or load everything through the service so there is only one path?
- How big an edit history should one page hold before it reloads itself?

## Not verified

- Windows and Linux. `fs.watch` with `recursive: true` worked on macOS only here. Rolldown's Windows and Linux bindings, utility processes and CSP behaviour there come from docs and npm.
- Rolldown reading from inside `app.asar`. I assume its Rust code can't, since Electron patches only Node's `fs`.
- Signing and notarizing a macOS app that contains Rolldown's `.node` binding. The first native Rolldown load in one fresh process took 1.4 s, and later loads took 8 to 178 ms. I didn't find the cause, and a first-launch scan by macOS is a guess.
- Option A's variant with Vite's HMR client served into the prebuilt viewer.
- Output options that would make Rolldown alone byte-identical to Vite's library build.
- Sucrase, `@rolldown/browser`, and `stripTypeScriptTypes` speed on large generated rigs.
- The one-off mismatch on the first embed page of the first run. Four later runs, in two load orders, matched on every frame.
- Timing numbers are from a busy laptop with other Electron processes open, and cold numbers varied by up to 5 times between runs. The ratios held.

## Sources

- Node.js 26.10.0 docs, TypeScript and type stripping: https://nodejs.org/docs/latest/api/typescript.html
- Node.js 26.10.0 docs, `module.stripTypeScriptTypes` and `module.registerHooks`: https://nodejs.org/docs/latest/api/module.html
- Node.js 24.21.0 docs, `module` with the `transform` mode: https://nodejs.org/docs/latest-v24.x/api/module.html
- Node.js issues on clearing the ESM cache: https://github.com/nodejs/node/issues/38322, https://github.com/nodejs/node/issues/49442
- HTML Standard, module map, fetch a single module script, resolve a URL-like module specifier: https://html.spec.whatwg.org/multipage/webappapis.html#module-map, https://html.spec.whatwg.org/multipage/webappapis.html#fetch-a-single-module-script, https://html.spec.whatwg.org/multipage/webappapis.html#resolving-a-url-like-module-specifier
- Secure Contexts, is origin potentially trustworthy: https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy
- Electron docs, fuses, security checklist, utilityProcess, ASAR archives, protocol: https://www.electronjs.org/docs/latest/tutorial/fuses, https://www.electronjs.org/docs/latest/tutorial/security, https://www.electronjs.org/docs/latest/api/utility-process, https://www.electronjs.org/docs/latest/tutorial/asar-archives, https://www.electronjs.org/docs/latest/api/protocol
- Vite 8 announcement, server options and `oxc` option: https://vite.dev/blog/announcing-vite8, https://vite.dev/config/server-options, https://vite.dev/config/shared-options
- Vite 8.3.0 source as shipped in `vite/dist/node/chunks/node.js`: the middleware WebSocket default on port 24678, `lastHMRTimestamp` and `t=` in import analysis, and the bundled es-module-lexer. HMR re-imports in `vite/dist/client/client.mjs`.
- Rolldown, getting started, with the WASM build and `NAPI_RS_FORCE_WASI`: https://rolldown.rs/guide/getting-started. The `rolldown` 1.2.11 package exports `.`, `./utils`, `./parseAst` and `./experimental`.
- esbuild, getting started, with platform packages and esbuild-wasm speed: https://esbuild.github.io/getting-started/
- TypeScript 5.8 release notes, `--erasableSyntaxOnly`: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html
- es-module-lexer: https://github.com/guybedford/es-module-lexer
- npm registry `unpackedSize` for `@rolldown/binding-*`, `@esbuild/*`, `esbuild-wasm`, `@rolldown/binding-wasm32-wasi`, `@rolldown/browser`, `oxc-transform`, `oxc-parser`, `oxc-minify`, `@swc/wasm-typescript`, `@swc/core-darwin-arm64`, `sucrase`, `amaro`, `acorn` and `es-module-lexer`, read 2026-09-25: https://www.npmjs.com/
