<!--
  The timeline: headers on the left, a ruler with seconds, markers and the frame
  range pinned on top, and rows that scroll under it. A scene has a row per
  layer, top of the stack first and the background last: a bar for when it is on
  screen, its keys as diamonds, its overrides as tinted spans. A composition has
  rows of clips, one per overlap, and sound takes the rows under either.

  Press the ruler to scrub. The in and out handles drag on the ruler, and
  dragging both back to the ends clears the range. A click on a row or a band
  selects, and X marks its span as the range. A drag on an empty part of a row
  sets that layer and a range, snapping to markers, clip edges and key times.
  With a row focused, Up and Down move between rows, and every other key stays
  the viewer's: a row is not a button, so Space still plays.

  On a scene the keys edit by hand (ADR 0015). The selected row opens one lane
  per animated param. A diamond drags to move its keys in time, on the row every
  param's at that time, on a lane that param's. A click selects it for Delete
  and the arrows, and a right-click offers Delete key. A bar drags to shift the
  layer's keys and overrides, and a bar's end moves that fade's two keys. A row
  with no opacity track shows a quiet bar and still drags out a range. Edits show
  at once and save through the server's checked edit, and they stay locked while
  an agent works there.

  On a composition a clip drags to move and its edges drag to trim, snapping to
  frames. It saves through the server's checked edit, Command-Z takes it back,
  and it stays locked while an agent works there. Sound stays read-only. The
  range input underneath keeps the frame on the keyboard and in the
  accessibility tree.
-->
<script lang="ts">
  import type { KeyMark, KeyTarget, SelectedKey } from '../keyframes';
  import { dragClip, dragSpan, formatClock, labelFits, markerLabels, rulerTicks, snapDelta, snapFrame, type ClipHandle, type ClipPlace, type VisibleSpan } from '../timeline';
  import { spanLabel, type FrameRange } from '../selection';
  import type { LayerRow, ShotBand, SoundBand as SoundBandData, ViewerActions, ViewerUi } from '../ui.svelte';
  import Popover from './Popover.svelte';
  import SoundBand from './SoundBand.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  let ruler = $state<HTMLElement | null>(null);
  let scroller = $state<HTMLElement | null>(null);
  let width = $state(0);

  const total = $derived(ui.timeline?.frameCount ?? 0);
  const fps = $derived(ui.selection.fps);
  const ticks = $derived(rulerTicks(ui.timeline?.seconds ?? 0, width));
  const percent = (frame: number) => (total > 0 ? (frame / total) * 100 : 0);
  const spanStyle = (from: number, to: number, lane: number) => `--in: ${total > 0 ? from / total : 0}; --out: ${total > 0 ? to / total : 1}; --lane: ${lane}`;
  const spanPx = (from: number, to: number) => (total > 0 ? ((to - from) / total) * width : 0);
  const labelled = $derived(markerLabels(ui.markers, total, spanPx));
  const range = $derived(ui.band?.range ?? null);
  const showRows = $derived(ui.shots === null && ui.layers.length > 0);
  const laneName = $derived(ui.header?.video ? 'Clips' : 'Shots');
  const named = (name: string, lane: number) => (lane === 0 ? name : `${name} ${lane + 1}`);

  const fraction = (x: number) => {
    const box = ruler?.getBoundingClientRect();
    return box && box.width > 0 ? Math.min(1, Math.max(0, (x - box.left) / box.width)) : 0;
  };
  const frameAt = (x: number) => Math.min(total - 1, Math.floor(fraction(x) * total));
  const boundaryAt = (x: number) => Math.round(fraction(x) * total);

  // The selected row comes into view, wherever it was selected from. Only the row list scrolls.
  $effect(() => {
    const id = ui.layerId;
    if (id === null || !scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-layer="${CSS.escape(id)}"]`);
    if (!row) return;
    const inner = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    // Its lanes come along, as far as there's room.
    const lanes = row.nextElementSibling?.classList.contains('tl-lanes') ? row.nextElementSibling.getBoundingClientRect().bottom : box.bottom;
    if (box.top < inner.top) scroller.scrollTop -= inner.top - box.top;
    else if (lanes > inner.bottom) scroller.scrollTop += Math.min(lanes - inner.bottom, box.top - inner.top);
    // Up and Down carry on from here, unless the prompt or a field has the keys.
    const focused = document.activeElement;
    if (row.classList.contains('tl-row') && (focused === document.body || focused?.classList.contains('tl-row'))) row.focus({ preventScroll: true });
  });

  /** Follows one pointer until it lifts, from its element, or from `on` when a redraw might take its element away. */
  function follow(e: PointerEvent, move: (e: PointerEvent) => void, end: (e: PointerEvent | null) => void, on?: HTMLElement | null): void {
    const el = on ?? (e.currentTarget as HTMLElement);
    el.setPointerCapture(e.pointerId);
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      end(ev);
    };
    const cancel = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      end(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  }

  function startScrub(e: PointerEvent): void {
    if (e.button !== 0 || !ui.timeline) return;
    e.preventDefault();
    actions.scrubStart();
    actions.scrub(frameAt(e.clientX));
    follow(
      e,
      (ev) => actions.scrub(frameAt(ev.clientX)),
      () => actions.scrubEnd(),
    );
  }

  /** Drags one end of the range. A range that reaches both ends again is no range. */
  function startHandle(e: PointerEvent, end: 'from' | 'to'): void {
    if (e.button !== 0 || !ui.timeline) return;
    e.preventDefault();
    e.stopPropagation();
    const fixed = ui.band?.range ?? { from: 0, to: total };
    follow(
      e,
      (ev) => {
        const at = boundaryAt(ev.clientX);
        const next = end === 'from' ? { from: Math.min(at, fixed.to - 1), to: fixed.to } : { from: fixed.from, to: Math.max(at, fixed.from + 1) };
        actions.dragRange(next.from === 0 && next.to === total ? null : next);
      },
      () => {},
    );
  }

  // ---- rows ----

  /** What a dragged range edge lands on: markers, clip and sound edges, and these frames of the row itself. */
  function snapTargets(own: readonly number[]): number[] {
    const edges = (bands: readonly { from: number; to: number }[] | undefined) => (bands ?? []).flatMap((b) => [b.from, b.to]);
    return [...ui.markers.map((m) => m.frame), ...edges(ui.shots?.bands), ...edges(ui.sounds?.bands), ...own];
  }

  /**
   * A press on an empty part of a row. A drag sets `layerId`, when the row has one, with a range from where
   * it started, and without a drag `click` runs.
   */
  function startSpan(e: PointerEvent, layerId: string | null, own: readonly number[], click: () => void): void {
    if (e.button !== 0 || !ui.timeline) return;
    const targets = snapTargets(own);
    const perFrame = ruler ? ruler.getBoundingClientRect().width / total : 0;
    const snapped = (x: number) => snapFrame(boundaryAt(x), targets, perFrame);
    const anchor = snapped(e.clientX);
    const startX = e.clientX;
    let moved = false;
    follow(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 3) return;
        moved = true;
        actions.selectRange(layerId, dragSpan(anchor, snapped(ev.clientX), total));
      },
      (ev) => {
        if (ev && !moved) click();
      },
    );
  }

  function pressRow(e: PointerEvent, row: LayerRow): void {
    const target = e.target as HTMLElement;
    const bar = target.closest<HTMLElement>('[data-bar]');
    if (bar && e.button === 0 && ui.keyEdit === 'on') {
      startBar(e, row, row.bars[Number(bar.dataset.bar)], target.dataset.edge as 'start' | 'end' | undefined);
      return;
    }
    const inLane = target.closest('.row-lane') !== null;
    const override = target.closest<HTMLElement>('[data-from]');
    const span: FrameRange | undefined = override ? { from: Number(override.dataset.from), to: Number(override.dataset.to) } : undefined;
    const select = () => actions.selectLayer(row.id, span);
    if (!inLane) {
      if (e.button === 0) select();
      return;
    }
    startSpan(e, row.id, [...row.keys, ...row.overrides.flatMap((o) => [o.from, o.to])], select);
  }

  // ---- keys ----

  /** The diamond a right-click is on. */
  let keyMenu = $state<{ x: number; y: number; key: SelectedKey } | null>(null);

  const perFramePx = () => (ruler ? ruler.getBoundingClientRect().width / total : 0);
  const canEditKeys = $derived(ui.keyEdit === 'on');

  /** Runs a drag of keys from past the 3 px threshold. A press that never gets there is `click`. */
  function dragKeys(e: PointerEvent, target: KeyTarget, to: (x: number) => number, click: () => void): void {
    const startX = e.clientX;
    let state: 'waiting' | 'dragging' | 'refused' = 'waiting';
    follow(
      e,
      (ev) => {
        if (state === 'waiting' && Math.abs(ev.clientX - startX) >= 3) state = actions.startKeyDrag(target) ? 'dragging' : 'refused';
        if (state === 'dragging') actions.dragKeys(to(ev.clientX));
      },
      (ev) => {
        if (state === 'dragging') actions.endKeyDrag(ev !== null);
        else if (state === 'waiting' && ev) click();
      },
      // A diamond can merge into its neighbour on the way, and take its element with it.
      scroller,
    );
  }

  function pressKey(e: PointerEvent, layerId: string, param: string | null, mark: KeyMark): void {
    e.stopPropagation();
    if (e.button !== 0 || !ui.timeline) return;
    const key = { layerId, param, frame: mark.frame };
    const offset = mark.at - boundaryAt(e.clientX);
    const targets = snapTargets(ui.layers.flatMap((r) => r.keys).filter((f) => f !== mark.frame));
    const perFrame = perFramePx();
    dragKeys(e, { kind: 'key', ...key }, (x) => snapFrame(boundaryAt(x) + offset, targets, perFrame), () => actions.selectKey(key));
  }

  function startBar(e: PointerEvent, row: LayerRow, bar: VisibleSpan, edge: 'start' | 'end' | undefined): void {
    const pair = edge === 'start' ? bar.start : edge === 'end' ? bar.end : undefined;
    const target: KeyTarget = pair ? { kind: 'edge', layerId: row.id, pair } : { kind: 'bar', layerId: row.id };
    const edges = edge === 'start' ? [bar.from] : edge === 'end' ? [bar.to] : [bar.from, bar.to];
    const targets = snapTargets(ui.layers.flatMap((r) => (r.id === row.id ? [] : r.keys)));
    const perFrame = perFramePx();
    const from = boundaryAt(e.clientX);
    dragKeys(e, target, (x) => snapDelta(edges, boundaryAt(x) - from, targets, perFrame), () => actions.selectLayer(row.id));
  }

  function openKeyMenu(e: MouseEvent, layerId: string, param: string | null, mark: KeyMark): void {
    if (!canEditKeys) return;
    const key = { layerId, param, frame: mark.frame };
    actions.selectKey(key);
    keyMenu = { x: Math.min(e.clientX + 8, window.innerWidth - 148), y: Math.min(e.clientY, window.innerHeight - 44), key };
  }

  function keyTitle(mark: KeyMark): string {
    const when = `${mark.params.join(', ')} at ${formatClock(mark.at, fps)}.`;
    return canEditKeys ? `${when} Drag to move, click then Delete to remove.` : ui.keyEdit === 'locked' ? `${when} An agent is working here, so keys stay put.` : when;
  }

  function barTitle(bar: VisibleSpan): string {
    const when = `On screen ${spanLabel(bar, fps)}.`;
    return canEditKeys ? `${when} Drag to shift the layer's keys and overrides, drag an end to move that fade.` : when;
  }

  const isSelectedKey = (layerId: string, param: string | null, mark: KeyMark) => ui.selectedKey?.layerId === layerId && ui.selectedKey.param === param && ui.selectedKey.frame === mark.frame;

  /** Up and Down move through the rows. Everything else is the viewer's. */
  function rowKeys(e: KeyboardEvent): void {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const rows = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="option"]')];
    const at = rows.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const next = ui.layerId === null ? rows[at] : rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    next.focus({ preventScroll: true });
    actions.selectLayer(next.dataset.layer!);
  }

  // ---- clips ----

  /** The clip being dragged, or saving: where it shows until the new file arrives. */
  let held = $state<{ layerId: string; place: ClipPlace; saving: boolean } | null>(null);
  /** The band clicked last, so a double-click opens it even if the first click moved the bands under the pointer. */
  let lastBand: { layerId: string; at: number } | null = null;
  let dragged = false;

  const editable = $derived(ui.shots !== null && !ui.shots.locked);

  function shown(band: ShotBand): { from: number; to: number } {
    if (held?.layerId !== band.layerId) return band;
    const { from, in: start, out } = held.place;
    return { from, to: Math.min(total, from + out - start) };
  }

  // A saved clip shows from the new file, so drop the held place as soon as the band agrees with it.
  $effect(() => {
    if (!held?.saving) return;
    const { layerId, place } = held;
    const band = ui.shots?.bands.find((b) => b.layerId === layerId);
    if (band?.clip && band.clip.from === place.from && band.clip.in === place.in && band.clip.out === place.out) held = null;
  });

  function startClip(e: PointerEvent, band: ShotBand): void {
    dragged = false;
    const clip = band.clip;
    if (e.button !== 0 || !clip || !editable || held) return;
    const edge = (e.target as HTMLElement).dataset.edge as ClipHandle | undefined;
    const handle: ClipHandle = edge ?? 'move';
    const startX = e.clientX;
    const perFrame = ruler ? ruler.getBoundingClientRect().width / total : 1;
    follow(
      e,
      (ev) => {
        if (Math.abs(ev.clientX - startX) < 3 && !dragged) return;
        dragged = true;
        held = { layerId: band.layerId, place: dragClip(clip, handle, Math.round((ev.clientX - startX) / perFrame), total), saving: false };
      },
      (ev) => {
        if (!held) return;
        const { place, layerId } = held;
        const moved = place.from !== clip.from || place.in !== clip.in || place.out !== clip.out;
        if (!ev || !moved) {
          held = null;
          return;
        }
        held = { layerId, place, saving: true };
        void actions.moveClip(layerId, place).then((saved) => {
          if (saved && ui.layerId !== layerId) actions.selectLayer(layerId);
          if (!saved) held = null;
          else setTimeout(() => (held = held?.saving && held.layerId === layerId ? null : held), 2000);
        });
      },
    );
  }

  function clickBand(e: MouseEvent & { currentTarget: HTMLButtonElement }, band: ShotBand): void {
    // A drag ends in a click; only a click selects.
    if (dragged) {
      dragged = false;
      return;
    }
    lastBand = { layerId: band.layerId, at: performance.now() };
    actions.selectLayer(band.layerId, { from: band.from, to: band.to });
    e.currentTarget.blur();
  }

  function openBand(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-layer]');
    const recent = lastBand && performance.now() - lastBand.at < 800 ? lastBand.layerId : null;
    const layerId = recent ?? target?.dataset.layer ?? null;
    lastBand = null;
    if (layerId) actions.openShot(layerId);
  }

  function bandTitle(band: ShotBand): string {
    const base = `${band.label}, ${spanLabel(band, fps)}. Click to select, X to mark it, double-click to open.`;
    if (!band.clip) return base;
    return ui.shots?.locked ? `${base} An agent is working here, so clips stay put.` : `${base} Drag to move, drag an edge to trim.`;
  }

  function pressSounds(e: PointerEvent, bands: readonly SoundBandData[]): void {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-cue]')?.dataset.cue;
    const band = bands.find((b) => b.id === id);
    if (band) {
      if (e.button === 0) actions.selectCue(band.id, { from: band.from, to: band.to });
      return;
    }
    startSpan(e, null, [], () => {});
  }
</script>

{#snippet diamond(layerId: string, param: string | null, mark: KeyMark)}
  <button
    type="button"
    class="key-mark"
    class:is-selected={isSelectedKey(layerId, param, mark)}
    class:is-fixed={!canEditKeys}
    tabindex="-1"
    aria-label={keyTitle(mark)}
    title={keyTitle(mark)}
    style="left: {percent(mark.at)}%"
    onmousedown={(e) => e.preventDefault()}
    onpointerdown={(e) => pressKey(e, layerId, param, mark)}
    oncontextmenu={(e) => openKeyMenu(e, layerId, param, mark)}
  ></button>
{/snippet}

{#snippet heads(name: string, lanes: number)}
  <div class="tl-heads" aria-hidden="true">
    {#each { length: lanes } as _, lane (lane)}
      <span class="row-head">{named(name, lane)}</span>
    {/each}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tl" class:is-empty={!ui.timeline} oncontextmenu={(e) => e.preventDefault()}>
  <div class="tl-top">
    <div class="tl-corner"></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ruler" bind:this={ruler} bind:clientWidth={width} onpointerdown={startScrub}>
      {#if ui.markers.length > 0}
        <div class="ruler-markers">
          {#each ui.markers as marker, i (`${marker.frame}-${marker.label}`)}
            <span class="marker" class:is-sync={marker.label.endsWith('!')} class:is-crowded={!labelled[i]} style="left: {percent(marker.frame)}%">
              <button
                type="button"
                tabindex="-1"
                title={marker.label}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => {
                  actions.scrub(marker.frame);
                  e.currentTarget.blur();
                }}><span class="marker-label">{marker.label}</span></button
              >
            </span>
          {/each}
        </div>
      {/if}
      <div class="ruler-ticks" aria-hidden="true">
        {#each ticks as tick (tick.t)}
          <span class="tick" class:is-major={tick.label !== null} style="left: {ui.timeline ? (tick.t / ui.timeline.seconds) * 100 : 0}%">
            {#if tick.label !== null}<span class="tick-label">{tick.label}</span>{/if}
          </span>
        {/each}
      </div>
      {#if ui.timeline}
        {@const from = range?.from ?? 0}
        {@const to = range?.to ?? total}
        <span class="ruler-range" hidden={!range} style="left: {percent(from)}%; right: {100 - percent(to)}%"></span>
        <button type="button" class="range-handle is-in" class:is-set={range !== null} style="left: {percent(from)}%" tabindex="-1" aria-label="Range start" title="Drag to set where the range starts" onpointerdown={(e) => startHandle(e, 'from')}></button>
        <button type="button" class="range-handle is-out" class:is-set={range !== null} style="left: {percent(to)}%" tabindex="-1" aria-label="Range end" title="Drag to set where the range ends" onpointerdown={(e) => startHandle(e, 'to')}></button>
      {/if}
      <input
        class="scrubber"
        type="range"
        min="0"
        max={Math.max(0, total - 1)}
        step="1"
        value={ui.timeline?.frame ?? 0}
        disabled={!ui.timeline}
        aria-label="Frame"
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
        oninput={(e) => actions.scrub(Number(e.currentTarget.value))}
      />
    </div>
  </div>

  <div class="tl-scroll" bind:this={scroller}>
    {#if ui.shots}
      <div class="tl-section">
        {@render heads(laneName, ui.shots.lanes)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="shots"
          role="group"
          aria-label="Shots"
          style="--lanes: {ui.shots.lanes}"
          ondblclick={openBand}
          onpointerdown={(e) => {
            if (e.target === e.currentTarget) startSpan(e, null, [], () => {});
          }}
        >
          {#each ui.shots.bands as band (band.layerId)}
            {@const place = shown(band)}
            <button
              type="button"
              class="shot-band"
              class:is-selected={ui.layerId === band.layerId}
              class:is-hover={ui.hoverLayer === band.layerId}
              class:is-editable={band.clip !== undefined && editable}
              class:is-held={held?.layerId === band.layerId}
              data-layer={band.layerId}
              aria-pressed={ui.layerId === band.layerId}
              aria-label={band.layerId === band.label ? band.label : `${band.layerId} (scene ${band.label})`}
              style={spanStyle(place.from, place.to, band.lane)}
              title={bandTitle(band)}
              onpointerenter={() => actions.hoverLayer(band.layerId)}
              onpointerleave={() => actions.hoverLayer(null)}
              onpointerdown={(e) => startClip(e, band)}
              onclick={(e) => clickBand(e, band)}
            >
              {#if band.clip && editable}<span class="clip-edge is-start" data-edge="start"></span><span class="clip-edge is-end" data-edge="end"></span>{/if}
              {#if labelFits(band.layerId, spanPx(place.from, place.to))}<span class="band-label">{band.layerId}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
    {:else if showRows}
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div class="tl-rows" role="listbox" aria-label="Layers" onkeydown={rowKeys}>
        {#each ui.layers as row, i (row.id)}
          {@const selected = ui.layerId === row.id}
          <div
            class="tl-row"
            class:is-selected={selected}
            class:is-hover={ui.hoverLayer === row.id}
            role="option"
            aria-selected={selected}
            tabindex={selected || (ui.layerId === null && i === 0) ? 0 : -1}
            data-layer={row.id}
            onpointerenter={() => actions.hoverLayer(row.id)}
            onpointerleave={() => actions.hoverLayer(null)}
            onpointerdown={(e) => pressRow(e, row)}
          >
            <span class="row-head" title={row.id}>{row.id}</span>
            <span class="row-lane">
              {#if !row.faded}
                <span class="row-bar is-quiet" style="left: 0; right: 0"></span>
              {/if}
              {#each row.bars as bar, b (b)}
                <span class="row-bar" class:is-editable={canEditKeys} data-bar={b} title={barTitle(bar)} style="left: {percent(bar.from)}%; right: {100 - percent(bar.to)}%">
                  {#if canEditKeys && bar.start}<span class="bar-edge is-start" data-edge="start"></span>{/if}
                  {#if canEditKeys && bar.end}<span class="bar-edge is-end" data-edge="end"></span>{/if}
                </span>
              {/each}
              {#each row.overrides as o (o.from)}
                <span class="row-override" data-from={o.from} data-to={o.to} title="An override, {spanLabel(o, fps)}. Click, then X to mark it." style="left: {percent(o.from)}%; right: {100 - percent(o.to)}%"></span>
              {/each}
              {#each row.marks as mark, m (m)}
                {@render diamond(row.id, null, mark)}
              {/each}
              {#if selected && range}
                <span class="row-range" style="left: {percent(range.from)}%; right: {100 - percent(range.to)}%"></span>
              {/if}
            </span>
          </div>
          {#if selected && ui.keyEdit !== 'off' && row.lanes.length > 0}
            <div class="tl-lanes" role="group" aria-label="Keys of {row.id}">
              {#each row.lanes as lane (lane.param)}
                <div class="key-lane" data-lane={lane.param}>
                  <span class="lane-head" title={lane.param}>{lane.param}</span>
                  <span class="lane-keys">
                    {#each lane.keys as mark, m (m)}
                      {@render diamond(row.id, lane.param, mark)}
                    {/each}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    {#if ui.sounds}
      {@const sounds = ui.sounds}
      <div class="tl-section">
        {@render heads('Sound', sounds.lanes)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="sounds" role="group" aria-label="Sounds" style="--lanes: {sounds.lanes}" onpointerdown={(e) => pressSounds(e, sounds.bands)}>
          {#each sounds.bands as band (band.id)}
            <SoundBand {band} {actions} {fps} px={spanPx(band.from, band.to)} selected={ui.cue === band.id} ready={ui.sound?.status === 'ready' || ui.sound?.status === 'locked'} style={spanStyle(band.from, band.to, band.lane)} />
          {/each}
        </div>
      </div>
    {/if}
  </div>

  {#if keyMenu}
    <Popover label="Key" role="menu" class="stack-menu" style="left: {keyMenu.x}px; top: {keyMenu.y}px; width: 140px" onclose={() => (keyMenu = null)}>
      <div class="menu-list">
        <button
          type="button"
          role="menuitem"
          class="menu-item"
          onclick={() => {
            if (keyMenu) actions.deleteKey(keyMenu.key);
            keyMenu = null;
          }}>Delete key</button
        >
      </div>
    </Popover>
  {/if}

  <div class="tl-overlay" aria-hidden="true">
    {#if range}
      <span class="tl-range" style="left: {percent(range.from)}%; right: {100 - percent(range.to)}%"></span>
    {/if}
    {#if ui.timeline}
      <span class="playhead" style="left: {percent(ui.timeline.frame)}%"></span>
    {/if}
  </div>
</div>
