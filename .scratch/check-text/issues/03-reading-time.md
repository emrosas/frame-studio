# Time to read text on screen

Type: task
Status: resolved
Blocked by: 02

## Work

`reading-time`: for each appearance of a text layer (a run of frames showing the same text), how long it's readable against how long it needs. Readable means every character is drawn (a typing reveal has finished) and its opacity is at least 0.5. It needs 0.3 s a word, at least 1 s.

0.3 s a word is 200 words a minute, a little under adult silent reading of non-fiction (about 240, Brysbaert 2019), because on screen the words compete with the picture. The 1 s floor covers one-word titles, which still take a fixation and a moment to find.

Captions keep `caption-speed`, which already measures each page in characters a second by language. This rule leaves them out so a page isn't reported twice.

## Acceptance criteria

- [x] Each short appearance is reported with its text, the time it's readable, the time it needs, and its frames. P1.
- [x] A typing reveal only counts once it completes; a fade counts from half opacity.
- [x] Text whose `text` param changes counts each value as its own appearance.
- [x] Only appearances touching `[from, to)` are judged.
- [x] Unit tests cover pass, fail, reveal, fade and a change of text.

## Answer

Built as specified. Word count splits on whitespace, so `$` and `--` count as words in a shell line, and CJK text counts as one word a run. Over the repo it finds two real cases in `type-test`, a four-second specimen sheet: the 24-word paragraph needs 7.2 s, and the typing line finishes with 1 s left of the 1.8 s it needs. `tests/text-check.test.ts` pins them.
