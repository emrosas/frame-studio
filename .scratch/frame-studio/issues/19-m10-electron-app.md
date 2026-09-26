# M10: Electron app

Type: task
Status: resolved
Blocked by: 20

## Work

Build the Electron shell from `docs/adr/0001-web-and-electron-targets.md`, as `docs/ROADMAP.md` outlines under M10. Its file-backed scene store reads the project layout M9 builds (ADR 0007). Settle its acceptance criteria before building.

Requirement from the user (2026-09-25): the installed app must not include the Claude Agent SDK's bundled Claude binary. The SDK's optional platform packages (`@anthropic-ai/claude-agent-sdk-<platform>`, about 220 MB each) are dead weight, since the studio always points the SDK at the user's installed `claude`. Exclude them from the packaged app the way T3 Code does in `scripts/build-desktop-artifact.ts`, with `!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*`, and check the built installer's size and contents for them.

## Settled (2026-09-26)

The grill settled the design as ADR 0008 (`docs/adr/0008-desktop-app-and-studio-folders.md`), and the acceptance criteria are in `docs/ROADMAP.md` under M10. The user asked for the build to go ahead on sensible defaults, with an overview at the end to review.

## Outcome

Built on 2026-09-26, and the nine acceptance criteria pass. `docs/PROGRESS.md`, "M10: Electron app", has the detail and the defaults picked for your review.

- **The studio server** is standalone. It serves the viewer and pairs callers. Rigs load through its module service, renders come from its render worker in Electron, and viewers export from a panel.
- **The app** runs on studio folders, with the server in a utility process. `npm run desktop:build` makes an unsigned macOS arm64 app, 262 MB, and a DMG, 124 MB. Nothing of the Claude Agent SDK's binary is inside, and a check enforces it.
- **External agents** use `frame-studio-mcp`, a shim that reuses the app's server or starts a headless one.
- **Reviews:** two agents reviewed M10. Their 23 fixes include recovering render jobs whose worker died, a viewer that survives a broken rig, and a dev server that no longer serves its own token.
