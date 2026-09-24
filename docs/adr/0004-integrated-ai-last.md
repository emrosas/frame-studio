# 0004: An integrated AI, built last

Status: accepted, 2026-09-24 (ticket 10)

## Context

The studio is meant to be driven by an AI. Today that AI is a coding agent the user runs next to the studio, which reaches it through MCP (M5). The user wants the finished product to include an AI inside the studio. It would connect to Claude, ChatGPT or other models, through the user's existing subscription or their own API key (BYOK). The studio provides the interface; it is not an AI provider.

## Decision

- The integrated AI is part of the final experience, but it is polish rather than core. It gets its own milestone after M7, so the complete creation loop can be tested first: MCP, an external agent, and exports by hand.
- It reads the same request files as the external agent (ADR 0003), and its tool loop calls the same operations the MCP server offers. Nothing built before it may assume that the only consumer is an external agent.
- T3 Code (github.com/pingdotgg/t3code, MIT) is the reference for connecting providers. It spawns the user's installed CLIs, such as the Claude Agent SDK pointed at the user's `claude`, and `codex app-server`. Sign-in stays with those CLIs, and separate config directories or environment variables hold second accounts and API keys.

## Consequences

- The MCP tool implementations (`tools/mcp/workspace.ts`) have to run where the integrated AI runs. That's the Electron main process or the standalone studio server (ADR 0001), and the backend for the web app.
- Streaming progress into the viewer, left out of the external-agent handoff, comes naturally with the integrated AI.
- Ticket 16 in `.scratch/frame-studio/` specifies the milestone.
