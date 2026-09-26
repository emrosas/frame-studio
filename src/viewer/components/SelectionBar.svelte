<!--
  The selection bar: what is picked (scene, layer › part, frame range), fields
  to type the range, and buttons to clear either half. A field shows the
  current range unless you are typing in it or it holds rejected text. Enter
  applies, Esc reverts, and leaving the field applies.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';

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

{#snippet clearIcon()}
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2z" /></svg>
{/snippet}

<div class="controls-row selection-bar" class:is-disabled={!enabled} role="group" aria-label="Selection">
  <span class="sel-group">
    <span class="label">Scene</span>
    <output class="sel-value sel-scene">{sel.sceneId ?? '-'}</output>
  </span>
  <span class="sel-group">
    <span class="label">Layer</span>
    <output class="sel-value sel-layer" class:is-empty={sel.layer === ''} aria-label="Selected layer">{sel.layer === '' ? 'none' : sel.layer}</output>
    <button type="button" class="sel-clear" aria-label="Clear layer (Esc)" title="Clear layer (Esc)" disabled={sel.layer === ''} onclick={(e) => clear(actions.clearLayer, e)}>
      {@render clearIcon()}
    </button>
    {#if sel.shot}
      <button type="button" class="open-shot" title="Open {sel.shot} at the matching frame" onclick={(e) => clear(() => actions.openShot(), e)}>Open shot</button>
    {/if}
  </span>
  <span class="sel-group">
    <span class="label">Range</span>
    <output class="sel-value sel-interval" class:is-empty={sel.range === null} aria-label="Frame range">{sel.rangeText ? sel.rangeText.interval : '-'}</output>
    <span class="sel-timecodes" hidden={!sel.rangeText?.timecodes}>{sel.rangeText?.timecodes ?? ''}</span>
    <span class="sel-count">{sel.rangeText ? sel.rangeText.count : ''}</span>
  </span>
  <span class="sel-group sel-edit">
    {#each fields as { end, label } (end)}
      <span class="label">{end}</span>
      <input
        class="sel-field"
        type="text"
        inputmode="text"
        autocomplete="off"
        spellcheck="false"
        size="8"
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
    <button type="button" class="sel-clear" aria-label="Clear range" title="Clear range" disabled={sel.range === null} onclick={(e) => clear(actions.clearRange, e)}>
      {@render clearIcon()}
    </button>
  </span>
  <span class="sel-error" role="status" aria-live="polite" hidden={!error}>{error ?? ''}</span>
  <span class="sel-notice" role="status" aria-live="polite" hidden={!sel.notice}>{sel.notice ?? ''}</span>
  <span class="spacer"></span>
  <div class="hint">
    click select <span class="sep">·</span> again to cycle <span class="sep">·</span> <kbd>Alt</kbd>+click part <span class="sep">·</span>
    <kbd>I</kbd><kbd>O</kbd> range <span class="sep">·</span> <kbd>Esc</kbd> clear
  </div>
</div>
