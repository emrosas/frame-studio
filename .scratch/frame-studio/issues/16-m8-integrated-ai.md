# What does the integrated AI need to do?

Type: grilling
Status: resolved
Blocked by: 12

## Question

M8 puts an AI inside the studio. It connects to Claude, ChatGPT or other models through the user's subscription or their own API key (`docs/adr/0004-integrated-ai-last.md`). Settle its scope and acceptance before building it:

- which providers it supports first, and how sign-in works
- where it runs in the web app and in Electron
- how its chat relates to the request queue (ADR 0003)
- how it streams progress into the viewer
- what it may do without asking

T3 Code (github.com/pingdotgg/t3code) is the reference for providers and subscriptions. Its apps/server provider adapters spawn the user's `claude` through the Claude Agent SDK, and `codex app-server`, and leave sign-in to those CLIs.

## Answer

Settled with the user on 2026-09-25 and recorded in `docs/adr/0006-requests-are-threads.md`, which amends ADR 0003. The provider findings are in `research/integrated-ai-providers.md`. `docs/ROADMAP.md` carries the acceptance criteria, and ticket 18 builds it.

- **Where it runs:** locally, in the studio server. The web app gets it with its backend, API keys only, later.
- **Requests become threads**, like a chat in T3 Code: pending, working, your turn, then settled when you close it. Only you settle, a reply reopens, and a failed or stopped turn leaves the thread open.
- **A checkpoint per turn**, with "Revert to here". Revert on a settled thread undoes all of it.
- **The external agent works threads too**, through the same MCP tools. `complete_request` ends a turn.
- **One working thread per scene.** Different scenes run in parallel.
- **Providers:** Claude through the Agent SDK pointed at the user's installed `claude`, and Codex through `codex app-server`. There's no login screen and no token handling. A missing or signed-out CLI shows the command to run.
- **Per-thread settings:**
  - The agent is fixed per thread.
  - Model, effort and access can change between turns.
  - Access defaults to studio tools.
  - Each turn shows its token use.
- **Access:** by default the studio tools, plus writes in `scenes/`, `src/rigs/` and `src/audio/`. Anything else shows an approval card, and full access is a switch.
- **Progress:** streamed text, one line per step, and frame thumbnails, all kept in `.frame-studio/`.
- **Stop and restarts:** Stop keeps the edits so far. A server restart mid-turn shows Interrupted with Retry, and sessions resume.
- **Layout:** the thread list moves to a left panel, and a thread opens in place.
- **Out of scope:**
  - the web app and its backend
  - the studio's own API loop
  - Electron, now M9
  - Projects, ticket 17
  - other providers
  - a hosted service
- **Checking it:** a scripted fake provider drives the automated tests, plus one real run each with Claude and Codex. Both CLIs are installed and signed in on the dev machine: `codex` 0.156.1 with ChatGPT, and `claude`.

