# What does the integrated AI need to do?

Type: grilling
Status: open
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
