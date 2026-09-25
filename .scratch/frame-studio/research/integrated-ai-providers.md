# How can the integrated AI connect to Claude, ChatGPT and other models?

Research for [issue 16](../issues/16-m8-integrated-ai.md). Checked 2026-09-24 against Anthropic's Claude Code and Agent SDK docs on code.claude.com, the Claude Help Center, Anthropic's Consumer Terms, OpenAI's Codex docs on learn.chatgpt.com, OpenAI's Terms of Use, the openai/codex and google-gemini/gemini-cli repositories, OpenCode's docs, the npm registry, and T3 Code at commit `720490a` of 2026-09-24, shallow-cloned into `/tmp`. Versions on npm that day: `@anthropic-ai/claude-agent-sdk` 0.3.282, `@openai/codex` and `@openai/codex-sdk` 0.156.1, `@google/gemini-cli` 0.61.0, `opencode-ai` 1.18.32. I read docs, terms and source. I didn't run any provider. x.com and help.openai.com refused automated fetches, so a few statements rest on press reports or archived copies, and I mark them where they appear.

## Question

M8 puts an AI inside the studio. ADR 0004 says it connects to Claude, ChatGPT or other models through the user's subscription or their own API key, and that the studio provides the interface, not the model. It runs in the local studio server now, in Electron later, and in a web backend after that. Five things need answers before the ticket can settle scope:

1. Can a third-party app use someone's Claude subscription through the Claude Agent SDK or the user's installed `claude`? What do Anthropic's docs and terms say about that and about branding, which auth methods does the SDK take, and does it bundle Claude Code?
2. How does `codex app-server` work, how does sign-in work, may a third-party client drive it with the user's ChatGPT sign-in, and what does the Codex SDK use?
3. How does T3 Code do all this: providers, how each one starts, where sign-in happens, whether it touches credentials, how events reach the UI, and how approvals work?
4. Which other options are worth noting, and which of them run on a server with only an API key?
5. What rules apply to running any of this from a hosted backend for other people?

## Short answer

Anthropic's pages disagree with each other. The Agent SDK overview and quickstart both say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." The Claude Code legal page is more specific. It forbids a third-party app from offering Claude.ai login, from routing requests "through Free, Pro, or Max plan credentials on behalf of their users", and from collecting, storing or intermediating Claude.ai tokens, and then says this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". The Help Center's 2026-06-15 update says "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits", and its preserved earlier text names "Third-party apps that authenticate with your Claude subscription through the Agent SDK" as a known category. My reading: pointing the SDK at the user's own installed and signed-in `claude`, as T3 Code does, falls in the case the legal page allows. A login button of ours, reading or storing their tokens, or advertising "use your Claude plan" needs Anthropic's approval. Ask Anthropic in writing before shipping it. Branding may say "Claude Agent", "Claude" inside an "Agents" menu, or "Frame Studio Powered by Claude", never "Claude Code".

The TypeScript Agent SDK is `@anthropic-ai/claude-agent-sdk`, 0.3.282. It bundles a native Claude Code binary through per-platform optional dependencies, 222 MB unpacked on darwin-arm64, and `pathToClaudeCodeExecutable` points it at the user's own `claude` instead. It authenticates the way the CLI does: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `apiKeyHelper` script, `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, Microsoft Foundry, or whatever `/login` stored. Its licence is proprietary: "© Anthropic PBC. All rights reserved."

`codex app-server` speaks JSON-RPC 2.0, without the `"jsonrpc"` field on the wire, over newline-delimited JSON on stdio by default. WebSocket and Unix-socket listeners exist and are marked experimental. A client sends `initialize`, then `thread/start` and `turn/start`, and reads `item/*` and `turn/*` notifications. Approvals arrive as server-to-client requests such as `item/commandExecution/requestApproval`. Sign-in is `account/login/start` with `apiKey`, `chatgpt`, `chatgptDeviceCode` or the experimental `chatgptAuthTokens`. In the `chatgpt` mode "Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them automatically." OpenAI pitches app-server for "a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events". I found no OpenAI text that forbids a third-party client from driving it with the user's ChatGPT sign-in. OpenAI's Codex for Open Source page says developers should use "the tools they prefer, whether that's Codex, OpenCode, Cline, pi, OpenClaw, or something else", but no OpenAI page I could fetch grants that permission outright. `@openai/codex-sdk` 0.156.1 spawns `codex exec --experimental-json` and uses `CODEX_API_KEY` when given an `apiKey`, else whatever login the CLI has stored. Both are Apache-2.0.

T3 Code supports Codex, Claude, Cursor, Grok Build, OpenCode and Antigravity. Claude runs through the Agent SDK with `pathToClaudeCodeExecutable` set to the user's `claude`. Codex runs as a spawned `codex app-server` on stdio. Cursor, Grok and Antigravity run as Agent Client Protocol agents on stdio. OpenCode runs as `opencode serve` driven by `@opencode-ai/sdk`. Users sign in inside each CLI, and T3 never handles a Claude or ChatGPT token. It does store API keys that users type into a provider's environment variables, in 0600 files under its state directory. Antigravity is the exception: T3 drives the Google sign-in page, but the agent process does the token exchange and storage. Every adapter turns native events into one `ProviderRuntimeEvent` union. The server records them in an SQLite event log and streams them to clients over one WebSocket running Effect RPC with JSON. There are four modes: Supervised, Auto-accept edits, Auto and Full access, which is the default. An approval shows up as a `request.opened` event, and the client answers with a `thread.approval.respond` command.

With only an API key, the Agent SDK, Codex, Gemini CLI, OpenCode and the plain Anthropic Messages and OpenAI Responses APIs all run on a server. Subscriptions need a local CLI login: Claude via `claude auth login`, ChatGPT via `codex login`, Google via Gemini CLI's own sign-in, plus Cursor, Grok and Antigravity. Google's Gemini CLI terms forbid third-party software from using its OAuth.

A hosted backend should use API keys only. Anthropic lets a platform run Claude Code for others under the Commercial Terms, with the binary unmodified, each user signing in with their own credential, and no paying for, reselling or intermediating their usage. OpenAI says app-server "and WebSocket transport are experimental and aren't supported for production workloads" and "Don't expose Codex execution in untrusted or public environments." Its Sign in with ChatGPT for partner sites shares name, email and picture only, not model access.

## 1. Anthropic: subscriptions, the Agent SDK and branding

### What the docs and terms say about subscriptions

The Agent SDK overview carries this note, and the quickstart repeats it next to the API-key step:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.

The Claude Code legal and compliance page has the longer rule, under "Authentication and credential use":

> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> This does not restrict how customers provision and manage their own API keys or third-party inference provider credentials [...] Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

The same page says "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." Claude Code on Free, Pro and Max falls under the Consumer Terms, effective 2025-10-08. A bullet in section 3, "Use of our Services", forbids accessing the services "through automated or non-human means, whether through a bot, script, or otherwise" except "when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it". Section 2, "Account creation and access", says "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else."

The Help Center article "Use the Claude Agent SDK with your Claude plan" shows how Anthropic meters this today. Its top reads:

> Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription's usage limits. [...] When we have an update, we'll share it before anything takes effect.

The preserved text below the update describes a monthly Agent SDK credit, $20 on Pro up to $200 on Max 20x, that would have covered "Third-party apps that authenticate with your Claude subscription through the Agent SDK" from 2026-06-15. It also says "Teams running shared production automation should use Claude Platform with an API key".

The history behind that, from press reports I couldn't check against a primary source: on 2026-04-04 Anthropic stopped counting third-party harnesses such as OpenClaw against subscription limits. Boris Cherny's post, as quoted in search results and TechCrunch, reads "Starting tomorrow at 12pm PT, Claude subscriptions will no longer cover usage on third-party tools like OpenClaw. You can still use these tools with your Claude login via extra usage bundles (now available at a discount), or with a Claude API key." Those tools had been sending the user's OAuth token straight to the API. On 2026-05-13 Anthropic announced the Agent SDK credit, according to VentureBeat, and paused it on 2026-06-15. OpenClaw's docs now reuse the user's Claude CLI login and say "Claude Code owns its existing login and subscription; OpenClaw does not persist or refresh that login." OpenCode's provider docs say of Claude Pro/Max plugins, "Anthropic explicitly prohibits this", and OpenCode stopped bundling them in 1.3.0.

Taken together, a third-party app that sends a user's subscription OAuth token to the API itself is out. An app that spawns the unmodified `claude` binary, which the user signed in to through Anthropic's own flow, is the one case the legal page allows, and the Help Center meters it against the user's plan. The Agent SDK's "unless previously approved" note still hangs over any product that offers this as a feature. Anthropic may enforce "without prior notice", so the studio should always keep an API-key path working.

### Branding

From the Agent SDK overview:

> For partners integrating the Claude Agent SDK, use of Claude branding is optional. When referencing Claude in your product:
>
> Allowed: "Claude Agent", preferred for dropdown menus; "Claude", when within a menu already labeled "Agents"; "{YourAgentName} Powered by Claude", if you have an existing agent name
>
> Not permitted: "Claude Code" or "Claude Code Agent"; Claude Code-branded ASCII art or visual elements that mimic Claude Code
>
> Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product.

The legal page adds that a product may say "in plain text, that your product has Claude Code preinstalled or that it runs Claude Code", but may not use the Claude Code or Anthropic names or logos in its own product, feature, company name or logo. Other use needs written permission under the Trademark Guidelines.

The SDK itself falls under the Commercial Terms, "including when you use it to power products and services that you make available to your own customers and end users".

### Auth methods

The quickstart lists `ANTHROPIC_API_KEY` from the Claude Console, plus `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` with `ANTHROPIC_AWS_WORKSPACE_ID`, `CLAUDE_CODE_USE_VERTEX=1` and `CLAUDE_CODE_USE_FOUNDRY=1`. The SDK runs the CLI, so the CLI's credential order also applies. Claude Code's authentication page gives it: cloud provider variables first, then `ANTHROPIC_AUTH_TOKEN` as a bearer token for gateways, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profile and federation credentials, and last the subscription login from `/login`. That page says `apiKeyHelper`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` "apply to the CLI and the surfaces that wrap it, including the VS Code extension, the Agent SDK, and GitHub Actions".

`CLAUDE_CODE_OAUTH_TOKEN` holds a one-year token that `claude setup-token` prints. "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan." It is meant for the user's own CI and scripts. A studio that asked users to paste one would be collecting a Claude.ai credential, which the legal page forbids.

Login state lives in the macOS Keychain, or in `~/.claude/.credentials.json` with mode 0600 on Linux and as a Keychain fallback. `CLAUDE_CONFIG_DIR` moves both the file and the Keychain entry, which is how T3 Code keeps a second account separate. The SDK's init result reports the account, including `subscription_type` of `pro`, `max`, `team`, `enterprise` or null for API-key and cloud sessions, and `apiKeySource`.

### Packaging

- Package `@anthropic-ai/claude-agent-sdk`, version 0.3.282, published 2026-09-24. Peer dependencies are `zod` ^4, `@modelcontextprotocol/sdk` ^1.29 and `@anthropic-ai/sdk` >=0.93.0. The repo already pins zod 4.6.5 and the MCP SDK 1.30.1.
- The quickstart says: "Both the TypeScript and Python SDKs bundle a native Claude Code binary, so most installs need no separate Claude Code install." The TypeScript binary comes from eight optional dependencies such as `@anthropic-ai/claude-agent-sdk-darwin-arm64`, 222 MB unpacked. An install with `--omit=optional` gets no binary, and then `pathToClaudeCodeExecutable` must name one. The hosting page adds that "The bundled binary is pinned to the SDK package version, so updating the SDK is how you update the CLI."
- The SDK spawns one `claude` subprocess per session and talks to it over stdio. It accepts `mcpServers`, including in-process servers built with `createSdkMcpServer()` and `tool()`, plus `canUseTool`, `permissionMode`, `allowedTools`, `disallowedTools`, `settingSources`, `cwd`, `env` and `resume`.
- The permission modes are `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan` and `auto`, where `auto` is "Model-classified approvals". A call goes through hooks, deny rules, ask rules, the mode, allow rules and then `canUseTool`, in that order. `dontAsk` with an `allowedTools` list gives a fixed tool set that never prompts.
- The licence file reads "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." Shipping the bundled binary inside our Electron app means redistributing Anthropic's proprietary program, and the legal page's "Can customers offer Claude Code in their products?" section sets conditions for preinstalling it. Using the user's own `claude` sidesteps both.

## 2. OpenAI: codex app-server, sign-in and the Codex SDK

### Protocol and transport

From the App Server page, which moved from developers.openai.com to learn.chatgpt.com:

> Codex app-server is the interface Codex uses to power rich clients (for example, the Codex VS Code extension). Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events.

> Like MCP, codex app-server supports bidirectional communication using JSON-RPC 2.0 messages (with the "jsonrpc":"2.0" header omitted on the wire).

Transports are `stdio://`, the default, carrying newline-delimited JSON; `ws://IP:PORT`, "experimental and unsupported", one message per text frame; `unix://`, WebSocket over a Unix socket; and `off`. Non-loopback WebSocket listeners "currently allow unauthenticated connections by default during rollout", and `--ws-auth` flags add capability-token or signed-bearer auth. The page also says "The app-server command and WebSocket transport are experimental and aren't supported for production workloads."

A client sends one `initialize` with `clientInfo`, then an `initialized` notification. OpenAI asks integrators to "Use clientInfo.name to identify your client for the OpenAI Compliance Logs Platform. If you are developing a new Codex integration intended for enterprise use, please contact OpenAI to get it added to a known clients list." A Thread holds Turns, and a Turn holds Items: messages, command runs, file changes and tool calls. The flow is `thread/start` or `thread/resume`, then `turn/start`, with `turn/steer` and `turn/interrupt` available mid-turn. The server streams `item/started`, `item/agentMessage/delta`, `item/completed` and finally `turn/completed`. Some methods need `capabilities.experimentalApi`, including `dynamicTools` on `thread/start`, which lets the client run its own tools through `item/tool/call`. MCP servers configured in Codex's config, or passed as `-c mcp_servers.<name>.url=...` overrides, work without that flag.

Approvals are server-initiated JSON-RPC requests, `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`. The client answers `accept`, `acceptForSession`, `decline` or `cancel`, plus an exec-policy amendment for commands. `serverRequest/resolved` and `item/completed` follow. `thread/start` takes `approvalPolicy`, `sandbox` and `approvalsReviewer`.

### Sign-in

App-server's auth endpoints, verbatim:

> API key (apikey) - the caller supplies an OpenAI API key with type: "apiKey", and Codex stores it for API requests.
>
> ChatGPT managed (chatgpt) - Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them automatically. Start with type: "chatgpt" for the browser flow or type: "chatgptDeviceCode" for the device-code flow.
>
> ChatGPT external tokens (chatgptAuthTokens) - experimental and intended for host apps that already own the user's ChatGPT auth lifecycle. The host app supplies an accessToken, chatgptAccountId, and optional chatgptPlanType directly, and must refresh the token when asked.

Amazon Bedrock is a fourth mode. `account/read` returns the account type, email and `planType`, and `account/rateLimits/read` returns ChatGPT rate limits. A client can therefore show "Signed in as ... on Plus" and start a login without touching a token. In the managed mode Codex runs the browser flow and its own localhost callback.

The Authentication page says Codex supports "Sign in with ChatGPT for subscription access" and "Sign in with an API key for usage-based access", and that "When you sign in with an API key, Codex uses standard API pricing instead of included ChatGPT plan credits." Credentials sit "in a plaintext file at ~/.codex/auth.json or in your OS-specific credential store", chosen by `cli_auth_credentials_store` as `file`, `keyring`, `auto` or `ephemeral`. `CODEX_HOME` moves the directory. Admins can force a login method with `forced_login_method`.

### May a third-party client use the user's ChatGPT sign-in?

I found no OpenAI document that says yes or no in those words. The evidence for yes:

- The app-server page offers `authentication` as a reason to embed it in "your own product", and its `chatgpt` mode exists so a host can start a ChatGPT login that Codex owns.
- The `clientInfo` paragraph expects new third-party integrations and asks only enterprise ones to register.
- The Codex for Open Source page, fetched directly: "Developers should code in the tools they prefer, whether that's Codex, OpenCode, Cline, pi, OpenClaw, or something else, and this program supports that work."
- OpenCode's docs list "ChatGPT Plus" among subscriptions that work "with zero setup", under the line "Other companies support freedom of choice with developer tooling".
- Press and blog reports quote OpenAI's Thibault Sottiaux: "you can use your ChatGPT account (the paid OpenAI subscription that starts at $20/month with Plus) inside third-party harnesses". I couldn't load the post itself.

The limits come from OpenAI's Terms of Use, effective 2026-01-01, which cover ChatGPT and "OpenAI's other services for individuals": "You may not share your account credentials or make your account available to anyone else", and you may not "Automatically or programmatically extract data or Output" or "circumvent any rate limits or restrictions". A local studio that spawns the user's own `codex` and lets Codex hold the login shares nothing with us. A hosted service holding users' ChatGPT tokens would be closer to both clauses.

### The Codex SDK

`@openai/codex-sdk` 0.156.1, Apache-2.0, is for automation. The README says "The TypeScript SDK wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges JSONL events over stdin/stdout." The source spawns `codex exec --experimental-json`. It has `startThread()`, `run()`, `runStreamed()`, `resumeThread()`, structured output and an `env` option "useful for sandboxed hosts like Electron apps". Auth is whatever the CLI has, or `CODEX_API_KEY` when you pass `apiKey`. The app-server page says to use it "If you are automating jobs or running Codex in CI". It has no approval round trip, so an interactive studio wants app-server. The CLI's darwin-arm64 package is 326 MB unpacked.

## 3. T3 Code

Commit `720490a`, `apps/server` version 0.0.42. Paths below are relative to the repo root.

### Providers and how each starts

README: "T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use". Drivers live in `apps/server/src/provider/Drivers/` and are listed in `builtInDrivers.ts`. Adapters live in `apps/server/src/provider/Layers/`.

| Provider | How T3 starts it | Where | Sign-in |
| --- | --- | --- | --- |
| Claude | Agent SDK `query()` with `pathToClaudeCodeExecutable` set to the user's `claude`; Windows npm shims are resolved to the real binary | `Layers/ClaudeAdapter.ts` around line 4914, `Drivers/ClaudeExecutable.ts` | `claude auth login`; status from `claude auth status`, with an SDK `initializationResult()` probe as fallback in `Layers/ClaudeProvider.ts` |
| Codex | Spawns `<binary> app-server`, JSON-RPC over stdio, through its own `packages/effect-codex-app-server` client generated from Codex's schema | `Layers/CodexSessionRuntime.ts` around line 1320, `Layers/codexLaunchArgs.ts` | `codex login`; status and plan from `account/read` in `Layers/CodexProvider.ts` |
| Cursor | Spawns `cursor-agent [-e endpoint] <permission args> acp`, Agent Client Protocol over stdio | `acp/CursorAcpSupport.ts`, `acp/AcpSessionRuntime.ts`, `packages/effect-acp` | `agent login` |
| Grok Build | Spawns `grok --permission-mode <mode> agent stdio`, or `grok agent --always-approve stdio` for full access | `acp/GrokAcpSupport.ts` | `grok login` |
| OpenCode | Spawns `opencode serve --hostname --port` per thread and drives it with `@opencode-ai/sdk` over HTTP and SSE | `opencodeRuntime.ts`, `OpenCodeServerOwner.ts`, `Layers/OpenCodeAdapter.ts` | `opencode auth login` |
| Antigravity | Google's ACP agent, which T3 installs and version-leases itself | `Layers/AntigravityAdapter.ts`, `AntigravityInstallation.ts` | In T3's settings UI, see below |

Each provider can have several instances, each with its own binary path, launch arguments, environment variables and config home. `docs/user/providers-claude.md` shows a second Claude account through `CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login` and routing through OpenRouter by setting `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` on an instance. `docs/user/providers-codex.md` does the same for Codex with `CODEX_HOME` and a "shadow home".

### Does it handle credentials?

Not for Claude or ChatGPT logins. Both CLIs sign in and store their own tokens, and T3 only reads status. The docs say "T3 Code uses Claude Code's login and configuration." It does keep API keys that a user types into an instance's environment variables. A variable marked sensitive is stored through `apps/server/src/auth/ServerSecretStore.ts` as a file with mode 0600 in a 0700 `secrets` directory under T3's state directory, see `serverSettings.ts`, and is injected into the provider's environment at spawn.

Antigravity is the one provider whose sign-in T3 drives. `docs/internals/providers.md` says: "Antigravity sign-in belongs to the initiating T3 auth session. The client carries the return URL back to the environment because the provider's loopback listener may be on another machine. [...] The native process owns token exchange and storage." `apps/server/src/provider/AntigravityAuth.ts` implements it. A generic `ProviderAuthFlow.ts` and an opaque-bytes `ProviderCredentialStore.ts` exist, but at this commit nothing outside their tests imports the credential store.

T3 also serves its own tools to every agent as an MCP server over HTTP with a per-thread bearer token. Claude gets it through the SDK's `mcpServers` option, Codex through `-c mcp_servers.t3-code.url=...` and `bearer_token_env_var`, and ACP agents through `session/new`. See `apps/server/src/mcp/McpProviderSession.ts`, `Layers/ClaudeAdapter.ts` around line 4953 and `Layers/CodexAdapter.ts` around line 2300.

### Events and transport

- The adapter contract is `apps/server/src/provider/Services/ProviderAdapter.ts`. It has `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`, `readThread`, `rollbackThread` and a `streamEvents` stream.
- Every adapter emits the union in `packages/contracts/src/providerRuntime.ts`: `session.*`, `thread.*`, `turn.started`, `turn.completed`, `turn.aborted`, `turn.plan.updated`, `turn.diff.updated`, `item.started`, `item.updated`, `item.completed`, `content.delta`, `request.opened`, `request.resolved`, `user-input.requested`, `user-input.resolved`, `tool.progress`, `auth.status`, `account.rate-limits.updated`, `runtime.warning`, `runtime.error` and more. Each event keeps the native payload in `raw`.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` turns those into orchestration commands. The decider writes events to an SQLite event log, and projections follow. `docs/internals/overview.md` says "The event log is the source of truth for orchestration state."
- Clients subscribe with `orchestration.subscribeThread` and send `orchestration.dispatchCommand`. Both run over one WebSocket served by Effect's `RpcServer` with `RpcSerialization.layerJson`, in `apps/server/src/ws.ts` around line 3844, defined in `packages/contracts/src/rpc.ts`. The web app, the Electron renderer and the phone app all connect this way.

### Permission modes and approvals

`packages/contracts/src/orchestration.ts` defines `RuntimeMode` as `approval-required`, `auto-accept-edits`, `auto` and `full-access`, with `DEFAULT_RUNTIME_MODE = "full-access"`. `docs/user/permission-modes.md`:

| Mode | Behavior |
| --- | --- |
| Supervised | Requests approval for commands and file changes. |
| Auto-accept edits | Approves file edits automatically; other actions can still require approval. |
| Auto | Uses the provider's automatic review to approve routine actions and ask about others. |
| Full access | Allows commands and edits without approval prompts. |

How each maps to a provider:

- Claude, in `ClaudeAdapter.ts` around line 4879: `auto-accept-edits` becomes `acceptEdits`, `auto` stays `auto`, `full-access` becomes `bypassPermissions` with `allowDangerouslySkipPermissions: true`, and Supervised leaves the SDK default so that prompts reach `canUseTool`.
- Codex, in `CodexSessionRuntime.ts` `runtimeModeToThreadConfig`: Supervised is `approvalPolicy: "untrusted"` with a `read-only` sandbox. Auto-accept edits is `on-request` with `workspace-write`. Auto is the same with `approvalsReviewer: "auto_review"`. Full access is `never` with `danger-full-access`.
- Grok and Cursor get CLI flags, and OpenCode gets replies to its permission prompts. For OpenCode, automatic full-access replies use `once` "so they cannot widen a supervised thread's permissions on a shared external server".

Approvals surface the same way everywhere. In the Claude adapter, `canUseTool` allows immediately in full access. Otherwise it makes a request id, emits `request.opened` with a request type such as `exec_command_approval` or `file_change_approval`, a summary and the tool input, then waits on a deferred. The user answers in the thread, the client sends `thread.approval.respond` with `accept`, `acceptForSession`, `acceptAlways`, `decline` or `cancel`, and the adapter emits `request.resolved` and returns allow or deny to the SDK. `acceptForSession` becomes SDK permission updates. Codex's `requestApproval` server requests take the same path. `AskUserQuestion` and Codex questions travel as `user-input.requested`.

## 4. Other options

- **Gemini CLI**, Apache-2.0. `gemini --acp` runs it as an ACP agent: "JSON-RPC protocol over stdio", the same protocol T3's Cursor, Grok and Antigravity adapters speak. It accepts "Logging in with your Google account to Gemini Code Assist", a Gemini API key, or a Vertex AI key or credentials. Its auth docs say headless mode needs the Gemini API key or Vertex AI. The terms page says: "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination of your account." Spawning the unmodified `gemini` does not access the service directly, but I found no Google text that says it is allowed either. T3 offers Google's Antigravity agent rather than Gemini CLI.
- **OpenCode**, MIT. `opencode serve` runs "a headless HTTP server that exposes an OpenAPI endpoint", on 127.0.0.1:4096 by default, with an `/event` SSE stream and optional basic auth through `OPENCODE_SERVER_PASSWORD`. It reaches "75+ LLM providers" through the AI SDK and Models.dev, plus local models, and stores keys in `~/.local/share/opencode/auth.json`. It is the easiest way to give "other models" to someone who already uses it, and it runs on a server with keys alone.
- **A plain BYOK loop**, meaning the Anthropic Messages API with tool use or the OpenAI Responses API with function calling, plus our own loop that calls the operations in `tools/mcp/workspace.ts`. Anthropic's overview lists this as the "Client SDK" route, where "You write the tool loop yourself, or let the client SDK's beta tool runner drive it." It needs no CLI, so it is the only one of these that works in a browser tab. `@anthropic-ai/sdk` 0.128.0 and `openai` 7.23.0 both refuse to run in a browser unless `dangerouslyAllowBrowser: true`, and the Anthropic SDK then sends `anthropic-dangerous-direct-browser-access: true`. It also covers OpenAI-compatible endpoints such as OpenRouter or a local model server.
- **Cursor, Grok Build and Antigravity** each need their own CLI login, and T3 reaches all three through ACP.

Which run with only an API key, and which need a local login:

| Option | API key alone, e.g. on a server | Subscription or account login |
| --- | --- | --- |
| Claude Agent SDK or `claude` | Yes: `ANTHROPIC_API_KEY`, Bedrock, Vertex, Foundry, Claude Platform on AWS | Local `claude auth login`, with the limits in section 1 |
| `codex app-server` or Codex SDK | Yes: `account/login/start` with `apiKey`, `codex login --with-api-key`, or `CODEX_API_KEY` for the SDK | Local `codex login` with ChatGPT |
| Gemini CLI | Yes: `GEMINI_API_KEY` or Vertex AI | Google sign-in; third-party use of its OAuth forbidden |
| OpenCode | Yes: any provider key | ChatGPT Plus and Copilot logins through its plugins; no Claude |
| Messages or Responses API | Yes, and nothing else | None |
| Cursor, Grok, Antigravity | Not checked | Their own CLI or Google login |

## 5. Hosted backends

Anthropic's legal page answers "Can customers offer Claude Code in their products?":

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
>
> The Claude Code binary must not be modified. [...] customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).
>
> Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential (Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry). That usage is billed directly to the end user under their own agreement with Anthropic or, for third-party inference providers, with the applicable provider.

The same page forbids developers to "collect, store, or intermediate Claude.ai credentials or session tokens". A hosted container running Claude Code keeps the user's login on our disk, and I can't tell from the text whether that counts as storing. The Agent SDK's hosting guide covers the mechanics: one subprocess per session, per-tenant `cwd` and `CLAUDE_CONFIG_DIR`, `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, "1 GiB RAM, 5 GiB disk, and 1 CPU per agent" as a starting point, and `ANTHROPIC_API_KEY` from a secret manager.

Two things conflict. The "may not pay for, resell, or intermediate" rule covers running Claude Code, while the Agent SDK's terms line allows using the SDK "to power products and services that you make available to your own customers". Whether an agent built on the SDK counts as "running Claude Code" decides whether a paid hosted studio could pay for its users' Claude usage through the SDK. The plain Messages API, or Anthropic's Managed Agents, under our own key and the Commercial Terms, has no such question.

OpenAI's rules for hosting are shorter. App-server "and WebSocket transport are experimental and aren't supported for production workloads." The Authentication page says to use API keys for programmatic Codex and "Don't expose Codex execution in untrusted or public environments." The Terms forbid sharing account credentials. `chatgptAuthTokens` is for "host apps that already own the user's ChatGPT auth lifecycle", which a studio backend doesn't. Sign in with ChatGPT for partner sites is identity only, and the Help Center says the app "receives only your name, email address, and profile picture" and not "Your files or tokens". So a hosted studio can use the user's OpenAI API key or ours, and not their ChatGPT plan.

Google forbids third-party software from using Gemini CLI's OAuth. A hosted studio would use Gemini API or Vertex keys.

In short, a hosted Frame Studio uses API keys: the user's own, which the Anthropic legal page explicitly allows when usage is "billed to the key owner", or ours, if the hosted service pays and bills users itself through the plain APIs.

## Recommendation for M8

1. Build a provider seam shaped like T3 Code's `ProviderAdapter`, cut down to what the studio needs: `startSession`, `sendTurn`, `interrupt`, `respondToRequest` and one event stream. Normalize to a small union: `turn.started`, `content.delta`, `item.started`, `item.completed` for tool calls, `request.opened`, `request.resolved`, `turn.completed` and `error`, with the native payload kept in `raw`. The studio server pushes these to the viewer over the WebSocket that ADR 0001 already plans, and the viewer answers approvals with a message. This is the streaming progress that ADR 0004 expected.
2. Give every provider the same tools: the operations in `tools/mcp/workspace.ts`, served as an MCP server. Follow T3 and have the studio server host it over HTTP with a per-session bearer token, then pass it through the Agent SDK's `mcpServers`, Codex's `-c mcp_servers.frame-studio.url=...`, or an ACP `session/new`. The existing stdio `tools/mcp/server.ts` also works for spawned CLIs if HTTP is too much at first. The BYOK loop calls the same functions directly. That keeps ADR 0004's rule that the integrated AI's tool loop calls the operations the MCP server offers.
3. Ship three providers first, in this order.
   - Claude through the Agent SDK, pointed at the user's installed `claude` with `pathToClaudeCodeExecutable`. Leave the SDK's optional binary packages out of the Electron build. That keeps roughly 222 MB out of the download and keeps us from redistributing Anthropic's binary. If no `claude` is found, show install and `claude auth login` instructions rather than falling back to a bundled copy. Pass an API key through `env` when the user picks that.
   - ChatGPT through a spawned `codex app-server` on stdio, with the same missing-binary handling. Show sign-in state from `account/read`. Start login with `account/login/start` type `chatgpt`, which opens the browser flow that Codex owns, or type `apiKey`. Never use `chatgptAuthTokens`.
   - A BYOK loop against the Anthropic Messages API and the OpenAI Responses API, with a base-URL field for OpenAI-compatible endpoints. It is the only provider that works in the web app and on a hosted backend, and it is the "other models" answer until an ACP adapter lands for Gemini CLI, Cursor and Grok.
4. Never read, store or forward a Claude or ChatGPT login token. Sign-in stays in the CLIs. Store API keys the user enters in the studio server's secret store, a 0600 file like T3's `ServerSecretStore`, or in the OS keychain once Electron exists. Inject them into the child process environment and never send them to the viewer. In the web app before any backend exists, a key has to live in the tab and go straight to the API with `dangerouslyAllowBrowser`. Say that plainly in the UI.
5. Ask Anthropic before shipping subscription use. Contact sales or partnerships, describe the setup, meaning a local open-source app that spawns the user's own unmodified `claude`, which the user signed in to through Anthropic's flow, via the Agent SDK, and ask whether the SDK note's "unless previously approved" applies. Until there's an answer, don't advertise "use your Claude subscription", and keep the API-key path first-class. Name the provider "Claude" inside an "Agents" menu or "Claude Agent", never "Claude Code". Do not add Gemini CLI's Google login.
6. Keep the tool set narrow instead of relying on approval prompts. For Claude, pass `allowedTools: ["mcp__frame-studio__*"]` with `permissionMode: "dontAsk"`, `disallowedTools` for `Bash`, `Write`, `Edit` and `WebFetch`, and `settingSources: []` so the user's own `CLAUDE.md` and hooks don't leak into studio sessions. For Codex, start threads with `sandbox: "read-only"` and `approvalPolicy: "untrusted"`, and turn every `requestApproval` into a viewer prompt. The studio's own tools only change scene files, and the snapshot taken when a request is claimed (ADR 0003) gives Revert. So offer two modes: "Ask before each change", where every scene write opens a request in the viewer, and "Apply changes, I can revert", the default. Exports and anything that writes outside `scenes/` always ask.
7. Map chat to the request queue: one prompt is one request file (ADR 0003), claimed by the integrated AI instead of an external agent, with the same snapshot, summary and Revert and Try again. The external MCP agent and the integrated AI then share one history.
8. For the hosted backend, use API keys only: the user's own key, or ours through the plain APIs if the hosted service pays and bills users itself. Don't host `codex app-server`, don't run the Agent SDK on a user's subscription, and settle the Claude Code hosting question in the open questions before running the Agent SDK there at all.

## Open questions

- Does Anthropic count a local app that drives the user's own signed-in `claude` through the Agent SDK as "offering claude.ai login"? The legal page and the Help Center suggest no, the SDK note suggests approval is needed. Only Anthropic can answer. Whether T3 Code has Anthropic's approval is unknown.
- What replaces the paused Agent SDK credit? The Help Center promises notice "before anything takes effect". If it returns, subscription use through the studio will draw from a separate, smaller credit.
- Does an agent built on the Agent SDK count as "running Claude Code in your products", with the rule against paying for users' usage? This decides whether a paid hosted studio may use the SDK.
- Would a hosted Claude Code container that keeps a user's login on our disk break the rule against storing Claude.ai credentials?
- OpenAI has no written rule on third-party clients using ChatGPT sign-in through app-server. The evidence is the docs' framing, the Codex for Open Source page and staff posts. The Terms of Use cover ChatGPT, and I couldn't fetch Codex-specific service terms.
- App-server's protocol is still labelled experimental and changes fast. T3 generates its client from Codex's schema for that reason. We should pin a Codex version range and test against it.
- How much of Codex's built-in shell and file tooling can be switched off, so that only our MCP tools remain, the way `disallowedTools` does for Claude?

## Not verified

- The 2026-04-04 change, the 2026-05-13 announcement and Boris Cherny's wording come from TechCrunch, VentureBeat, search snippets and OpenClaw's docs. x.com blocked automated fetches.
- Thibault Sottiaux's post about ChatGPT accounts in third-party harnesses comes from a blog that quotes it.
- OpenAI's Help Center article "Using Codex with your ChatGPT plan" returned 403. OpenAI's Terms of Use and the Sign in with ChatGPT article came from Wayback Machine copies from 2026.
- Whether Cursor, Grok Build and Antigravity accept API keys alone.
- Whether api.openai.com accepts cross-origin requests from a browser tab. The SDK flag exists, but I didn't test a request.
- Codex's `-c mcp_servers.<name>.url` and `bearer_token_env_var` overrides are taken from T3 Code's source, not from OpenAI's config reference.
- I ran none of the providers, so nothing here was checked against a live session: not the SDK's behaviour with `pathToClaudeCodeExecutable`, not app-server's login flow, not T3 Code itself.

## Sources

- Claude Agent SDK overview, including the subscription note, branding guidelines and licence: https://code.claude.com/docs/en/agent-sdk/overview
- Agent SDK quickstart, bundled binary and auth methods: https://code.claude.com/docs/en/agent-sdk/quickstart
- Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions
- Agent SDK hosting: https://code.claude.com/docs/en/agent-sdk/hosting
- Claude Code legal and compliance, authentication and credential use, offering Claude Code in products: https://code.claude.com/docs/en/legal-and-compliance
- Claude Code authentication, precedence, `setup-token`, credential storage: https://code.claude.com/docs/en/authentication
- Claude Help Center, "Use the Claude Agent SDK with your Claude plan", with the 2026-06-15 update: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Anthropic Consumer Terms, effective 2025-10-08: https://www.anthropic.com/legal/consumer-terms. Commercial Terms: https://www.anthropic.com/legal/commercial-terms
- npm: `@anthropic-ai/claude-agent-sdk` 0.3.282, its README, LICENSE.md, `sdk.d.ts` and optional dependencies; `@anthropic-ai/sdk` 0.128.0; `openai` 7.23.0 README: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- Press on the April 2026 change, secondary: https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/, https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch, https://www.threads.com/@boris_cherny/post/DWsAWeND5nm
- OpenClaw's Anthropic provider docs: https://docs.openclaw.ai/providers/anthropic
- Codex App Server: https://learn.chatgpt.com/docs/app-server, formerly https://developers.openai.com/codex/app-server. Implementation: https://github.com/openai/codex/tree/main/codex-rs/app-server
- Codex authentication: https://learn.chatgpt.com/docs/auth
- Codex TypeScript SDK README and `@openai/codex-sdk` 0.156.1 `dist/index.js`: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- Codex for Open Source: https://developers.openai.com/community/codex-for-oss
- OpenAI Terms of Use, effective 2026-01-01, via the Wayback Machine: https://openai.com/policies/row-terms-of-use/
- OpenAI Help Center, Sign in with ChatGPT, via the Wayback Machine: https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt
- Blog quoting OpenAI staff on third-party harnesses, secondary: https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/
- T3 Code at commit `720490a`: https://github.com/pingdotgg/t3code. Files: `README.md`, `docs/internals/providers.md`, `docs/internals/overview.md`, `docs/user/permission-modes.md`, `docs/user/providers-claude.md`, `docs/user/providers-codex.md`, `docs/user/providers-antigravity.md`, `apps/server/package.json`, `apps/server/src/provider/Services/ProviderAdapter.ts`, `apps/server/src/provider/Layers/{ClaudeAdapter,ClaudeProvider,CodexAdapter,CodexSessionRuntime,CodexProvider,codexLaunchArgs,OpenCodeAdapter}.ts`, `apps/server/src/provider/Drivers/ClaudeExecutable.ts`, `apps/server/src/provider/acp/{CursorAcpSupport,GrokAcpSupport,AcpSessionRuntime}.ts`, `apps/server/src/provider/{opencodeRuntime,AntigravityAuth,ProviderAuthFlow,ProviderCredentialStore}.ts`, `apps/server/src/auth/ServerSecretStore.ts`, `apps/server/src/serverSettings.ts`, `apps/server/src/mcp/McpProviderSession.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, `apps/server/src/ws.ts`, `packages/contracts/src/{providerRuntime,orchestration,rpc}.ts`
- Gemini CLI terms and privacy: https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md. ACP mode: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md. Authentication: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx
- OpenCode providers and server docs: https://opencode.ai/docs/providers/, https://opencode.ai/docs/server/
- Agent Client Protocol: https://agentclientprotocol.com/get-started/introduction
