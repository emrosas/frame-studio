# 0017: Provider keys, Generate Voice, Kokoro and folder trust

Status: accepted, 2026-11-06. Rescopes CLAUDE.md's "never read or store the user's tokens", which stays true of CLI sign-ins. Pasted provider keys are the one exception, encrypted by the app.

## Context

People asked for a Generate Voice button, and it has to stay open and secure. ElevenLabs needs a key, so the app now holds a secret for the first time. Rigs and generators are code: they run in the viewer page and in the studio server process (`tools/studio/code.ts`), and a project folder from someone else brings its own. Those two facts decide everything here.

## Threat model

A key must never reach the viewer page, the server process or the render worker, since a project's rig runs in all three.

This stops git, backups, logs, agents, other accounts on the computer, and a project's rig from reading a key in flight. It doesn't stop a determined malicious program running as the user: such a program can ask the keychain, or drive the app. Use a key with a spending limit. Folder trust narrows how such a program gets in, and is not a sandbox.

## Decision

- **Keys.** `desktop/keys.ts` runs in the Electron main process only. A key is safeStorage ciphertext in `userData/keys.json`, mode 0600. The app refuses to keep one when encryption is unavailable or the Linux backend is `basic_text`. A key is never in prefs, since `frame-studio:boot` hands those to the page, and never in a project, an environment variable, a log, a thread file, a tool result or the render worker.
- **Entry.** A main-owned window with its own page and preload, `desktop/key-window.html`, never the viewer. It advises a capped key. Its record has room for a base URL later.
- **Generating.** The viewer asks over the bridge. Main checks `event.senderFrame` is the viewer window's main frame, then shows a native dialog with the text, provider, voice and estimated price. On Generate, main decrypts, calls the provider's pinned host, writes into the project's `media/` under a name it picks, and drops its reference to the key. A JavaScript string can't be wiped, so that's as far as zeroing goes. There is no server route. Logs get status codes, and errors carry no response body.
- **The pinned fetch.** A provider gets `tools/voice/pinned.ts`, not `fetch`: a path on its one host, and `redirect: 'error'`, because fetch would carry a custom key header across a redirect. A test's fake host must be loopback and never works in a packaged app.
- **The bridge is reachable by rigs.** Rig code runs in the viewer page, so it can call the bridge. That's why every spend and every key removal stops at a native dialog no page can draw or answer, and why one generation runs at a time.
- **Shown back.** Provider, last four, date added. Remove deletes the key here, and the row links to the provider's page, since only that kills a copy.
- **Browser and `npm run dev`.** No key store. Kokoro only.
- **Providers.** One file each in `tools/voice/providers/`: `{ id, host, keyPage, kinds, price, voices, generate(request, key, http) }` returning `{ bytes, ext, words? }`, or a pending job to poll. Added by pull request, loaded by main, never from a project folder. `kinds` already allows `'video'` with nothing built for it, and the poll seam is there for it. Video results will land in `media/` as composition clips (ADR 0014), never in scenes. `elevenlabs` is first, on Multilingual v2 and the with-timestamps endpoint, so words come back.
- **Kokoro.** The free voice, through sherpa-onnx-node 1.13.8, pinned because 2.x dropped espeak-ng and Spanish fails without it. The runtime and model download on first use to `~/.frame-studio/models/`, each archive sha256-pinned, offered in a card with size, licences and progress. Speech runs in a child process. Nothing GPL ships in the DMG: espeak-ng comes only through that optional download, the card says so, and `tools/desktop/check.ts` fails a build holding it. Works in `npm run dev` and the app. Electron's V8 refuses external buffers, so the child asks the addon not to use them.
- **Agents.** A Kokoro-only MCP tool, `generate_voice(text, lang, voice?)`, needs no key. Agents have `import_media` for files. Nothing an agent can call touches a paid provider.
- **Folder trust.** Before a folder's `rigs/`, `audio/` or old films' `rigs/` load the first time, main asks in a native dialog: "This project contains code." Trust, or Open Without Its Code, the default. It's stored in main's settings by real path with a hash of those folders, so a change asks again. Without trust the server runs with `--untrusted`: `CodeHost` and `ModuleService` load and serve built-ins only, and the viewer says why a scene can't draw. The page can open the prompt and revoke trust. It can't grant it. The sample project counts as trusted when the app makes it, and the repo in `npm run dev` always does.

## Consequences

- What changes while a trusted project is open stays trusted, or every rig an agent writes would ask again next time. The hash is taken when the project closes, so an outside change during that window slips through. Only changes made while it's closed ask.
- Folder trust guards the app. The CLI, `npm run dev --folder` and an MCP shim that starts a headless server load a folder's code without asking, since running those is already a decision made in a terminal.
- Generating needs the app window open on a project. Long jobs don't queue.
- The dialog shows the first 1200 characters and says how many more there are, with control and format characters removed, so a page can't hide text in it.
- The price is an estimate at a published rate. A subscription's credits work out differently, and the dialog says so.
- A generated voice gets its words when it's placed as a cue (ADR 0016). `alignVoice` in the viewer keeps the script, language and any provider words by file. Placing the file writes them into the cue; provider words take the script's text. With none, the timing job runs and reads the script from the cue.

## Refused

- Environment variables for keys: they leak into every child, and the server starts agents.
- Keys in the studio server, with a route: rigs run in that process.
- Providers in project folders: a provider holds a key while it runs.
- Generate Video in this milestone. The shape allows it; nothing else does.
