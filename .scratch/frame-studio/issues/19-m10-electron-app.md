# M10: Electron app

Type: task
Status: open
Blocked by: 20

## Work

Build the Electron shell from `docs/adr/0001-web-and-electron-targets.md`, as `docs/ROADMAP.md` outlines under M10. Its file-backed scene store reads the project layout M9 builds (ADR 0007). Settle its acceptance criteria before building.

Requirement from the user (2026-09-25): the installed app must not include the Claude Agent SDK's bundled Claude binary. The SDK's optional platform packages (`@anthropic-ai/claude-agent-sdk-<platform>`, about 220 MB each) are dead weight, since the studio always points the SDK at the user's installed `claude`. Exclude them from the packaged app the way T3 Code does in `scripts/build-desktop-artifact.ts`, with `!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*`, and check the built installer's size and contents for them.

