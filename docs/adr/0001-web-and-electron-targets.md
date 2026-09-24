# 0001: Ship as a web app and as an Electron app

Status: accepted, 2026-09-23. Amended 2026-09-24: machine access goes through one local studio server, not separate web and Electron implementations (ticket 10).

## Context

The studio runs today as a Vite dev server. The user wants to ship it, and it has to work in two shells. One is a web app in any browser tab. The other is an Electron desktop app. The single-file HTML embed is a separate output with its own rules, and nothing here changes it.

Electron pins one Chromium, so preview and export can share a rasterizer. A browser tab can be Chrome, Safari or Firefox, and each draws canvas paths a little differently.

## Decision

One viewer codebase serves both shells.

- `src/viewer` uses web platform APIs only. It never imports Electron, Node built-ins or anything that needs a local process.
- Anything that needs the machine goes through one **studio server** protocol: HTTP endpoints, with a WebSocket for pushed changes. That covers reading and writing scenes, the request queue and reference uploads (ADR 0003), and writing exports. Video encoding is not on the list, since it happens in the page (ticket 14).
- The same protocol runs everywhere. A Vite dev-server plugin serves it now, on the dev server's own origin. Later its code becomes a standalone Node server, which the Electron app starts as a child process, passing the page its address. The web backend serves the same protocol. The request and message types live in one module that the server and the viewer share.
- Electron-only code lives in its own entry point, the main and preload scripts. IPC carries only native features and the studio server's address. The app's own data never goes through it.

T3 Code's Electron app works this way (github.com/pingdotgg/t3code, MIT). It runs one local Node server behind one WebSocket protocol for its web UI and its desktop shell. Electron spawns that server as a child process and hands the renderer its URL and a token, and the renderer then connects like any browser. The user chose this on 2026-09-24 over keeping a separate IPC implementation.

## Consequences

- Local files come first. Scenes, references and exports live as files on the user's disk, read and written by the dev server now and by Electron later. The web app gets a backend to hold them later. The user decided on 2026-09-23 to get the local path working before building that backend. Loading scenes through `import.meta.glob` and Vite's hot reload stays a dev workflow, so the Electron build still needs its own file-backed scene store.
- Exports cannot assume ffmpeg or Playwright. Ticket 14 finds an encoder path that works in a tab, in Electron and from the CLI, and M3 waits on it.
- The pixel-for-pixel guarantees hold within one Chromium. In the web app, an export drawn in the user's tab matches that user's preview. An export rendered elsewhere, such as a future cloud render in Chromium, can differ slightly from a Safari or Firefox preview.
- The MCP agent runs on the user's machine and talks only to files (ADR 0003), so it never has to find the studio server. The web app can't reach a local agent. Its route is the integrated AI (ADR 0004), or the hosted service.
- The dev plugin listens only on localhost and has no auth. The standalone server gets auth when it arrives, with T3 Code's one-time pairing token as the model.
