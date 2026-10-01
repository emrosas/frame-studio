# 0011: Agents ask the user with question cards

Status: accepted, 2026-10-01. Extends ADR 0006.

## Context

An agent working a thread often meets a choice it shouldn't guess: which typeface, which of two layouts, how literal to read a request. Until now it had two poor options: guess and let the user correct it a turn later, or end the turn with a question in prose, which the user answers by typing. T3 Code shows an agent's questions as a card of options the user clicks, and both providers already have a tool for it: Claude's `AskUserQuestion`, and Codex's `request_user_input`, which is experimental and normally limited to plan mode. The studio denied the first and answered the second with nothing.

## Decision

- **One card for both.** A question is `{ id, header, question, options: [{ label, description?, preview? }], multiSelect? }`, the shape the two tools share, in `src/studio/protocol.ts`. A card holds 1 to 4. An agent asks with its own tool: the Claude adapter takes `AskUserQuestion` in `canUseTool`, the Codex adapter takes `item/tool/requestUserInput`, and both call the turn's `ask`.
- **The turn waits, like an approval.** The runner appends a `questions` event and waits for the user; their answers, or null, come back as a `questions-answered` event and go to the agent. Claude gets them as the tool's `answers` input, keyed by question text with several picks joined by commas, which is how the tool reports them to the model. Codex gets `{ answers: { id: { answers } } }`. Stop, the turn ending and the server closing resolve an open card with null, as they decline open approvals.
- **The user can always type.** Every question takes a typed answer instead of, or for a multi-select question in addition to, the options. A question with no options takes only a typed answer. Skip answers null, and the agent decides and says what it chose.
- **The card sits above the thread's actions** while the turn waits, one question at a time: its header, the options numbered with the recommended first, a line to type in, Back and Next or Send. A single-choice pick moves straight on, and on the last question it sends. Keys 1 to 9 pick and Enter moves on. A preview shows for the option with focus, not under the pointer, since a preview appearing under the pointer would move the option away from it. The transcript keeps each card with its answers.
- **The thread reads as Input** while its turn waits on a card or an approval, as in T3 Code. The runner stamps `waitingSince` on the working turn in the request file when the first card opens and clears it when the last closes, and the turn ending clears it too, so it survives a reload and reaches every viewer. `displayStatus` then says `input`: a blue dot and "Input" in the sidebar, counted with the threads waiting for you, and "waiting for you" on the turn.
- **`POST /__studio/requests/<id>/questions/<card>`** takes `{ answers }` or `{ answers: null }`. The server checks the answers fit the card (`checkAnswers`): every question once, one answer unless multi-select, short non-empty text.
- **Codex's tool is switched on** with `-c features.default_mode_request_user_input=true`. It is experimental in Codex; if a Codex release drops the flag, Codex goes back to asking in prose.
- **The standing instructions** tell agents to ask when a request leaves a choice that changes the result, with 2 to 4 options and the recommended one first, and not to ask what they can sensibly decide.

## Consequences

- Questions work only for agents the studio runs. An external agent over MCP asks in its own interface, such as Claude Code's terminal.
- A card waits as long as the user takes. Claude's tool calls have no studio timeout; Codex waits on its own request. A turn left waiting shows Working in the sidebar.
- When a card or an approval opens in a thread that isn't showing, a toast says the agent needs you, with Answer, which opens the thread, and the sidebar shows the thread as Input until it's answered.
