<!--
  A cue with words on the timeline (ADR 0016): its waveform with a chip per word,
  in the same marks as the rows above. A click puts the playhead on a word, and
  a drag across words sets a range, the way a drag on a row does, so a phrase can
  be prompted against. On a scene that isn't locked, a double-click edits a word's
  text and a drag on a chip's edge retimes it, snapping to frames. A right-click
  anchors the selected key or marker to the word. Every edit saves through the
  server's checked edit, on the one undo stack. The grip at its start moves the
  whole voice and its ends trim it (ADR 0018), on a video too.
-->
<script lang="ts">
  import type { SpokenWord } from '../../engine/types';
  import { formatClock, labelFits, snapFrame } from '../timeline';
  import { renameWord, retimeWord, wordChips, type VoiceLine, type WordChip } from '../voice';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';

  let {
    voice,
    ui,
    actions,
    fps,
    total,
    px,
    ready,
    editable,
    boundaryAt,
    startSpan,
    follow,
    onmenu,
    cueEditable,
    pressCue,
    oncuemenu,
  }: {
    voice: VoiceLine;
    ui: ViewerUi;
    actions: ViewerActions;
    fps: number;
    total: number;
    px: (from: number, to: number) => number;
    ready: boolean;
    editable: boolean;
    boundaryAt: (x: number) => number;
    startSpan: (e: PointerEvent, layerId: string | null, own: readonly number[], click: () => void) => void;
    follow: (e: PointerEvent, move: (e: PointerEvent) => void, end: (e: PointerEvent | null) => void, on?: HTMLElement | null) => void;
    onmenu: (e: MouseEvent, chip: WordChip) => void;
    cueEditable: boolean;
    pressCue: (e: PointerEvent) => void;
    oncuemenu: (e: MouseEvent) => void;
  } = $props();

  const BUCKETS = 240;
  let path = $state('');
  let row = $state<HTMLElement | null>(null);
  /** The words during a drag, and after it until the file says the same. */
  let held = $state<readonly SpokenWord[] | null>(null);
  let dragging = false;
  /** The word whose text is being typed over. */
  let editing = $state<number | null>(null);

  const cue = $derived(held ? { ...voice.cue, words: held } : voice.cue);
  const chips = $derived(wordChips(cue, fps));
  const percent = (frame: number) => (total > 0 ? (frame / total) * 100 : 0);
  const playing = $derived.by(() => {
    const frame = ui.timeline?.frame ?? -1;
    return chips.find((c) => c.frame <= frame && frame < Math.max(c.frame + 1, Math.ceil(c.to)))?.id ?? null;
  });

  $effect(() => {
    const { path: file, from, to } = voice.file;
    if (!ready) return;
    let live = true;
    void actions.waveform(file, from, to, BUCKETS).then((peaks) => {
      if (!live || !peaks) return;
      const top = Array.from(peaks, (p, i) => `${i} ${0.5 - p / 2}`);
      const bottom = Array.from(peaks, (p, i) => `${i} ${0.5 + p / 2}`).reverse();
      path = `M${top.join('L')}L${bottom.join('L')}Z`;
    });
    return () => {
      live = false;
    };
  });

  // What the save wrote has arrived, so the file can show again.
  $effect(() => {
    if (held && !dragging && JSON.stringify(held) === JSON.stringify(voice.cue.words)) held = null;
  });

  /** A word's text runs on past its chip, in a tier it shares with every other word, so it has until the next word in that tier. */
  const roomFor = (i: number) => labelFits(chips[i].text, px(chips[i].from, chips[i + 2]?.from ?? voice.to) + 8);

  const edges = () => chips.flatMap((c) => [Math.round(c.from), Math.round(c.to)]);

  function pressChip(e: PointerEvent, chip: WordChip): void {
    if (e.button !== 0 || !ui.timeline) return;
    e.stopPropagation();
    const edge = (e.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined;
    if (edge && editable) startEdge(e, chip, edge);
    else startWords(e, chip);
  }

  /** A press on a word: a click for the playhead, or a drag that ranges over whole words. */
  function startWords(e: PointerEvent, first: WordChip): void {
    const startX = e.clientX;
    let moved = false;
    follow(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 3) return;
        moved = true;
        const at = boundaryAt(ev.clientX);
        const last = chips.reduce((best, c) => (Math.abs((c.from + c.to) / 2 - at) < Math.abs((best.from + best.to) / 2 - at) ? c : best), first);
        const [a, b] = last.from < first.from ? [last, first] : [first, last];
        actions.selectRange(null, { from: a.frame, to: Math.min(total, Math.max(a.frame + 1, Math.ceil(b.to - 1e-6))) });
      },
      (ev) => {
        if (ev && !moved) actions.scrub(first.frame);
      },
    );
  }

  function startEdge(e: PointerEvent, chip: WordChip, edge: 'start' | 'end'): void {
    e.preventDefault();
    const base = voice.cue;
    const startX = e.clientX;
    const perFrame = (row?.getBoundingClientRect().width ?? 0) / Math.max(1, voice.to - voice.from);
    // The word's own other edge and neighbours' far edges are limits, not targets, so only markers catch it.
    const targets = [...ui.markers.map((m) => m.frame), ...(ui.timeline ? [ui.timeline.frame] : [])];
    let moved = false;
    dragging = true;
    follow(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 3) return;
        moved = true;
        held = retimeWord(base, chip.index, edge, snapFrame(boundaryAt(ev.clientX), targets, perFrame), fps);
      },
      (ev) => {
        dragging = false;
        if (!moved || !ev || !held) {
          held = null;
          return;
        }
        save(held);
      },
      row,
    );
  }

  function save(words: readonly SpokenWord[]): void {
    held = words;
    void actions.saveWords(voice.cue.id, words).then((saved) => {
      if (!saved) held = null;
      else setTimeout(() => (held = held === words ? null : held), 2000);
    });
  }

  function commit(input: HTMLInputElement, index: number): void {
    if (editing !== index) return;
    editing = null;
    const words = renameWord(voice.cue.words, index, input.value);
    if (words[index].text !== voice.cue.words[index].text) save(words);
  }

  function keyInField(e: KeyboardEvent, index: number): void {
    e.stopPropagation();
    if (e.key === 'Enter') commit(e.currentTarget as HTMLInputElement, index);
    else if (e.key === 'Escape') editing = null;
  }

  const focusAndSelect = (input: HTMLInputElement) => {
    input.focus();
    input.select();
  };

  function chipTitle(chip: WordChip): string {
    const when = `"${chip.text}" at ${formatClock(chip.frame, fps)}.`;
    if (editable) return `${when} Click for the playhead, drag across words for a range, drag an edge to retime, double-click to fix the text, right-click to anchor.`;
    return ui.keyEdit === 'locked' ? `${when} An agent is working here, so words stay put.` : `${when} Click for the playhead, drag across words for a range.`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="voice-row"
  class:is-selected={ui.cue === voice.cue.id}
  bind:this={row}
  data-voice={voice.cue.id}
  role="group"
  aria-label="Voice {voice.label}"
  style="--in: {total > 0 ? voice.from / total : 0}; --out: {total > 0 ? voice.to / total : 1}"
  onpointerdown={(e) => {
    const target = e.target as HTMLElement;
    if (target.dataset.edge !== undefined || target.dataset.fade !== undefined || target.classList.contains('voice-grip')) return pressCue(e);
    if (e.target === e.currentTarget || (e.target as Element).closest('svg')) startSpan(e, null, edges(), () => actions.selectCue(voice.cue.id, { from: voice.from, to: voice.to }));
  }}
  oncontextmenu={(e) => {
    if (!(e.target as Element).closest('.word-chip')) oncuemenu(e);
  }}
>
  {#if path}
    <svg class="waveform" viewBox="0 0 {BUCKETS} 1" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
  {/if}
  {#each chips as chip, i (chip.id)}
    <span
      class="word-chip"
      class:is-current={playing === chip.id}
      class:is-low={i % 2 === 1}
      data-word={chip.id}
      role="button"
      tabindex="-1"
      aria-label={chipTitle(chip)}
      title={chipTitle(chip)}
      style="left: {percent(chip.from - voice.from) * (total / Math.max(1, voice.to - voice.from))}%; width: {percent(chip.to - chip.from) * (total / Math.max(1, voice.to - voice.from))}%"
      onpointerdown={(e) => pressChip(e, chip)}
      oncontextmenu={(e) => onmenu(e, chip)}
      ondblclick={() => {
        if (editable) editing = chip.index;
      }}
    >
      {#if roomFor(i)}<span class="word-text">{chip.text}</span>{/if}
      {#if editable}<span class="word-edge is-start" data-edge="start"></span><span class="word-edge is-end" data-edge="end"></span>{/if}
    </span>
  {/each}
  {#if cueEditable && voice.place}
    {@const seconds = (voice.place.to - voice.place.from) / fps}
    {#if voice.place.fadeIn > 0}<span class="sound-fade is-in" style="width: {(voice.place.fadeIn / seconds) * 100}%"></span>{/if}
    {#if voice.place.fadeOut > 0}<span class="sound-fade is-out" style="width: {(voice.place.fadeOut / seconds) * 100}%"></span>{/if}
    <span class="voice-grip" title="Drag to move this voice"></span>
    <span class="clip-edge is-start" data-edge="start"></span>
    <span class="clip-edge is-end" data-edge="end"></span>
    <span class="fade-mark is-in" data-fade="in" title="Fade in" style="left: {(voice.place.fadeIn / seconds) * 100}%"></span>
    <span class="fade-mark is-out" data-fade="out" title="Fade out" style="right: {(voice.place.fadeOut / seconds) * 100}%"></span>
  {/if}
  {#if editing !== null}
    {@const chip = chips.find((c) => c.index === editing)}
    {#if chip}
      {#key editing}
        <input
          class="word-field"
          aria-label="Word text"
          value={chip.text}
          style="left: {percent(chip.from - voice.from) * (total / Math.max(1, voice.to - voice.from))}%"
          use:focusAndSelect
          onkeydown={(e) => keyInField(e, chip.index)}
          onblur={(e) => commit(e.currentTarget, chip.index)}
        />
      {/key}
    {/if}
  {/if}
</div>
