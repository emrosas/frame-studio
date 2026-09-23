# 0001: Ship as a web app and as an Electron app

Status: accepted, 2026-09-23

## Context

The studio runs today as a Vite dev server. The user wants to ship it, and it has to work in two shells. One is a web app in any browser tab. The other is an Electron desktop app. The single-file HTML embed is a separate output with its own rules, and nothing here changes it.

Electron pins one Chromium, so preview and export can share a rasterizer. A browser tab can be Chrome, Safari or Firefox, and each draws canvas paths a little differently.

## Decision

One viewer codebase serves both shells.

- `src/viewer` uses web platform APIs only. It never imports Electron, Node built-ins or anything that needs a local process.
- Anything that needs the machine sits behind an interface with a web implementation and an Electron implementation. That covers reading and writing scenes, writing exports, encoding video, and connecting to the agent's MCP server.
- Electron-only code lives in its own entry point, the main and preload scripts, when the shell is built. The viewer asks the interface, not Electron.

## Consequences

- Local files come first. Scenes, references and exports live as files on the user's disk, read and written by the dev server now and by Electron later. The web app gets a backend to hold them later. The user decided on 2026-09-23 to get the local path working before building that backend. Loading scenes through `import.meta.glob` and Vite's hot reload stays a dev workflow, so the Electron build still needs its own file-backed scene store.
- Exports cannot assume ffmpeg or Playwright. Ticket 14 finds an encoder path that works in a tab, in Electron and from the CLI, and M3 waits on it.
- The pixel-for-pixel guarantees hold within one Chromium. In the web app, an export drawn in the user's tab matches that user's preview. An export rendered elsewhere, such as a future cloud render in Chromium, can differ slightly from a Safari or Firefox preview.
- The MCP agent runs on the user's machine. The Electron app can talk to it directly. The web app needs a bridge, or the hosted service, to reach it. That stays open until M5.
