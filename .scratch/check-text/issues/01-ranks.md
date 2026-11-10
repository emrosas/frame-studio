# Ranks on every check result

Type: task
Status: resolved
Blocked by: none

## Work

Add `rank: 'P0' | 'P1' | 'P2' | 'P3'` to every result in a check report. Keep `status` and `ok` as they are.

- P0: the piece is broken. An export fails or drifts, flashing past WCAG 2.3.1, a video that shows nothing.
- P1: an audience stops watching or misses something.
- P2: it costs attention.
- P3: polish.

Each existing rule gets a rank with a one-line reason, in one table in `src/export/check.ts`. A rule may rank by outcome: every frame black is P0, a few black frames P2.

## Acceptance criteria

- [x] `CheckReport.checks` entries all carry `rank`; the word checks and text checks get theirs from the same table.
- [x] The report lists findings by rank, failures before warnings at one rank, then passes.
- [x] CheckPanel shows the rank on each row and sorts the same way.
- [x] The MCP `check` description and `docs/MCP.md` explain ranks and list each rule's rank.
- [x] Unit tests cover the table (an unranked id gets P2, outcome-dependent ranks) and the sort.
- [x] The browser test for the panel still passes, now reading the rank.

## Answer

`rank` is on every result. One table, `RANKS` in `src/export/check.ts`, holds each rule's rank and reason; a rule whose rank depends on more than its status sets it itself (`text-safe`, `caption-safe` and `text-contrast`). Unknown ids get P2. `buildReport` sorts with `compareChecks`: findings by rank, failures before warnings at one rank, then passes. The panel shows the rank beside the name, red for a P0 or P1 finding, and sorts with the same function. `docs/MCP.md` has a rank column, and the MCP description tells agents to fix P0 and P1 first.
