<!--
  The selection, under the transport: the layer picked on the canvas (layer ›
  part) and the frame range, with fields to type the range and buttons to
  clear either half; Open shot for a selected shot. A field shows the current
  range unless you are typing in it or it holds rejected text. Enter applies,
  Esc reverts, and leaving the field applies.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';

  type End = 'from' | 'to';
  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const sel = $derived(ui.selection);
  const enabled = $derived(sel.sceneId !== null);
  const display = (end: End): string => (sel.range ? String(sel.range[end]) : '');

  let text = $state<Record<End, string>>({ from: '', to: '' });
  let invalid = $state<End | null>(null);
  let error = $state<string | null>(null);

  // A new range (or scene) from anywhere else resets both fields and clears any error. Only the
  // signature may trigger it: the App replaces ui.selection on every UI refresh, many times a
  // second while playing, and reading it tracked here would wipe what you are typing.
  const signature = $derived(JSON.stringify([sel.range, sel.frameCount, enabled]));
  $effect(() => {
    void signature;
    untrack(() => {
      text = { from: display('from'), to: display('to') };
      invalid = null;
      error = null;
    });
  });

  /** Applies a field's text. Returns true when applied, or when nothing changed. */
  function commit(end: End): boolean {
    if (!enabled) return false;
    if (text[end] === display(end)) return true;
    const message = actions.editRange(end, text[end]);
    if (message) {
      invalid = end;
      error = `${end}: ${message}`;
      return false;
    }
    invalid = null;
    error = null;
    return true;
  }

  function onKeydown(end: End, e: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commit(end)) e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      invalid = null;
      error = null;
      text[end] = display(end);
      e.currentTarget.blur();
    }
  }

  function clear(action: () => void, e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    action();
    // Hand focus back so Space, the arrows, I, O and Escape drive the viewer again.
    e.currentTarget.blur();
  }

  const fields: { end: End; label: string }[] = [
    { end: 'from', label: 'From frame (included)' },
    { end: 'to', label: 'To frame (excluded)' },
  ];
</script>

<div class="selection-bar" class:is-disabled={!enabled} role="group" aria-label="Selection">
  <span class="chip is-layer" class:is-set={sel.layer !== ''} title={sel.layer || 'Click the canvas to select a layer, again to cycle; Alt+click for a part'}>
    <Icon name="pointer" size={14} />
    <output class="chip-value" class:is-empty={sel.layer === ''} aria-label="Selected layer">{sel.layer === '' ? 'No layer' : sel.layer}</output>
    <button type="button" class="icon-btn is-small" aria-label="Clear layer (Esc)" title="Clear layer (Esc)" hidden={sel.layer === ''} onclick={(e) => clear(actions.clearLayer, e)}>
      <Icon name="close" size={13} />
    </button>
  </span>
  <span class="chip" class:is-set={sel.range !== null} title="Frames [from, to): to is not included. I and O mark them at the playhead.">
    <Icon name="range" size={14} />
    {#each fields as { end, label }, i (end)}
      {#if i === 1}<span class="arrow">→</span>{/if}
      <input
        class="sel-field"
        type="text"
        inputmode="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="{label}: a frame number or MM:SS:FF"
        title="{label}. A frame number or MM:SS:FF; Enter applies, Esc reverts."
        aria-invalid={invalid === end ? 'true' : undefined}
        placeholder={end === 'from' ? '0' : String(sel.frameCount)}
        disabled={!enabled}
        bind:value={text[end]}
        onkeydown={(e) => onKeydown(end, e)}
        oninput={() => {
          if (invalid === end) {
            invalid = null;
            error = null;
          }
        }}
        onblur={() => {
          if (text[end] !== display(end)) commit(end);
        }}
      />
    {/each}
    <output class="sub chip-value is-empty" aria-label="Frame range">{sel.range && sel.rangeText ? sel.rangeText.interval : 'All frames'}</output>
    <span class="sub is-count" hidden={!sel.range || !sel.rangeText?.count}>{sel.rangeText?.count ?? ''}</span>
    <span class="sub is-timecodes" hidden={!sel.rangeText?.timecodes}>{sel.rangeText?.timecodes ?? ''}</span>
    <button type="button" class="icon-btn is-small" aria-label="Clear range" title="Clear range" hidden={sel.range === null} onclick={(e) => clear(actions.clearRange, e)}>
      <Icon name="close" size={13} />
    </button>
  </span>
  {#if sel.shot}
    <button type="button" class="btn is-small" title="Open {sel.shot} at the matching frame" onclick={(e) => clear(() => actions.openShot(), e)}>
      <Icon name="shot" size={14} />Open shot
    </button>
  {/if}
  <span class="sel-error" role="status" aria-live="polite" title={error ?? ''} hidden={!error}>{error ?? ''}</span>
  <span class="sel-notice" role="status" aria-live="polite" title={sel.notice ?? ''} hidden={!sel.notice}>{sel.notice ?? ''}</span>
</div>
