# 0006: Requests are threads, and the integrated AI works them locally

Status: accepted, 2026-09-25 (ticket 16). Amends ADR 0003, where a request was one ask with one checkpoint.

## Context

M8 puts an AI inside the studio (ADR 0004). The user wants it to work like a chat in T3 Code: you ask, the agent works, you reply until the result is right, and then you mark it settled. ADR 0003's requests were one-shot. An agent completed a request with a summary, and a follow-up meant a new request.

The provider research (`.scratch/frame-studio/research/integrated-ai-providers.md`) found that a subscription can only be used by launching the user's own signed-in CLI on their machine. Anthropic's policy page says a claude.ai login offered inside a third-party app needs Anthropic's approval, and so does routing requests through a user's plan. Starting the user's unmodified, signed-in `claude` is allowed. A hosted backend can only use API keys.

## Decision

- **Local only.** The AI runs in the studio server: the Vite plugin now, and later the process Electron starts (ADR 0001). The web app gets it with its backend, API keys only, later.
- **A request is a thread.** It moves from pending to working to **your turn** when the agent finishes a reply. Your reply sends it back to working, and **settled** is when you close it. Only you settle a thread, and replying to a settled thread reopens it. A turn that fails or is stopped leaves the thread open, with Retry. Clear finished archives settled threads.
- **A checkpoint per turn.** Each agent turn snapshots the scene when it starts. "Revert to here" on a turn restores that snapshot, and the thread continues from there. Revert on a settled thread undoes all of it. ADR 0003's time-based rule still applies to each turn: a revert never throws away another thread's later work.
- **One working thread per scene.** Threads on different scenes run in parallel, and a thread waits while another thread's turn on its scene is working. Before a thread edits a rig used by another working thread's scene, it asks.
- **Any agent, one contract.** The request file holds the whole thread. The external agent works threads through the same MCP tools: `next_request` and `get_request` return the conversation, and `complete_request` ends a turn. The integrated AI reads and writes the same files.
- **Providers.** Claude, through Anthropic's Agent SDK pointed at the user's installed `claude`, and Codex, through `codex app-server`. The studio shows no login screen and never handles tokens. A missing or signed-out CLI shows as unavailable, with the command to run. API keys work through either CLI. The SDK is a dev-only package, never in the runtime or the embed. The feature is described as working with your installed Claude, never as using your Claude plan, and never as Claude Code.
- **Per-thread settings.** The agent is fixed for the life of a thread. Model, effort and access mode can change between turns. Access defaults to studio tools on every new thread. Each turn shows its token use when the provider reports it.
- **Access.** By default the agent may use the studio's operations (the MCP tools) and write files in `scenes/`, `src/rigs/` and `src/audio/`. Anything else, including other files, shell commands and the network, shows an approval card in the thread first. A full-access switch turns the prompts off.
- **Progress.** The thread streams the agent's text, one line per step, and the frames it rendered, as thumbnails. Transcripts and thumbnails live in `.frame-studio/` next to the request, so restarting the studio loses nothing.
- **Stop and restarts.** Stop keeps the edits made so far and hands the thread back. If the studio server stops mid-turn, the turn shows as interrupted, with Retry. The thread file keeps each provider's session id, so the next reply resumes the session.
- **Layout.** The thread list moves to a panel on the left, and a thread opens in place with a back arrow. The canvas stays in the middle.

## Consequences

- The request file format changes, and the viewer, the queue, the MCP tools and the tests move with it. Requests already on disk stay readable as one-turn threads.
- A second provider from the start keeps the adapter interface honest. Cursor, OpenCode or Gemini CLI can slot in later, the way T3 Code has six.
- Automated tests use a scripted fake provider, so they need no sign-in and cost nothing. Real Claude and Codex are checked by hand.
- The web app's AI still needs its own tool loop over the Anthropic and OpenAI APIs, with the user's keys, when its backend arrives.
- Found while building it (M8):
  - Codex asks before each MCP tool call through an elicitation request. The adapter allows the studio's own tools there, since the studio's tool hooks apply the access rules to them, and sends other servers' tools through the rules.
  - With full access, Codex applies edits without asking anything. So its only check against editing a rig another busy scene draws with is the studio tools' scene rule. Claude asks through `canUseTool` in both modes, so it gets the check.
  - Tools that start Vite (the render CLI, the MCP server's workspace, the embed builder) start it with agents off. Otherwise each would claim threads, and a tool that exits would leave turns interrupted.
  - Claude gets the studio tools as an in-process MCP server through the Agent SDK. Codex reaches them over HTTP with a per-turn token in its environment. An HTTP config for Claude would have put the token on the `claude` command line, where other users of the machine can see it.
  - The studio server answers only this computer. Once it could start agents, a request from another host, when Vite listened on the network, could run a full-access agent. Programs on this computer stay trusted, as they are by the dev server as a whole. The standalone server of M9 brings pairing.
  - The access rules keep a well-meaning agent inside the lines; they aren't a sandbox. Rig and generator code runs in the studio server and the browser.
