<!--
  The timeline: headers on the left, a ruler with seconds, markers and the frame
  range pinned on top, and rows that scroll under it. A scene has a row per
  layer, top of the stack first and the background last: a bar for when it is on
  screen, its keys as diamonds, its overrides as tinted spans. A composition has
  its tracks, top of the stack first, and clips that overlap on a track take a
  row each. A film's shots go in rows by overlap. Sound takes the rows under
  either.

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

  On a composition a clip drags to move, up and down to another track, and its
  edges drag to trim, snapping to the playhead, markers and every other edge.
  Sound moves, trims and fades the same way, on scenes too. A right-click on
  either offers split, duplicate and delete, and on a clip the transitions. The
  corner adds clips and tracks. It all saves through the server's checked edit,
  Command-Z takes it back, and it stays locked while an agent works there (ADR
  0018). The range input underneath keeps the frame on the keyboard and in the
  accessibility tree.

  A Library card or media row dropped here lands at the drop time, snapped like
  a clip drag, with a ghost while it hovers: on a composition a scene or picture
  becomes a clip on the track under the pointer (a new one above or below the
  tracks, or above a full one), and sound becomes a cue on either. Files from
  the computer import first, then land the same way.

  A cue with words gets a row of its own under the layers, VoiceRow.svelte, and
  a sound file without them offers Timing (ADR 0016). A marker's click selects it,
  so a word's right-click can anchor it.
-->
<script lang="ts">
  import type { KeyMark, KeyTarget, SelectedKey } from '../keyframes';
  import { isPictureFile } from '../../engine/picture';
  import { DRAG_TYPE, dropFrames, dropKind, dropStart, dropTrack, mediaFiles, readItem, type DropKind, type DropTrack, type LibraryItem } from '../drop';
  import { clipEdges, dragClip, dragCue, dragFade, dragSpan, formatClock, labelFits, markerLabels, rulerTicks, snapDelta, snapFrame, type ClipHandle, type ClipPlace, type CuePlace, type VisibleSpan } from '../timeline';
  import { spanLabel, type FrameRange } from '../selection';
  import type { EditTarget, LayerRow, ShotBand, ShotHead, SoundBand as SoundBandData, ViewerActions, ViewerUi } from '../ui.svelte';
  import type { VoiceLine } from '../voice';
  import Icon from './Icon.svelte';
  import Popover from './Popover.svelte';
  import SoundBand from './SoundBand.svelte';
  import VoiceCard from './VoiceCard.svelte';
  import VoiceRow from './VoiceRow.svelte';
  import type { WordChip } from '../voice';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  let ruler = $state<HTMLElement | null>(null);
  let scroller = $state<HTMLElement | null>(null);
  let shotRows = $state<HTMLElement | null>(null);
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
    return [...ui.markers.map((m) => m.frame), ...(ui.timeline ? [ui.timeline.frame] : []), ...edges(ui.shots?.bands), ...edges(ui.sounds?.bands), ...edges(ui.voices), ...own];
  }

  /** What a dragged clip or sound lands on: all that, less its own edges. */
  function bandTargets(band: { from: number; to: number }): number[] {
    let own = [band.from, band.to];
    return snapTargets([0, total]).filter((frame) => {
      const at = own.indexOf(frame);
      if (at < 0) return true;
      own = own.filter((_, i) => i !== at);
      return false;
    });
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
    // A bar retimes only once its row is selected, so a press on any other row still selects or drags out a range.
    if (bar && e.button === 0 && ui.keyEdit === 'on' && ui.layerId === row.id) {
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
    // Markers and the range only: at this scale every other layer's keys would catch the drag at random.
    const targets = [...ui.markers.map((m) => m.frame), ...(ui.timeline ? [ui.timeline.frame] : []), ...(range ? [range.from, range.to] : [])];
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
    const when = `${mark.params.join(', ')} at ${formatClock(mark.at, fps)}${mark.anchored ? ', on a spoken word' : ''}.`;
    return canEditKeys ? `${when} Drag to move, click then Delete to remove.` : ui.keyEdit === 'locked' ? `${when} An agent is working here, so keys stay put.` : when;
  }

  function barTitle(bar: VisibleSpan): string {
    const when = `On screen ${spanLabel(bar, fps)}.`;
    return canEditKeys ? `${when} Drag to shift the layer's keys and overrides, drag an end to move that fade.` : when;
  }

  const isSelectedKey = (layerId: string, param: string | null, mark: KeyMark) => ui.selectedKey?.layerId === layerId && ui.selectedKey.param === param && ui.selectedKey.frame === mark.frame;

  // ---- words ----

  /** The word a right-click is on. */
  let wordMenu = $state<{ x: number; y: number; cue: string; chip: WordChip } | null>(null);
  const anchorName = $derived(ui.selectedKey ? 'key' : ui.selectedMarker !== null ? 'marker' : null);

  function openWordMenu(e: MouseEvent, cue: string, chip: WordChip): void {
    if (!canEditKeys) return;
    wordMenu = { x: Math.min(e.clientX + 8, window.innerWidth - 228), y: Math.min(e.clientY, window.innerHeight - 44), cue, chip };
  }

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
  let held = $state<{ layerId: string; place: ClipPlace; track?: string; saving: boolean } | null>(null);
  /** The band clicked last, so a double-click opens it even if the first click moved the bands under the pointer. */
  let lastBand: { layerId: string; at: number } | null = null;
  let dragged = false;

  const editable = $derived(ui.shots !== null && !ui.shots.locked);
  const video = $derived(ui.shots?.composition === true);

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
    if (band?.clip && band.clip.from === place.from && band.clip.in === place.in && band.clip.out === place.out && (held.track === undefined || held.track === band.track)) held = null;
  });

  /** The track under a height on the screen, while a clip is dragged. */
  function trackAt(y: number): string | undefined {
    const rows = ui.shots;
    const box = shotRows?.getBoundingClientRect();
    if (!rows || !box || box.height <= 0) return undefined;
    const lane = Math.max(0, Math.min(rows.lanes - 1, Math.floor(((y - box.top) / box.height) * rows.lanes)));
    return rows.heads.find((h) => lane >= h.lane && lane < h.lane + h.lanes)?.track;
  }

  /** The row a band shows on: a dragged clip's, on the track it's over. */
  function laneOf(band: ShotBand): number {
    if (held?.layerId !== band.layerId || held.track === undefined || held.track === band.track) return band.lane;
    return ui.shots?.heads.find((h) => h.track === held?.track)?.lane ?? band.lane;
  }

  function startClip(e: PointerEvent, band: ShotBand): void {
    dragged = false;
    const clip = band.clip;
    if (e.button !== 0 || !clip || !editable || held) return;
    const edge = (e.target as HTMLElement).dataset.edge as ClipHandle | undefined;
    const handle: ClipHandle = edge ?? 'move';
    const startX = e.clientX;
    const startY = e.clientY;
    const perFrame = ruler ? ruler.getBoundingClientRect().width / total : 1;
    const targets = bandTargets(band);
    const edges = clipEdges(clip, handle);
    follow(
      e,
      (ev) => {
        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3 && !dragged) return;
        dragged = true;
        const delta = snapDelta(edges, Math.round((ev.clientX - startX) / perFrame), targets, perFrame);
        const track = handle === 'move' ? (trackAt(ev.clientY) ?? band.track) : band.track;
        held = { layerId: band.layerId, place: dragClip(clip, handle, delta, total), ...(track !== undefined ? { track } : {}), saving: false };
      },
      (ev) => {
        if (!held) return;
        const { place, layerId, track } = held;
        const changedTrack = track !== band.track ? track : undefined;
        const moved = place.from !== clip.from || place.in !== clip.in || place.out !== clip.out || changedTrack !== undefined;
        if (!ev || !moved) {
          held = null;
          return;
        }
        held = { layerId, place, ...(track !== undefined ? { track } : {}), saving: true };
        void actions.moveClip(layerId, place, changedTrack).then((saved) => {
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
    return ui.shots?.locked ? `${base} An agent is working here, so clips stay put.` : `${base} Drag to move, drag an edge to trim, right-click for more.`;
  }

  // ---- sound ----

  /** The sound being dragged, or saving: where it shows until the new file arrives. */
  let heldCue = $state<{ id: string; place: CuePlace; saving: boolean } | null>(null);

  const samePlace = (a: CuePlace, b: CuePlace) => a.from === b.from && a.to === b.to && Math.abs(a.in - b.in) < 1e-6 && Math.abs(a.fadeIn - b.fadeIn) < 1e-6 && Math.abs(a.fadeOut - b.fadeOut) < 1e-6;

  // As with clips: the held place goes when the file says the same.
  $effect(() => {
    if (!heldCue?.saving) return;
    const { id, place } = heldCue;
    const now = ui.sounds?.bands.find((b) => b.id === id)?.place ?? ui.voices.find((v) => v.cue.id === id)?.place;
    if (now && samePlace(now, place)) heldCue = null;
  });

  function shownBand(band: SoundBandData): SoundBandData {
    if (heldCue?.id !== band.id) return band;
    return { ...band, from: heldCue.place.from, to: heldCue.place.to, place: heldCue.place };
  }

  function shownVoice(voice: VoiceLine): VoiceLine {
    if (heldCue?.id !== voice.cue.id) return voice;
    const { place } = heldCue;
    return { ...voice, from: place.from, to: place.to, place, cue: { ...voice.cue, start: place.from / fps, end: place.to / fps, ...(place.in > 0 ? { in: place.in } : {}) } };
  }

  /** Runs a drag of a sound. A press that never moves is `click`. */
  function dragSound(e: PointerEvent, id: string, place: CuePlace, next: (ev: PointerEvent) => CuePlace, click: () => void): void {
    const startX = e.clientX;
    let moved = false;
    follow(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 3) return;
        moved = true;
        heldCue = { id, place: next(ev), saving: false };
      },
      (ev) => {
        if (!moved) {
          if (ev) click();
          return;
        }
        const shown = heldCue?.id === id ? heldCue.place : place;
        if (!ev || samePlace(shown, place)) {
          heldCue = null;
          return;
        }
        heldCue = { id, place: shown, saving: true };
        void actions.saveCue(id, shown).then((saved) => {
          if (!saved) heldCue = null;
          else setTimeout(() => (heldCue = heldCue?.saving && heldCue.id === id ? null : heldCue), 2000);
        });
      },
    );
  }

  /** A press on a sound: its fade marks, its edges, or the band itself. */
  function pressCue(e: PointerEvent, id: string, place: CuePlace, click: () => void): void {
    if (e.button !== 0 || !ui.soundEdit || heldCue) {
      if (e.button === 0) click();
      return;
    }
    e.preventDefault();
    const target = e.target as HTMLElement;
    const fade = target.dataset.fade as 'in' | 'out' | undefined;
    const perFrame = perFramePx();
    const targets = bandTargets(place);
    if (fade) {
      const from = boundaryAt(e.clientX);
      const mark = fade === 'in' ? place.from + place.fadeIn * fps : place.to - place.fadeOut * fps;
      dragSound(e, id, place, (ev) => dragFade(place, fade, snapFrame(Math.round(mark + boundaryAt(ev.clientX) - from), targets, perFrame), fps), click);
      return;
    }
    const handle = (target.dataset.edge as ClipHandle | undefined) ?? 'move';
    const startX = e.clientX;
    const edges = handle === 'start' ? [place.from] : handle === 'end' ? [place.to] : [place.from, place.to];
    dragSound(e, id, place, (ev) => dragCue(place, handle, snapDelta(edges, Math.round((ev.clientX - startX) / perFrame), targets, perFrame), total, fps), click);
  }

  // ---- menus ----

  /** The right-click on a clip or sound, and the corner's list of what can be added. */
  let editMenu = $state<{ x: number; y: number; target: EditTarget; label: string; voice: boolean } | null>(null);
  let addMenu = $state<{ x: number; y: number } | null>(null);

  const addable = $derived(ui.scenes.filter((s) => !s.invalid && s.film === null && s.key !== ui.header?.key));
  const pictures = $derived(ui.media.filter((m) => isPictureFile(m.file)));
  const menuLocked = $derived(video ? !editable : !ui.soundEdit);
  const fileName = (file: string) => file.slice(file.lastIndexOf('/') + 1);

  function openEditMenu(e: MouseEvent, target: EditTarget, label: string, voice: boolean): void {
    e.preventDefault();
    if (menuLocked) return;
    editMenu = { x: Math.min(e.clientX + 8, window.innerWidth - 212), y: Math.min(e.clientY, window.innerHeight - 260), target, label, voice };
  }

  function clipMenu(e: MouseEvent, band: ShotBand): void {
    if (!band.clip) return;
    actions.selectLayer(band.layerId, { from: band.from, to: band.to });
    openEditMenu(e, { clip: band.layerId }, band.layerId, false);
  }

  function soundMenu(e: MouseEvent): void {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-cue]')?.dataset.cue;
    const band = ui.sounds?.bands.find((b) => b.id === id);
    if (band?.place) openEditMenu(e, { cue: band.id }, band.id, band.place.file);
  }

  function runMenu(run: (target: EditTarget) => void): void {
    if (editMenu) run(editMenu.target);
    editMenu = null;
  }

  function openAddMenu(e: MouseEvent): void {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addMenu = { x: box.left, y: Math.max(8, box.top - 8) };
  }

  function add(source: { scene: string } | { file: string }): void {
    addMenu = null;
    actions.addClip(source);
  }

  // ---- drops from the Library ----

  /** What a drag over the timeline would do: where it starts and how long it runs, in frames, what it becomes, and where. */
  interface DropPreview {
    from: number;
    to: number;
    kind: DropKind | null;
    track: DropTrack | null;
    /** A full track: the clip goes on a new one straight above it. */
    full: boolean;
    label: string;
  }
  let drop = $state<DropPreview | null>(null);

  const ourDrag = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes(DRAG_TYPE);
  const fileDrag = (e: DragEvent) => !ourDrag(e) && [...(e.dataTransfer?.types ?? [])].includes('Files');

  function preview(e: DragEvent, item: LibraryItem | null): DropPreview | null {
    if (!ui.timeline || total === 0) return null;
    const placed = item ? dropKind(item, video ? 'composition' : 'scene', ui.header?.key ?? null) : null;
    const kind: DropKind | null = placed && placed.as !== 'refused' && !ui.soundEdit ? { as: 'refused', reason: 'An agent is working here, so nothing can be added until it finishes.' } : placed;
    const asClip = kind?.as === 'clip';
    const frames = item ? dropFrames(item, fps) : 1;
    const from = dropStart(boundaryAt(e.clientX), frames, snapTargets([0, total]), perFramePx(), total, asClip ? 'clip' : 'cue');
    const to = asClip ? from + frames : Math.min(total, from + frames);
    const box = shotRows?.getBoundingClientRect();
    // Files could be clips or sound until they're imported, so they keep a track in case.
    const track = video && ui.shots && box && (asClip || !item) ? dropTrack(e.clientY - box.top, box.height, ui.shots.lanes, ui.shots.heads) : null;
    const full = track?.into === 'track' && (ui.shots?.bands.some((b) => b.track === track.track && b.from < to && b.to > from) ?? false);
    const at = formatClock(from, fps);
    const where = !track || !asClip ? '' : track.into === 'top' ? ' on a new track on top' : track.into === 'bottom' ? ' on a new track at the bottom' : full ? ` on a new track above ${track.track}` : ` on ${track.track}`;
    const label = !item ? `Import and place at ${at}` : kind?.as === 'refused' ? kind.reason : `${item.label} at ${at}${where}`;
    return { from, to, kind, track, full, label };
  }

  function dragOver(e: DragEvent): void {
    const files = fileDrag(e);
    if ((!ourDrag(e) && !files) || !ui.timeline) return;
    // Ours, or the window's file import would take it.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    drop = preview(e, files ? null : ui.dragging);
  }

  function dragLeave(e: DragEvent): void {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) drop = null;
  }

  function dropHere(e: DragEvent): void {
    drop = null;
    if (!ui.timeline) return;
    if (ourDrag(e)) {
      e.preventDefault();
      const item = ui.dragging ?? readItem(e.dataTransfer?.getData(DRAG_TYPE) ?? '');
      ui.dragging = null;
      const landed = item && preview(e, item);
      if (item && landed) actions.dropOnTimeline(item, landed.from, landed.track);
      return;
    }
    const files = mediaFiles(e.dataTransfer?.files);
    if (files.length === 0) return;
    e.preventDefault();
    const landed = preview(e, null);
    if (landed) actions.dropFiles(files, landed.from, landed.track);
  }

  // A drag that ends anywhere else takes its ghost with it.
  $effect(() => {
    if (ui.dragging === null && drop?.kind) drop = null;
  });

  const ghostLane = $derived.by(() => {
    const track = drop?.track;
    if (!drop || drop.kind?.as !== 'clip' || track?.into !== 'track' || drop.full) return null;
    return ui.shots?.heads.find((h) => h.track === track.track)?.lane ?? null;
  });
  /** A new track's line: on top, at the bottom, or above the full track. */
  const ghostLine = $derived.by((): { lane: number } | null => {
    const track = drop?.track;
    if (!drop || drop.kind?.as !== 'clip' || !track || ghostLane !== null || !ui.shots) return null;
    if (track.into === 'top') return { lane: 0 };
    if (track.into === 'bottom') return { lane: ui.shots.lanes };
    return { lane: ui.shots.heads.find((h) => h.track === track.track)?.lane ?? 0 };
  });

  function pressSounds(e: PointerEvent, bands: readonly SoundBandData[]): void {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-cue]')?.dataset.cue;
    const band = bands.find((b) => b.id === id);
    if (band) {
      if (e.button !== 0) return;
      const click = () => actions.selectCue(band.id, { from: band.from, to: band.to });
      if (band.place) pressCue(e, band.id, band.place, click);
      else click();
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
    class:is-anchored={mark.anchored}
    tabindex="-1"
    aria-label={keyTitle(mark)}
    title={keyTitle(mark)}
    style="left: {percent(mark.at)}%"
    onmousedown={(e) => e.preventDefault()}
    onpointerdown={(e) => pressKey(e, layerId, param, mark)}
    oncontextmenu={(e) => openKeyMenu(e, layerId, param, mark)}
  ></button>
{/snippet}

{#snippet shotHeads(rows: readonly ShotHead[])}
  <div class="tl-heads">
    {#each rows as head (head.lane)}
      <span class="row-head" style="height: calc({head.lanes} * var(--row))">
        {head.name}
        {#if head.removable && editable && head.track}
          {@const track = head.track}
          <button type="button" class="track-remove" aria-label="Remove track {track}" title="Remove this empty track" onclick={() => actions.deleteTrack(track)}><Icon name="close" /></button>
        {/if}
      </span>
    {/each}
  </div>
{/snippet}

{#snippet heads(name: string, lanes: number)}
  <div class="tl-heads" aria-hidden="true">
    {#each { length: lanes } as _, lane (lane)}
      <span class="row-head">{named(name, lane)}</span>
    {/each}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tl" class:is-empty={!ui.timeline} class:is-drop={drop !== null} oncontextmenu={(e) => e.preventDefault()} ondragover={dragOver} ondragleave={dragLeave} ondrop={dropHere}>
  <div class="tl-top">
    <div class="tl-corner">
      {#if video}
        <button type="button" class="tl-add" disabled={!editable} title="Add a scene, video or picture at the playhead" onclick={openAddMenu}><Icon name="plus" />Clip</button>
        <button type="button" class="tl-add" disabled={!editable} title="Add a track on top" onclick={() => actions.addTrack()}><Icon name="plus" />Track</button>
      {/if}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ruler" bind:this={ruler} bind:clientWidth={width} onpointerdown={startScrub}>
      {#if ui.markers.length > 0}
        <div class="ruler-markers">
          {#each ui.markers as marker, i (`${marker.frame}-${marker.label}`)}
            <span class="marker" class:is-sync={marker.label.endsWith('!')} class:is-crowded={!labelled[i]} class:is-selected={marker.index !== undefined && ui.selectedMarker === marker.index} class:is-anchored={marker.anchored} style="left: {percent(marker.frame)}%">
              <button
                type="button"
                tabindex="-1"
                title={marker.label}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => {
                  actions.selectMarker(marker.index ?? null);
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
        {@render shotHeads(ui.shots.heads)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="shots"
          bind:this={shotRows}
          role="group"
          aria-label="Shots"
          style="--lanes: {ui.shots.lanes}"
          ondblclick={openBand}
          onpointerdown={(e) => {
            if (e.target === e.currentTarget) startSpan(e, null, [], () => {});
          }}
        >
          {#each ui.shots.heads as head (head.lane)}
            {#if head.track}<span class="track-lane" class:is-target={held !== null && !held.saving && held.track === head.track} style="--lane: {head.lane}; --span: {head.lanes}"></span>{/if}
          {/each}
          {#if drop && ghostLane !== null}
            <span class="drop-ghost" style={spanStyle(drop.from, Math.min(total, drop.to), ghostLane)}></span>
          {:else if drop && ghostLine}
            <span class="drop-track" style="{spanStyle(drop.from, Math.min(total, drop.to), 0)}; --at: {ghostLine.lane}"></span>
          {/if}
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
              style={spanStyle(place.from, place.to, laneOf(band))}
              title={bandTitle(band)}
              oncontextmenu={(e) => clipMenu(e, band)}
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
    {#each ui.voices as voice (voice.cue.id)}
      <div class="tl-section">
        <div class="tl-heads" aria-hidden="true"><span class="row-head" title={voice.label}>Voice</span></div>
        <div class="voices">
          <VoiceRow
            voice={shownVoice(voice)}
            {ui}
            {actions}
            {fps}
            {total}
            px={spanPx}
            ready={ui.sound?.status === 'ready' || ui.sound?.status === 'locked'}
            editable={canEditKeys}
            {boundaryAt}
            {startSpan}
            {follow}
            onmenu={(e, chip) => openWordMenu(e, voice.cue.id, chip)}
            cueEditable={ui.soundEdit}
            pressCue={(e) => {
              if (voice.place) pressCue(e, voice.cue.id, voice.place, () => actions.selectCue(voice.cue.id, { from: voice.from, to: voice.to }));
            }}
            oncuemenu={(e) => {
              if (voice.place) openEditMenu(e, { cue: voice.cue.id }, voice.cue.id, true);
            }}
          />
        </div>
      </div>
    {/each}
    {#if ui.sounds}
      {@const sounds = ui.sounds}
      <div class="tl-section">
        {@render heads('Sound', sounds.lanes)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="sounds" role="group" aria-label="Sounds" style="--lanes: {sounds.lanes}" onpointerdown={(e) => pressSounds(e, sounds.bands)} oncontextmenu={soundMenu}>
          {#if drop?.kind?.as === 'cue'}
            <span class="drop-ghost" style={spanStyle(drop.from, drop.to, 0)}></span>
          {/if}
          {#each sounds.bands as band (band.id)}
            {@const placed = shownBand(band)}
            <SoundBand band={placed} {actions} {fps} px={spanPx(placed.from, placed.to)} selected={ui.cue === band.id} editable={ui.soundEdit} ready={ui.sound?.status === 'ready' || ui.sound?.status === 'locked'} style={spanStyle(placed.from, placed.to, band.lane)} />
          {/each}
        </div>
      </div>
    {/if}
  </div>

  {#if editMenu}
    {@const clip = 'clip' in editMenu.target ? editMenu.target.clip : null}
    {@const cue = 'cue' in editMenu.target ? editMenu.target.cue : null}
    <Popover label={editMenu.label} role="menu" class="stack-menu" style="left: {editMenu.x}px; top: {editMenu.y}px; width: 204px" onclose={() => (editMenu = null)}>
      <div class="menu-list">
        <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu((t) => actions.splitAtPlayhead(t))}>Split at playhead</button>
        <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu((t) => actions.duplicateSelected(t))}>Duplicate</button>
        <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu((t) => actions.deleteSelected(t))}>Delete</button>
        {#if clip !== null}
          <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu(() => actions.setTransition(clip, 'crossfade'))}>Crossfade in</button>
          <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu(() => actions.setTransition(clip, 'wipe'))}>Wipe in</button>
          <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu(() => actions.setTransition(clip, 'iris'))}>Iris in</button>
          <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu(() => actions.setTransition(clip, null))}>Remove transition</button>
        {/if}
        {#if cue !== null && video && editMenu.voice}
          <button type="button" role="menuitem" class="menu-item" onclick={() => runMenu(() => actions.moveCueToScene(cue))}>Move to a voice scene</button>
        {/if}
      </div>
    </Popover>
  {/if}

  {#if addMenu}
    <Popover label="Add a clip" role="menu" class="stack-menu tl-add-menu" style="left: {addMenu.x}px; bottom: {window.innerHeight - addMenu.y}px; width: 240px" onclose={() => (addMenu = null)}>
      <div class="menu-list">
        {#each addable as option (option.key)}
          <button type="button" role="menuitem" class="menu-item" data-add={option.key} onclick={() => add({ scene: option.key })}>{option.label}</button>
        {/each}
        {#each pictures as media (media.file)}
          <button type="button" role="menuitem" class="menu-item" data-add={media.file} onclick={() => add({ file: media.file })}>{fileName(media.file)}</button>
        {/each}
        {#if addable.length === 0 && pictures.length === 0}
          <span class="menu-empty">Nothing to add yet. Make a scene, or import a picture.</span>
        {/if}
      </div>
    </Popover>
  {/if}

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

  {#if wordMenu}
    <Popover label="Word" role="menu" class="stack-menu" style="left: {wordMenu.x}px; top: {wordMenu.y}px; width: 220px" onclose={() => (wordMenu = null)}>
      <div class="menu-list">
        <button
          type="button"
          role="menuitem"
          class="menu-item"
          disabled={anchorName === null}
          onclick={() => {
            if (wordMenu) actions.anchorToWord(wordMenu.cue, wordMenu.chip.id);
            wordMenu = null;
          }}>{anchorName ? `Anchor selected ${anchorName} here` : 'Select a key or marker to anchor'}</button
        >
      </div>
    </Popover>
  {/if}

  {#if ui.voiceJob}
    <VoiceCard job={ui.voiceJob} {actions} />
  {/if}

  <div class="tl-overlay" aria-hidden="true">
    {#if range}
      <span class="tl-range" style="left: {percent(range.from)}%; right: {100 - percent(range.to)}%"></span>
    {/if}
    {#if ui.timeline}
      <span class="playhead" style="left: {percent(ui.timeline.frame)}%"></span>
    {/if}
    {#if drop}
      <span class="drop-line" class:is-refused={drop.kind?.as === 'refused'} style="left: {percent(drop.from)}%"></span>
      <span class="drop-note" class:is-refused={drop.kind?.as === 'refused'} class:is-end={drop.from > total / 2} style="left: {percent(drop.from)}%">{drop.label}</span>
    {/if}
  </div>
</div>
