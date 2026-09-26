# How does T3 Code build, start and ship its desktop app?

Research for [issue 19](../issues/19-m10-electron-app.md). Checked 2026-09-25 against T3 Code's source at commit [`8aa5be2`](https://github.com/pingdotgg/t3code/commit/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4) of 2026-09-25, shallow-cloned into `/tmp`, plus a blob-less clone of the whole history for `git log -S`. I also inspected the installed T3 Code (Alpha) in `/Applications`, which is release 0.0.42, built from commit `719a76c` and published 2026-09-16. I read its bundle, extracted its `app.asar` into `/tmp`, read its code signature and Electron fuses, and watched the running copy with `ps` and `lsof`. That build runs Electron 44.1.0, which reports Node 24.19.0 and Chromium 152.0.7977.65. The repo has since moved to Electron 44.4.2. Release asset sizes come from the GitHub API through `gh`. I didn't build T3's installer myself and had no Windows or Linux machine, so those parts rest on source code.

T3 Code's desktop app is written against Effect, with every service a `Layer`, which makes the current files long. Commit [`dd32f52`](https://github.com/pingdotgg/t3code/blob/dd32f52655d08d1cbab9149ac44b0a63665779db/apps/desktop/src/main.ts), the last one before the port to Effect on 2026-05-07, has the same design in plain Node in one `main.ts`, and it is the easier one to copy from.

## Question

ADR 0001 says the studio server leaves Vite and becomes a standalone Node server, which the Electron app starts as a child process, "passing the page its address and a pairing token, as T3 Code does". Ticket 19 adds that the installed app must not carry the Claude Agent SDK's bundled Claude binary, excluded the way T3's `scripts/build-desktop-artifact.ts` does it. Six questions:

1. How is the repo laid out, and how does the desktop app start the server: which process API, which Node, which port, how the renderer learns the URL and token, and what goes over IPC?
2. How is the pairing token made and checked, how does web mode get one, and are there origin checks?
3. How is the app packaged: tool, config, file globs, asar, how the server's dependencies ship, native modules, signing, auto-update, platforms and sizes? Is any Agent SDK platform binary inside the installed app?
4. How do they develop the desktop app: dev servers, hot reload, proxying?
5. How does the server start `claude` and `codex` from a packaged app, and how does it get a usable PATH when Finder launches it?
6. What else in their desktop setup should a similar app copy or avoid?

## Short answer

T3 Code is a pnpm monorepo. `apps/server` is the `t3` package, `apps/web` the React client, `apps/desktop` the Electron main process and preloads, and `packages/` holds shared code. Electron's main process starts the server with `child_process.spawn`, through Effect's wrapper. It doesn't use `fork` or `utilityProcess`. The executable is `process.execPath`, the Electron binary itself, with `ELECTRON_RUN_AS_NODE=1`, so the server runs on Electron's Node and loads its bundle straight out of `app.asar`. No separate Node ships in the desktop app. Main writes one JSON line to the child's file descriptor 3 with the port, bind host, state directory and a token made of 24 random bytes in hex, so the token never appears in argv or the environment. Main picks the port by probing upward from 3773, the server binds 127.0.0.1, and main polls `GET /.well-known/t3/environment` until it answers before opening the window. The window doesn't load from the server. It loads `t3code://app/`, a custom scheme that serves the built client from disk, or proxies to Vite in development. The page reads the server's URL and token from `window.desktopBridge`, which the preload exposes with `contextBridge` over `ipcRenderer.sendSync`, and it gets a bearer token from main over `ipcRenderer.invoke`. From then on the app's data goes over HTTP and one WebSocket. The 108 IPC channels carry native features only, plus client settings and the saved-connections list.

The token is a pairing credential. At startup the server seeds it as a grant with administrative scopes, a 24-hour expiry and unlimited uses. A client exchanges it at `POST /oauth/token` for a bearer token, or at `POST /api/auth/browser-session` for an HttpOnly, SameSite=Lax session cookie. The WebSocket at `/ws` takes that cookie or a `wsTicket` query parameter, a 5-minute ticket that bearer clients fetch from `POST /api/auth/websocket-ticket`, which keeps long-lived tokens out of URLs. In web mode, `npx t3` mints a one-time 12-character token that lives 5 minutes and opens `http://localhost:3773/pair#token=...`. The token travels in the URL fragment and the page strips it after use. Neither HTTP nor the WebSocket checks the Origin header. The packaged app answers CORS with a wildcard origin and no credentials, and development allowlists the Vite origin and the two `t3code` schemes.

Packaging is electron-builder 26.15.6, driven by a 3,962-line script. It builds a throwaway stage directory with a generated `package.json` whose `build` key is the electron-builder config, runs a production `pnpm install` there, and points electron-builder at it. The server and the Electron main process are each bundled by Rolldown, through `vp pack`, into files that inline every JavaScript dependency. Only native addons and `playwright-core` stay external, and only they get installed. The Agent SDK is plain JavaScript, so it lands inside the server bundle and its platform packages never reach the stage. The `!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*` glob the ticket cites was added on 2026-07-29, when the stage still installed the server's whole dependency tree, and it is now a second guard. The installed app confirms this. Nothing in the 306 MB bundle or inside its `app.asar` has `claude-agent-sdk-` in its path, and the SDK's code sits in `apps/server/dist`. macOS and Linux keep everything in `app.asar`, with native `.node` files unpacked beside it. macOS builds are signed with a Developer ID under the hardened runtime and notarized, and Windows builds are signed with Azure Trusted Signing. electron-updater updates from GitHub Releases on `latest` and `nightly` channels with blockmap differential downloads. CI builds six targets on native runners: macOS arm64 and x64, Linux x64 and arm64, Windows x64 and arm64. The 0.0.42 arm64 DMG is 135 MB, and the installed app is 306 MB, of which 236 MB is the Electron framework.

In development, Vite serves the client and `vp pack --watch` rebuilds the main process, restarting Electron after each build. Main spawns the prebuilt server from `apps/server/dist/bin.mjs` on a port the dev runner fixes, and Electron restarts when that file changes. Client edits hot-reload through Vite. In browser development, Vite proxies `/api`, `/oauth`, `/.well-known` and `/ws` to a server running under `node --watch`, so the page and the API share one origin.

Finder hands a GUI app launchd's short PATH. Before anything else, main runs the user's login shell as `$SHELL -ilc` with a 5-second timeout, reads PATH, `SSH_AUTH_SOCK`, the Homebrew and XDG variables and the locale out of its output, falls back to `launchctl getenv PATH`, and merges the result into `process.env`. The server repeats this at its own startup. Claude then runs through the Agent SDK with `pathToClaudeCodeExecutable` set to the configured binary, `claude` by default, which the SDK spawns through that PATH. Codex runs as `codex app-server` the same way. One thing leaks. The server's `ELECTRON_RUN_AS_NODE=1` reaches `claude` and everything the agent runs. T3 strips it from its terminals but not from agents, and this research session, which runs inside T3 Code, has it set.

Worth copying: the single-instance lock, saved window bounds, a bounded reload after a renderer crash, link and navigation guards, sandboxed renderers, a CSP on the custom scheme, rotating logs with the server's output in its own file, and backend restarts with backoff. Worth avoiding: choosing the port by probing before the server binds, the `ELECTRON_RUN_AS_NODE` leak, and most of T3's code, which serves WSL, SSH, Tailscale, Clerk sign-in, a built-in browser and screenshots.

## 1. Layout and how the desktop starts the server

### Repo layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/server` | `t3` 0.0.42 | The server and CLI. `bin` is `./dist/bin.mjs`. Depends on `@anthropic-ai/claude-agent-sdk` `^0.3.276`, `node-pty`, `@opencode-ai/sdk` and Effect ([package.json](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/package.json)). Its build copies `apps/web/dist` into `dist/client` ([scripts/cli.ts#L92-L98](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/scripts/cli.ts#L92-L98)). |
| `apps/web` | `@t3tools/web` | The React client, the same code in a browser tab and in Electron. |
| `apps/desktop` | `@t3tools/desktop` | Electron main, preloads and workers. `main` is `dist-electron/boot.cjs`. `electron` 44.4.2, `electron-updater` `^6.8.9`, `electron-store` `^8.2.0`, `electron-builder` 26.15.6 as a dev dependency ([package.json](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/package.json)). |
| `apps/mobile`, `apps/marketing` | | Expo app and website. |
| `packages/contracts` | | Shared schemas, among them the HTTP API ([environmentHttp.ts#L412-L492](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/packages/contracts/src/environmentHttp.ts#L412-L492)) and the bootstrap envelope ([desktopBootstrap.ts#L5-L25](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/packages/contracts/src/desktopBootstrap.ts#L5-L25)). |
| `packages/client-runtime`, `shared`, `ssh`, `tailscale`, `effect-acp`, `effect-codex-app-server` | | Client auth helpers, shared utilities such as the shell-PATH code, and protocol clients. |

The root uses pnpm 11.10.0, requires Node `^24.13.1`, and runs tasks with `vp`, the Vite+ CLI ([package.json](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/package.json)).

### Spawning the server

`DesktopApp.bootstrap` registers the custom scheme and the IPC handlers, picks a port, and calls `primaryBackend.start` ([DesktopApp.ts#L160-L258](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopApp.ts#L160-L258)). The start config says what runs ([DesktopBackendConfiguration.ts#L535-L593](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopBackendConfiguration.ts#L535-L593)):

```ts
executablePath: process.execPath,
args: [
  ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
  environment.backendEntryPath,        // <app>/apps/server/dist/bin.mjs
  "--bootstrap-fd",
  "3",
],
env: { ...backendChildEnvPatch(), ELECTRON_RUN_AS_NODE: "1" },
extendEnv: true,                        // the child inherits process.env, PATH included
bootstrapDelivery: "fd3",
```

`runBackendProcess` turns that into a spawn with stdin ignored, stdout and stderr piped into a log, `SIGTERM` to stop and `SIGKILL` 2 seconds later ([DesktopBackendManager.ts#L440-L491](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopBackendManager.ts#L440-L491)). It opens three extra descriptors. Descriptor 3 carries one line of JSON, the bootstrap envelope, and then closes. Descriptors 4 and 5 carry resource telemetry and its control messages. The comment beside the spawn gives the reason for `ELECTRON_RUN_AS_NODE`: "In Electron main, process.execPath points to the Electron binary. Run the child in Node mode so this backend process does not become a GUI app instance."

The server reads the descriptor named by `--bootstrap-fd` or `T3CODE_BOOTSTRAP_FD` ([cli/config.ts#L272-L276](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/cli/config.ts#L272-L276)), takes the first line, decodes it against the schema, and gives up after one second ([bootstrap.ts#L74-L140](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/bootstrap.ts#L74-L140)). The envelope holds `mode: "desktop"`, `noBrowser`, `port`, `host`, `t3Home`, `desktopBootstrapToken`, the Tailscale settings, telemetry descriptor numbers and OTLP endpoints.

Main then polls `GET /.well-known/t3/environment` every 100 ms, with 1 second per request and 60 seconds per round, and starts a new round as long as the child lives ([DesktopBackendManager.ts#L57-L69](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopBackendManager.ts#L57-L69), [#L576-L596](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopBackendManager.ts#L576-L596)). The first success opens the main window ([DesktopBackendPool.ts#L288-L295](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopBackendPool.ts#L288-L295)). If the child exits, main restarts it after 500 ms, doubling each time up to 10 seconds ([DesktopBackendManager.ts#L347-L348](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopBackendManager.ts#L347-L348)).

The running app shows this. Process 83638 is a child of the main process 83610, and `lsof` shows it listening on `127.0.0.1:3773`:

```
83638 83610 /Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha) /Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs --bootstrap-fd 3
```

So the server runs on Node 24.19.0 inside Electron 44.1.0, and Electron's Node reads `bin.mjs` from inside the asar archive. Electron's `RunAsNode` fuse has to stay on for this, and section 3 shows it is on in the installed app. Nothing in the repo uses `utilityProcess`. The same `bin.mjs` runs under plain Node for `npx t3`, and a Node single-executable of it runs over SSH and inside WSL ([docs/operations/release.md#L40-L41](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/docs/operations/release.md#L40-L41)). I think that portability is why they chose a plain spawn, but I found no text that says so. Helper workers use `child_process.fork` with `ELECTRON_RUN_AS_NODE=1` too, for example the global shortcut worker in the installed `main.cjs`.

Windows differs. The server tree ships in a separate `resources/server.asar` so the NSIS installer extracts a few archives instead of thousands of files, and a WSL backend runs the Linux CLI archive ([build-desktop-artifact.ts#L992-L1028](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L992-L1028)). The server in turn starts a small Rust resource monitor from `resources/resource-monitor`, whose path main passes in the envelope.

The plain-Node version at `dd32f52` does the same in about 40 lines: `ChildProcess.spawn(process.execPath, [backendEntry, "--bootstrap-fd", "3"], { env: { ...backendChildEnv(), ELECTRON_RUN_AS_NODE: "1" }, stdio: [..., "pipe"] })`, then `child.stdio[3].write(JSON.stringify({...}) + "\n")` and `end()` ([main.ts#L1457-L1505 at dd32f52](https://github.com/pingdotgg/t3code/blob/dd32f52655d08d1cbab9149ac44b0a63665779db/apps/desktop/src/main.ts#L1457-L1505)).

### The port

Packaged builds scan upward from 3773 and take the first port that can be bound on `127.0.0.1`, `0.0.0.0` and `::` ([DesktopApp.ts#L36-L107](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopApp.ts#L36-L107)). Development refuses to start without `T3CODE_PORT` ([#L198-L200](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopApp.ts#L198-L200)). Main passes the port in the envelope. In the default local-only mode the server binds `127.0.0.1`, and the user can switch to network access, which binds `0.0.0.0` ([DesktopServerExposure.ts#L103-L135](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopServerExposure.ts#L103-L135)). Main probes and releases the port, and the server binds it later, so another process can take it in between. The restart loop would then retry on the same port. I didn't test that case.

### How the renderer learns the URL and the token

The window never loads from the server. Before `ready`, main registers `t3code` and `t3code-dev` as privileged schemes: standard, secure, fetch, CORS and streaming, plus the V8 code cache for the production one ([ElectronProtocol.ts#L119-L145](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/electron/ElectronProtocol.ts#L119-L145)). Packaged builds serve `apps/server/dist/client` from disk under `t3code://app/`, with an `index.html` fallback for client routes and a guard against paths that escape the folder. Development proxies `t3code-dev://app/` to the Vite dev server with `net.fetch` ([#L153-L239](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/electron/ElectronProtocol.ts#L153-L239)). Both add a Content-Security-Policy header ([#L71-L104](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/electron/ElectronProtocol.ts#L71-L104)). The comment in `DesktopApp.ts` gives the reason: "The renderer is served from the bundled client (or Vite in development) rather than through the local backend, so the window can open without one." A second effect, my inference, is that the page's origin and its storage don't change when the port does.

The page then reaches the server cross-origin, in four steps:

1. The preload runs `contextBridge.exposeInMainWorld("desktopBridge", {...})` ([preload.ts#L65](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/preload.ts#L65)). Its `getLocalEnvironmentBootstraps()` calls `ipcRenderer.sendSync("desktop:get-local-environment-bootstraps")` ([#L91-L97](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/preload.ts#L91-L97)).
2. Main answers with `{ id, label, httpBaseUrl, wsBaseUrl, bootstrapToken }` for each running backend ([ipc/methods/window.ts#L93-L163](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/ipc/methods/window.ts#L93-L163)).
3. `getLocalEnvironmentBearerToken()` goes over `ipcRenderer.invoke`. Main exchanges the bootstrap token at `POST /oauth/token`, labelled "T3 Code Desktop", caches the bearer token and returns it ([DesktopLocalEnvironmentAuth.ts#L46-L94](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts#L46-L94), [window.ts#L166-L175](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/ipc/methods/window.ts#L166-L175)).
4. The page's HTTP client adds `Authorization: Bearer` to every request unless the page and the server share an origin, which only happens in a browser ([web httpLayer.ts#L9-L50](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/web/src/environments/primary/httpLayer.ts#L9-L50)). It fetches a WebSocket ticket the same way and connects to `ws://127.0.0.1:<port>/ws?wsTicket=...`.

The raw bootstrap token is visible to the page too, and the web client can use it to make a cookie session ([web auth.ts#L168-L178](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/web/src/environments/primary/auth.ts#L168-L178)). At `dd32f52` the page got only the bootstrap object over `sendSync` ([preload.ts#L64-L70 at dd32f52](https://github.com/pingdotgg/t3code/blob/dd32f52655d08d1cbab9149ac44b0a63665779db/apps/desktop/src/preload.ts#L64-L70), [main.ts#L1648-L1655 at dd32f52](https://github.com/pingdotgg/t3code/blob/dd32f52655d08d1cbab9149ac44b0a63665779db/apps/desktop/src/main.ts#L1648-L1655)).

### What goes over IPC

[`ipc/channels.ts`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/ipc/channels.ts) names 108 channels, all prefixed `desktop:`. 44 drive the built-in preview browser and its automation, 13 the screenshot feature, 11 SSH environments. The rest cover folder and file pickers, context menus, opening URLs and system settings, the dock badge, theme and fullscreen state, menu actions, paste as text, six for updates, branding and locale, the local environment's bootstrap, token and on-off switch, server exposure and Tailscale, WSL, and macOS permissions. Threads, messages, agent events and server settings all go over the WebSocket. Two things that look like app data do go over IPC. Client settings live in main, and so does the list of saved remote connections, whose secrets main encrypts with `safeStorage` ([DesktopSavedEnvironments.ts#L230-L275](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/settings/DesktopSavedEnvironments.ts#L230-L275)).

## 2. Pairing and auth

T3's design notes: "Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow that grant but cannot widen it." and "Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated HTTP so long-lived tokens stay out of socket URLs." ([docs/internals/environment-auth.md](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/docs/internals/environment-auth.md)).

| Credential | Made by | Form | Lifetime | Where it's used |
| --- | --- | --- | --- | --- |
| Desktop bootstrap token | Electron main, `crypto.randomBytes(24)` as hex, one per app run ([DesktopBackendConfiguration.ts#L829-L847](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/backend/DesktopBackendConfiguration.ts#L829-L847)) | 48 hex characters | 24 hours, unlimited uses, administrative scopes ([PairingGrantStore.ts#L312-L328](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/PairingGrantStore.ts#L312-L328)) | Exchanged for a bearer token or a cookie |
| One-time pairing token | Server | 12 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` | 5 minutes, one use ([PairingGrantStore.ts#L239-L259](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/PairingGrantStore.ts#L239-L259)) | Browser and phone pairing |
| Session | Server | Bearer token, DPoP-bound token, or HttpOnly SameSite=Lax cookie ([auth/http.ts#L174-L181](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/http.ts#L174-L181)) | 30 days, 1 hour when DPoP-bound ([SessionStore.ts#L423-L424](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/SessionStore.ts#L423-L424)) | Every HTTP call |
| WebSocket ticket | Server, from `POST /api/auth/websocket-ticket` | Query parameter `wsTicket` | 5 minutes | The `/ws` upgrade |

The exchange endpoints are `POST /oauth/token`, an OAuth-style token exchange, and `POST /api/auth/browser-session`, which sets the cookie ([environmentHttp.ts#L419-L492](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/packages/contracts/src/environmentHttp.ts#L419-L492), [EnvironmentAuth.ts#L804-L858](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/EnvironmentAuth.ts#L804-L858)). Each desktop exchange revokes the previous desktop session, since a restarted app forgets its bearer token. HTTP requests authenticate by cookie first, then `Authorization: Bearer` ([EnvironmentAuth.ts#L554-L600](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/EnvironmentAuth.ts#L554-L600)). The WebSocket route authenticates the upgrade with the `wsTicket` if present, else the same way as HTTP, and fails the upgrade otherwise ([EnvironmentAuth.ts#L1075-L1097](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/EnvironmentAuth.ts#L1075-L1097), [ws.ts#L3816-L3833](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/ws.ts#L3816-L3833)). Every RPC on the socket then declares the scope it needs. `/.well-known/t3/environment` answers without auth, which is what makes it usable for readiness.

The policy depends on mode and bind address ([EnvironmentAuthPolicy.ts#L23-L37](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/EnvironmentAuthPolicy.ts#L23-L37)). A desktop server on loopback accepts only the desktop bootstrap. A desktop server on the network accepts that and one-time tokens. A standalone server accepts one-time tokens.

In web mode, `npx t3` starts the server, which serves `dist/client` itself, mints a one-time token and opens the browser at `http://localhost:<port>/pair#token=<token>` ([serverRuntimeStartup.ts#L307-L319](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/serverRuntimeStartup.ts#L307-L319), [EnvironmentAuth.ts#L1045-L1056](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/auth/EnvironmentAuth.ts#L1045-L1056)). The token sits in the fragment, which browsers don't send to the server. The page reads it, replaces the URL without it, and exchanges it for the cookie ([web auth.ts#L150-L166](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/web/src/environments/primary/auth.ts#L150-L166), [#L310-L330](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/web/src/environments/primary/auth.ts#L310-L330)). A headless `t3 serve` prints the token, the pairing URL and a terminal QR code ([startupAccess.ts#L92-L148](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/startupAccess.ts#L92-L148)). The development docs say: "Open the pairing URL printed by the dev runner. The bare origin does not authenticate a new browser."

On origins, I found no check of `Origin` or `Host` on HTTP or on the WebSocket upgrade. CORS is the only origin logic ([http.ts#L234-L257](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/http.ts#L234-L257)):

> Dev uses credentialed requests from Vite or the Electron custom origin, so both must be explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.

In development the allowlist is the Vite origin, `t3code://app`, `t3code-dev://app` and `T3CODE_DEV_ALLOWED_ORIGINS`. The protection is the token. Another site's page can't read it, and SameSite=Lax keeps the cookie off its cross-site requests. I didn't test a cross-site WebSocket against the running server.

## 3. Packaging

### The script and the stage

`vp run dist:desktop:dmg` runs [`scripts/build-desktop-artifact.ts`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts). In order:

1. Unless told to skip, runs `vp run build:desktop`, which builds the web client, the server bundle with the client copied in, and the Electron main bundle ([#L3440-L3451](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L3440-L3451)).
2. Checks the emitted server bundle. The build fails if a package that must stay external was inlined, if any inlined package carries native loader markers, or if `effect` was left out, which would mean the bundle stopped inlining ([#L3466-L3526](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L3466-L3526)).
3. Copies `apps/desktop/dist-electron`, the desktop resources and `apps/server/dist` into a temp stage directory, plus the Rust resource monitor and platform helpers ([#L3542-L3596](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L3542-L3596)).
4. Writes the stage `package.json`. Its `main` is `apps/desktop/dist-electron/boot.cjs`, its `build` key is the electron-builder config, its `dependencies` are only the packages the two bundles leave external, and its `devDependencies` pin `electron` ([#L3640-L3700](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L3640-L3700), [#L1336-L1350](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L1336-L1350)).
5. Runs `vp install --prod` in the stage, a pnpm install restricted to the target architecture ([#L3715-L3722](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L3715-L3722)).
6. Runs `electron-builder --projectDir <stage> --mac|--linux|--win --<arch> --publish never` and copies the artifacts to `release/` ([#L3803-L3825](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L3803-L3825)). Publishing happens later in CI.

The electron-builder config comes from `createBuildConfig` ([#L2622-L2800](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L2622-L2800)):

- `appId` `com.t3tools.t3code`, `artifactName` `T3-Code-${version}-${arch}.${ext}`, `electronLanguages: ["en-US"]`.
- `files` is only exclusions, listed below, so electron-builder takes the whole stage minus those.
- asar stays on by default. On macOS and Linux electron-builder's smart unpack puts native libraries in `app.asar.unpacked`. On Windows smart unpack is off and `asarUnpack` lists `*.node`, `*.dll`, `*.exe`, `*.so` and `*.dylib`.
- `mac`: targets `dmg` and `zip`, category developer tools, the `t3code` and `t3code-dev` URL schemes, a custom `sign` hook, and entitlements plus a provisioning profile for passkeys.
- `linux`: `AppImage` and `deb`, with the same schemes and a list of Debian dependencies.
- `win`: `nsis` with `differentialPackage: true`, `npmRebuild: false`, and `azureSignOptions` when signing.
- `publish`: GitHub, unless the build is a preview.

The file exclusions ([#L942-L990](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L942-L990)):

```ts
export const DESKTOP_FILE_EXCLUSIONS = [
  // T3 Code always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  // Nothing in the packaged app enables source maps or serves them: the web
  // client's maps alone were 50 MB of app.asar that no request ever read.
  "!**/*.map",
  "!**/*.d.cts",
  // ...staging-only resources: browser-secret, windows-server, wsl-runtime, gnome-extension
] as const;
// macOS drops node-pty's win32 prebuilds and conpty, plus the other darwin arch's prebuild.
// Linux also drops node-pty's darwin prebuilds, since it builds node-pty from source.
```

The hand-packed Windows `server.asar` has its own ignore list with `**/node_modules/@anthropic-ai/claude-agent-sdk-*`, `**/node_modules/.bin` and `**/*.map` ([#L1004-L1014](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L1004-L1014)).

### How the server's dependencies ship

Both bundles inline every JavaScript dependency and leave out only what Node must load from a real file. For the server, [`scripts/lib/cli-external-packages.ts#L28-L47`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/lib/cli-external-packages.ts#L28-L47) lists `node-pty`, `ffi-rs`, `@yuuang/`, `@ff-labs/`, `@napi-rs/keyring`, `@clerk/electron-passkeys`, `node-gyp-build`, `node-addon-api`, `bufferutil` and `utf-8-validate`. It feeds both `neverBundle` in [`apps/server/vite.config.ts#L98-L110`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/vite.config.ts#L98-L110) and the stage's dependency list, "so a package that is external is also the only kind of package the staged production install carries". The main process follows [`desktop-external-packages.ts#L14-L25`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/lib/desktop-external-packages.ts#L14-L25), which adds `@crowecawcaw/xa11y` and `playwright-core` ([apps/desktop/vite.config.ts#L9-L67](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/vite.config.ts#L9-L67)). The server config explains the history:

> The bundle used to inline only workspace packages, leaving every third-party runtime dep external. [...] the desktop build unpacked `**\/node_modules\/**` wholesale: 13,875 loose files to support 20 native binaries. NSIS install time tracks file count, not bytes.

That inversion landed in [PR #5877](https://github.com/pingdotgg/t3code/commit/7e01d33f0eeb9435299791392d546756cc09c5d3) on 2026-08-13.

Native modules come from each package's prebuilds, installed by pnpm for the target architecture. The build copies the keyring and passkey binaries by hand because pnpm nests them where electron-builder won't look ([#L1406-L1475](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L1406-L1475)). Main and the server run on the same Electron binary, so one set of `.node` files serves both.

### The Claude Agent SDK exclusion

The glob came in with [PR #4824](https://github.com/pingdotgg/t3code/commit/72b960fa3985ec61af6a459431861a5dcb360009), "reduce installed app size by ~300MB", on 2026-07-29. Its description: "The current version of the T3 Code desktop app is unreasonably huge: ~737 MB on arm64 macOS. [...] This PR brings it down to ~424 MB without any functional changes", by omitting the SDK's platform binaries, dropping every Electron locale but en-US, and packing dependencies into the asar on macOS and Linux. At that point the stage installed the server's full production dependencies, the SDK and its optional platform package among them.

Since PR #5877 the SDK is inlined into the server bundle and the stage installs only the external packages, so the platform packages never arrive and the glob matches nothing. The SDK needs no platform package when it has `pathToClaudeCodeExecutable`. The bundled SDK 0.3.260 in the installed app, `apps/server/dist/claudeHistoryWorker-CAn1PawV.mjs`, does this:

```js
let KE = u.pathToClaudeCodeExecutable;
if (!KE) {
  // resolve `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude` next to the SDK
  if (!Yi) throw Error(`Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`);
  KE = Yi;
}
```

The SDK 0.3.282 in Frame Studio's `node_modules` has the same branch. It lists eight optional platform packages, from `claude-agent-sdk-darwin-arm64` to `claude-agent-sdk-win32-arm64`, and the darwin-arm64 one takes 212 MB in our `node_modules`.

What the installed 0.0.42 app contains:

- `find` over the whole `.app` for `*claude*` or `*anthropic*` returns nothing, and neither does the extracted `app.asar`.
- The stage `package.json` inside the asar lists only `@ff-labs/fff-node`, `@ff-labs/fff-bin-darwin-arm64`, `msgpackr-extract`, `node-pty`, `@clerk/electron-passkeys`, `@crowecawcaw/xa11y`, `@napi-rs/keyring`, `ffi-rs` and `playwright-core`.
- The SDK's code is inlined in the server chunk, whose `//#region` marker names `@anthropic-ai/claude-agent-sdk@0.3.260/.../sdk.mjs`.

### Signing, notarization and fuses

macOS signing goes through electron-builder with a custom hook, [`scripts/sign-macos.ts`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/sign-macos.ts), that calls `@electron/osx-sign` with `batchCodesignCalls: true`. CI turns it on only when `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are all set ([release-desktop.yml#L358-L376](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/.github/workflows/release-desktop.yml#L358-L376)). electron-builder 26.15.6 notarizes with `notarytool` whenever those three `APPLE_API_*` variables are present, as `getNotarizeOptions` in `app-builder-lib`'s `out/mac/MacTargetHelper.js` shows. Local builds are unsigned by default. The installed app checks out:

```
Authority=Developer ID Application: T3 Tools, Inc. (ARK85ZXQ4Z)
flags=0x10000(runtime)
spctl: accepted, source=Notarized Developer ID
entitlements: allow-jit, allow-unsigned-executable-memory, disable-library-validation,
              associated-domains webcredentials:clerk.t3.codes
```

Its Electron fuses are Electron's defaults: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` and `GrantFileProtocolExtraPrivileges` on, `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` and `EnableCookieEncryption` off. `Info.plist` does carry an `ElectronAsarIntegrity` hash, but with that fuse off nothing checks it. Windows signs with Azure Trusted Signing ([createBuildConfig](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/build-desktop-artifact.ts#L2783-L2800)).

### Auto-update

`electron-updater` with `provider: github`. The installed `Resources/app-update.yml` reads `owner: pingdotgg, repo: t3code, provider: github, releaseType: release`. Stable reads `latest*.yml`, nightly reads `nightly*.yml`, and the macOS update payload is the `.zip` for Squirrel.Mac. Blockmaps enable differential downloads, and CI merges the arm64 and x64 manifests into one mac manifest. The app checks in the background but never downloads or installs without a click ([docs/operations/release.md#L318-L337](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/docs/operations/release.md#L318-L337)).

### Platforms and sizes

CI builds the JavaScript once and packages it in six jobs on native runners: macOS arm64 and x64 on `blacksmith-12vcpu-macos-26`, Linux x64 and arm64 on Ubuntu, Windows x64 on `windows-2025` and arm64 on `windows-11-arm` ([release.yml#L539-L685](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/.github/workflows/release.yml#L539-L685), [release.md#L28-L34](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/docs/operations/release.md#L28-L34)). The script also accepts `--arch universal` for macOS, but CI doesn't use it.

Release assets, in bytes:

| Artifact | 0.0.42 stable, 2026-09-16 | 0.0.43 nightly 2269, 2026-09-25 |
| --- | --- | --- |
| macOS arm64 DMG | 135,327,310 | 150,814,024 |
| macOS arm64 zip, the update payload | 130,487,584 | 142,972,815 |
| macOS x64 DMG | 142,521,951 | 158,322,885 |
| Linux x64 AppImage | 150,326,305 | 159,373,837 |
| Linux amd64 deb | none | 127,264,484 |
| Windows x64 NSIS | 197,907,216 | 212,861,776 |
| Windows arm64 NSIS | 190,899,560 | 204,955,208 |

The installed 0.0.42 app on disk, measured with `du`:

| Part | Size |
| --- | --- |
| Whole `.app` | 306 MB |
| `Frameworks/Electron Framework.framework` | 236 MB |
| `Resources/app.asar` | 59.3 MB |
| `Resources/app.asar.unpacked`: node-pty, ffi-rs, fff, keyring, passkeys, xa11y, msgpackr-extract | 10 MB |
| Inside the asar, extracted: `apps/server/dist/client`, the web client | 34 MB |
| Inside the asar: `bin.mjs` 8.3 MB plus a 2.7 MB chunk that holds the Agent SDK | 11 MB |
| Inside the asar: `apps/desktop/dist-electron`, with `main.cjs` at 4.9 MB | 5.8 MB |
| Inside the asar: `node_modules`, half of it `playwright-core` at 10 MB, the rest native packages | 21 MB |

Electron is most of the app. Frame Studio would pay the same 236 MB for Electron 44 on macOS arm64, plus a much smaller payload.

## 4. Development workflow

`vp run dev:desktop` runs [`scripts/dev-runner.ts`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/dev-runner.ts), which picks ports per worktree, 13773 and 5733 plus an offset, and sets the environment ([#L316-L380](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/dev-runner.ts#L316-L380)). For desktop it sets `PORT` for Vite, `VITE_DEV_SERVER_URL=http://127.0.0.1:<web>`, `T3CODE_PORT`, and `VITE_HTTP_URL` and `VITE_WS_URL` pointing at the server. It then runs the `dev` task of `@t3tools/desktop` and `@t3tools/web` ([#L75-L86](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/scripts/dev-runner.ts#L75-L86)).

- The web `dev` task is the Vite dev server.
- The desktop `dev` task depends on `t3#build`, so the server bundle is built once first. It then runs `vp pack --watch` on the main process with `onSuccess: "node scripts/dev-electron.mjs"` ([apps/desktop/vite.config.ts#L24-L66](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/vite.config.ts#L24-L66)).
- [`dev-electron.mjs`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/scripts/dev-electron.mjs) waits for the built files and for Vite's port, deletes `ELECTRON_RUN_AS_NODE` from the environment it passes on, and spawns Electron on `dist-electron/main.cjs`. It watches `main.cjs`, `preload.cjs`, the worker bundles and `../server/dist/bin.mjs`, and restarts Electron 120 ms after any of them changes, killing the old process tree with `pkill -P`.
- Main sees `VITE_DEV_SERVER_URL`, serves `t3code-dev://app/` by proxying to Vite, spawns the server from `apps/server/dist/bin.mjs` on `T3CODE_PORT`, and keeps development state in its own directory.
- Client edits hot-reload through Vite. Vite's HMR socket is pinned to `127.0.0.1` and the Vite port, because "Electron's BrowserWindow needs the HMR socket pinned to an explicit host to connect reliably" ([apps/web/vite.config.ts#L259-L275](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/web/vite.config.ts#L259-L275)).
- Main-process edits rebuild and restart Electron. Server edits don't rebuild anything in this mode. The server has to be rebuilt by hand, and Electron restarts when `bin.mjs` changes.
- A launcher script builds a development `.app` named "T3 Code (Dev)" with a bundle id per checkout and the `t3code-dev` scheme, so development and the installed app don't collide ([electron-launcher.mjs#L1-L22](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/scripts/electron-launcher.mjs#L1-L22)).

`vp run dev`, the browser workflow, runs the server as `node --watch src/bin.ts` next to Vite. Vite proxies `/api`, `/oauth`, `/.well-known` and `/ws` to it, with WebSocket upgrades for `/ws` and `/api` ([apps/web/vite.config.ts#L239-L257](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/web/vite.config.ts#L239-L257), [devProxy.ts#L11](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/packages/shared/src/devProxy.ts#L11)). The page and the API share Vite's origin, so cookie auth works, and the server redirects loopback page requests to the Vite URL ([apps/server/src/http.ts#L529-L537](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/http.ts#L529-L537)). The runner prints a pairing URL to open.

Other development rules from [docs/operations/development.md](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/docs/operations/development.md): "Never run a development server against the live `~/.t3/userdata`", and a smoke test launches the built `boot.cjs` for 8 seconds and fails on "Cannot find module" and similar output ([smoke-test.mjs](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/scripts/smoke-test.mjs)).

## 5. Spawning agent CLIs from the packaged app

### PATH for a Finder launch

The first thing `startup` does is `shellEnvironment.installIntoProcess`, before `app.whenReady()` ([DesktopApp.ts#L274](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopApp.ts#L274)). On macOS and Linux [`DesktopShellEnvironment.ts`](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/shell/DesktopShellEnvironment.ts) does this:

1. Tries shells in order: `$SHELL`, then `/bin/zsh` on macOS or `/bin/bash` on Linux ([#L159-L176](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/shell/DesktopShellEnvironment.ts#L159-L176)).
2. Runs `<shell> -ilc "printf '%s\n' '__T3CODE_ENV_PATH_START__'; printenv PATH || true; printf ...END__; ..."` for PATH, `SSH_AUTH_SOCK`, `HOMEBREW_*`, `XDG_*`, `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` and the locale variables, with a 5-second timeout, and cuts each value out between its markers so shell banners don't corrupt it ([#L70-L95](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/shell/DesktopShellEnvironment.ts#L70-L95), [#L213-L321](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/shell/DesktopShellEnvironment.ts#L213-L321)).
3. If no shell produced a PATH on macOS, runs `/bin/launchctl getenv PATH` with a 2-second timeout ([#L323-L328](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/shell/DesktopShellEnvironment.ts#L323-L328)).
4. Puts the shell's PATH first, appends the inherited PATH, drops duplicates, and fills the other variables only where they are missing. On macOS, if no locale variable is set, it sets `LC_CTYPE=en_US.UTF-8`, because "GUI launches inherit no locale from launchd, so spawned agents land in the C locale and pbcopy decodes their UTF-8 output as MacRoman" ([#L397-L498](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/shell/DesktopShellEnvironment.ts#L397-L498)).

Windows runs PowerShell twice at once, with and without the profile, and adds known CLI folders such as `%APPDATA%\npm` and `%USERPROFILE%\.local\bin`. The server does its own pass at startup, `fixPath`, with the same login-shell and launchctl steps plus a fallback for an empty `HOME`, which covers `npx t3` and the background service ([os-jank.ts#L20-L91](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/os-jank.ts#L20-L91), [server.ts#L626](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/server.ts#L626)). The server inherits main's environment because the spawn uses `extendEnv: true`.

### Claude and Codex

Claude runs in-process through the Agent SDK. The query options set `pathToClaudeCodeExecutable: claudeBinaryPath` and pass an explicit `env` ([ClaudeAdapter.ts#L4901-L4938](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4901-L4938)). The binary path is a setting whose default is `claude` ([contracts settings.ts#L637](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/packages/contracts/src/settings.ts#L637)). On macOS and Linux it goes to the SDK unchanged, and the SDK spawns it without a shell, so Node looks `claude` up on the hydrated PATH. On Windows the server resolves it against PATH and PATHEXT itself and follows an npm `.cmd` shim to `bin/claude.exe` or `cli.js`, because "The SDK spawns the given path without a shell and without Windows PATH / PATHEXT resolution" ([ClaudeExecutable.ts#L46-L90](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/provider/Drivers/ClaudeExecutable.ts#L46-L90)). The running app shows three `claude --output-format stream-json --input-format stream-json ... --permission-prompt-tool stdio --mcp-config {...}` processes as direct children of the server, each pointed at the server's MCP endpoint `http://127.0.0.1:3773/mcp`. Reading old sessions happens in a worker the server spawns as `process.execPath claude-history-worker.mjs` with `ELECTRON_RUN_AS_NODE=1` ([ClaudeAdapter.ts#L5340-L5355](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5340-L5355)).

Codex runs as a child, `codex app-server` plus any launch arguments, through `resolveSpawnCommand`, which can fall back to a shell on Windows. It gets the inherited environment plus `CODEX_HOME` when one is configured ([CodexSessionRuntime.ts#L1325-L1360](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1325-L1360)).

### The `ELECTRON_RUN_AS_NODE` leak

The server inherits `ELECTRON_RUN_AS_NODE=1`, and so does everything it starts unless someone removes it. The terminal manager does: `const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"])` ([terminal/Manager.ts#L103](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/server/src/terminal/Manager.ts#L103)). The Claude and Codex paths don't. `ps -E` on a running `claude` child shows `ELECTRON_RUN_AS_NODE=1` next to `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, and the shell of this research session, launched by T3 Code's Claude, has it too. Any Electron app an agent launches from there, such as `electron .` for Frame Studio's own M10 work, would start as plain Node instead of opening a window. T3's `dev-electron.mjs` deletes the variable before it spawns Electron.

## 6. Other desktop details

Worth copying:

- **Single instance.** The Clerk Electron bridge takes Electron's single-instance lock. A second instance quits, and the first one's `second-instance` handler reveals its window ([DesktopClerk.ts#L129-L150](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopClerk.ts#L129-L150)). Without Clerk, `app.requestSingleInstanceLock()` does the same. T3 also listens on a local control socket so its CLI can bring the app forward ([DesktopAppActivation.ts](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopAppActivation.ts)).
- **The window.** It starts hidden and shows on `ready-to-show`, with a background colour that matches the theme, and uses a `hiddenInset` title bar on macOS. It saves its bounds and maximized state to the desktop settings file. Its `webPreferences` are `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` ([DesktopWindow.ts#L401-L455](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/window/DesktopWindow.ts#L401-L455)).
- **Navigation guards.** `setWindowOpenHandler` denies every new window and opens safe external URLs in the browser. `will-navigate` cancels any navigation away from the app's origin and sends it to the browser too ([DesktopWindow.ts#L605-L625](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/window/DesktopWindow.ts#L605-L625)).
- **Renderer crashes.** On `render-process-gone` with `crashed`, `oom` or `abnormal-exit`, the window reloads, a bounded number of times, since "the renderer rehydrates from the backend, which is unaffected" ([DesktopWindow.ts#L775-L800](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/window/DesktopWindow.ts#L775-L800)).
- **Startup failure.** A fatal error during startup shows an error box, "T3 Code failed to start", with the stage and the stack, then quits ([DesktopApp.ts#L109-L141](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopApp.ts#L109-L141)).
- **Quitting.** `before-quit` is held until every backend has stopped, with a 5-second cap. The updater's own quit is let through. `window-all-closed` quits everywhere but macOS, and SIGINT and SIGTERM quit cleanly ([DesktopLifecycle.ts#L195-L265](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopLifecycle.ts#L195-L265), [DesktopApp.ts#L146-L158](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopApp.ts#L146-L158)).
- **Logs.** Files go to `<state>/logs`: `desktop-main.log`, `server-child.log` with the server's stdout and stderr, and a trace file, each rotated at 10 MB with 10 kept ([DesktopObservability.ts#L33-L60](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/app/DesktopObservability.ts#L33-L60)). The installed app writes them to `~/.t3/userdata/logs`.
- **Menus.** Standard roles plus Settings, Check for Updates and Paste as Text, with custom items sent to the page as menu actions ([DesktopApplicationMenu.ts#L155-L240](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/window/DesktopApplicationMenu.ts#L155-L240)).
- **Deep links.** `t3code://` and `t3code-dev://` are registered through electron-builder's `protocols`, mostly for sign-in callbacks.
- **Startup speed.** `boot.cjs` turns on Node's V8 compile cache before loading `main.cjs`, and packaged builds pass it to the server with `--require` so it doesn't leak into agent processes ([compileCache.ts](https://github.com/pingdotgg/t3code/blob/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4/apps/desktop/src/compileCache.ts)).

Worth avoiding or doing differently:

- Probing a port and handing it to the server, which can race. A server that listens on port 0 and reports its port back to main over the pipe can't collide.
- Leaking `ELECTRON_RUN_AS_NODE` to agent processes.
- The scale. The desktop app has 265 files, about half of them tests, and most of it serves WSL, SSH, Tailscale, Clerk and passkeys, the preview browser, screenshots and Linux desktop integration. The part Frame Studio needs is the spawn, the envelope, the readiness poll, the PATH pass, the bootstrap IPC and the build script's first half.
- I found no crash reporter, and no code that stops the server if Electron dies without running its quit path, for example after `SIGKILL`. I didn't test whether the server outlives it.

## 7. What Frame Studio should take

Each point is a proposal for ticket 19 to settle.

1. **Spawn.** In main, `spawn(process.execPath, [serverEntry, '--bootstrap-fd', '3'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })`, then write one JSON line to `stdio[3]` with the token, the data folders and the bind host, and end it. That keeps the token out of `ps`. Leave the `RunAsNode` fuse on, or switch to `utilityProcess` if we ever turn it off. Electron 44.1.0's Node mode ran a `.ts` file directly through type stripping, so in development main could start `tools/studio/server.ts` from source.
2. **Port.** Have the server listen on `127.0.0.1` port 0 and write its port back to main on a second pipe, instead of T3's probe. Main then polls an unauthenticated readiness route, like `/.well-known/t3/environment`, before it shows the window.
3. **Renderer origin.** T3 serves the page from a custom scheme and talks to the server cross-origin with a bearer token. The simpler choice for us may be to have the studio server serve the built viewer, as `npx t3` does, and load `http://127.0.0.1:<port>/` with a cookie session. That keeps one origin in the web app, the Vite dev server and Electron, and it matches ADR 0001's single protocol. The cost is that the window can't open before the server is up, and the page's origin, with its `localStorage`, changes with the port. Ticket 19 should pick one.
4. **Token.** 24 random bytes in main, sent over the pipe. The preload exposes `window.studio.getServer()` returning `{ url, token }` through `contextBridge` and `ipcRenderer.sendSync`. The page swaps the token for an HttpOnly SameSite=Lax cookie, or a bearer token if cross-origin, and authenticates the WebSocket with the cookie or a short ticket in the query string. For the web app without Electron, print `http://127.0.0.1:<port>/pair#token=...` and strip the fragment after use, the way `npx t3` does. The MCP HTTP endpoint needs the same check, with the per-session bearer tokens the integrated-AI research already proposes.
5. **IPC.** Keep to the bootstrap call plus native features: file and folder pickers, reveal in Finder, open external, menus, window state, updates. That is what ADR 0001 already says.
6. **The Agent SDK in the package.** Bundle the studio server with Vite's SSR build, esbuild or Rolldown into one file that inlines `@anthropic-ai/claude-agent-sdk` and `@modelcontextprotocol/sdk`. Then no `node_modules` ships and the platform binary can't come along. Keep `!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*` and `!**/*.map` in electron-builder's `files` as a second guard. Add a check after packaging that runs `npx @electron/asar list` on the built `app.asar` and `find` over the `.app`, and fails on any path containing `claude-agent-sdk-` or on an app bigger than a set ceiling. Always pass `pathToClaudeCodeExecutable`, since without it the SDK throws when the platform package is missing.
7. **PATH.** Copy T3's login-shell pass into main before spawning the server: `$SHELL -ilc` with marker lines, a 5-second timeout, `launchctl getenv PATH` as the fallback, merged ahead of the inherited PATH, plus `LC_CTYPE=en_US.UTF-8` when no locale is set. Our `tools/studio/agents/exec.ts` finds `claude` and `codex` by walking `process.env.PATH`, so from Finder it would fail without this. Resolve the binary to an absolute path before passing it to the SDK.
8. **Child environments.** Delete `ELECTRON_RUN_AS_NODE` from the environment of every agent CLI and shell the server starts, and in any dev script that launches Electron.
9. **Packaging and release.** electron-builder with a generated stage `package.json`, `electronLanguages: ['en-US']`, asar on, macOS `dmg` plus `zip` for updates, Developer ID signing and notarization through the `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` variables, and electron-updater on GitHub Releases once we publish. Build each architecture on its own runner.
10. **Desktop basics.** The single-instance lock, saved window bounds, sandboxed renderer with context isolation, the navigation guards, a bounded reload after a renderer crash, rotating logs with the server's output in its own file, backend restart with backoff, and a clean stop of the server on quit.

## Open questions and things I didn't verify

- Whether the server outlives Electron after a crash or `SIGKILL`. I didn't kill the running app to find out.
- Whether a cross-site page can open T3's WebSocket with the user's cookie. SameSite=Lax should prevent it, and I didn't test it.
- Why T3 chose `spawn` over `utilityProcess`. The reasoning in section 1 is my inference from the same server running under plain Node for the CLI, SSH and WSL.
- Signing and packaging on Windows and Linux rest on reading the build script and workflows, not on running them.
- The macOS build numbers come from the installed arm64 app and the release assets. I didn't build a Frame Studio package, so its size is an estimate built on Electron's 236 MB.
- Ticket 19 will also need something I didn't research here. The packaged studio has no Vite, so agent-edited rigs in `src/rigs/` and `projects/<id>/rigs/` need another way to compile and load, and the viewer's `import.meta.glob` scene loading needs the file-backed store ADR 0001 mentions.

## Sources

- T3 Code at commit `8aa5be2`, 2026-09-25: https://github.com/pingdotgg/t3code/tree/8aa5be2f02c3b4b9b5b3b86acbf5f2b0467438f4. Files are linked inline. The main ones:
  - Desktop: `apps/desktop/package.json`, `vite.config.ts`, `src/main.ts`, `src/boot.ts`, `src/compileCache.ts`, `src/preload.ts`, `src/app/{DesktopApp,DesktopEnvironment,DesktopLifecycle,DesktopClerk,DesktopObservability,DesktopAppActivation}.ts`, `src/backend/{DesktopBackendManager,DesktopBackendConfiguration,DesktopBackendPool,DesktopServerExposure,DesktopLocalEnvironmentAuth}.ts`, `src/electron/ElectronProtocol.ts`, `src/ipc/{channels,DesktopIpcHandlers}.ts`, `src/ipc/methods/window.ts`, `src/shell/DesktopShellEnvironment.ts`, `src/window/{DesktopWindow,DesktopApplicationMenu}.ts`, `src/settings/DesktopSavedEnvironments.ts`, `scripts/{dev-electron,electron-launcher,smoke-test}.mjs`.
  - Server: `apps/server/package.json`, `vite.config.ts`, `scripts/cli.ts`, `src/{bootstrap,server,http,ws,os-jank,startupAccess,serverRuntimeStartup}.ts`, `src/cli/config.ts`, `src/auth/{EnvironmentAuth,EnvironmentAuthPolicy,PairingGrantStore,SessionStore,http}.ts`, `src/provider/Drivers/ClaudeExecutable.ts`, `src/provider/Layers/{ClaudeAdapter,CodexSessionRuntime}.ts`, `src/terminal/Manager.ts`.
  - Web and shared: `apps/web/vite.config.ts`, `apps/web/src/environments/primary/{auth,desktopAuth,httpLayer,target}.ts`, `packages/contracts/src/{desktopBootstrap,environmentHttp,settings}.ts`, `packages/client-runtime/src/authorization/remote.ts`, `packages/shared/src/devProxy.ts`.
  - Build and release: `scripts/build-desktop-artifact.ts`, `scripts/lib/{cli-external-packages,desktop-external-packages}.ts`, `scripts/sign-macos.ts`, `scripts/dev-runner.ts`, `.github/workflows/{release,release-desktop}.yml`.
  - Docs: `docs/internals/environment-auth.md`, `docs/operations/development.md`, `docs/operations/release.md`.
- T3 Code at commit `dd32f52`, the plain-Node desktop before the port to Effect: https://github.com/pingdotgg/t3code/blob/dd32f52655d08d1cbab9149ac44b0a63665779db/apps/desktop/src/main.ts and `apps/desktop/src/preload.ts`.
- PR #4824, "build(desktop): reduce installed app size by ~300MB", commit `72b960f`, 2026-07-29: https://github.com/pingdotgg/t3code/pull/4824
- PR #5877, "perf(build): stop unpacking node_modules wholesale from the Windows asar", commit `7e01d33`, 2026-08-13: https://github.com/pingdotgg/t3code/commit/7e01d33f0eeb9435299791392d546756cc09c5d3
- Release v0.0.42, commit `719a76c`, and nightly `v0.0.43-nightly.20260925.2269`, asset lists from `gh release view`: https://github.com/pingdotgg/t3code/releases/tag/v0.0.42
- The installed `/Applications/T3 Code (Alpha).app`: `Contents/Info.plist`, `Contents/Frameworks/Electron Framework.framework/Resources/Info.plist`, `Contents/Resources/app-update.yml`, `app.asar` extracted with `npx @electron/asar extract`, `codesign -dv`, `codesign -d --entitlements`, `spctl -a -vv`, `npx @electron/fuses read`, and `ps` and `lsof` on the running app.
- electron-builder 26.15.6, `app-builder-lib` `out/options/macOptions.d.ts` on `notarize` and `out/mac/MacTargetHelper.js` `getNotarizeOptions`, from the npm tarball: https://www.npmjs.com/package/app-builder-lib
- `@anthropic-ai/claude-agent-sdk` 0.3.282 `package.json` and `sdk.mjs` in Frame Studio's `node_modules`, and 0.3.260 as bundled in the installed T3 app.
