<!--
  The selection as one token, the same in the dock and on the composer: what is
  picked, in the words selection.ts gives it, when it runs in clock time, and an
  x. Clicking the time shows the From and To fields in the dock's token, which
  take a frame number or MM:SS:FF. A field shows the current range unless you
  are typing in it or it holds rejected text. Return applies, Esc reverts, and
  leaving a field applies.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { WHOLE_SCENE } from '../selection';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';

  type End = 'from' | 'to';
  let { ui, actions, docked = false }: { ui: ViewerUi; actions: ViewerActions; docked?: boolean } = $props();

  const sel = $derived(ui.selection);
  const enabled = $derived(sel.sceneId !== null);
  // A cue is named in the dock only: a request has no cue, so the prompt stays on the whole scene.
  const cue = $derived(docked ? ui.cue : null);
  const picked = $derived(sel.layer !== '' || sel.range !== null || cue !== null);
  const who = $derived(sel.layer || cue || WHOLE_SCENE);
  const hint = 'Select on the canvas, a timeline row, or with @ in the prompt';
  const display = (end: End): string => (sel.range ? String(sel.range[end]) : '');

  let text = $state<Record<End, string>>({ from: '', to: '' });
  let invalid = $state<End | null>(null);
  let error = $state<string | null>(null);
  let fieldsBox = $state<HTMLElement | null>(null);

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

  $effect(() => {
    if (!ui.rangeEditing) return;
    error = null;
    fieldsBox?.querySelector('input')?.focus();
  });

  /** Applies a field's text. Returns true when applied, or when nothing changed. */
  function commit(end: End): boolean {
    if (!enabled) return false;
    if (text[end] === display(end)) return true;
    const message = actions.editRange(end, text[end]);
    if (message) {
      invalid = end;
      error = message;
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

  const fields: { end: End; label: string }[] = [
    { end: 'from', label: 'From frame (included)' },
    { end: 'to', label: 'To frame (excluded)' },
  ];
</script>

{#snippet when()}
  <button
    type="button"
    class="token-when"
    disabled={!enabled}
    aria-expanded={docked ? ui.rangeEditing : undefined}
    title="{sel.whenTitle}. Click to type frames."
    onclick={(e) => {
      ui.rangeEditing = true;
      e.currentTarget.blur();
    }}>{sel.when}</button
  >
{/snippet}

<span class="token" class:is-set={picked} class:is-disabled={!enabled}>
  <Icon name="viewfinder" />
  {#if docked}
    <output class="token-who" aria-label="Selected layer" title={picked ? who : hint}>{who}</output>
  {:else}
    <span class="token-who" title={picked ? who : hint}>{who}</span>
  {/if}
  {#if docked && ui.rangeEditing}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span
      class="token-fields"
      bind:this={fieldsBox}
      onfocusout={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        // Rejected text goes back to the range; the message stays until the fields open again.
        invalid = null;
        text = { from: display('from'), to: display('to') };
        ui.rangeEditing = false;
      }}
    >
      {#each fields as { end, label }, i (end)}
        {#if i === 1}<span class="token-dash">–</span>{/if}
        <input
          class="sel-field"
          type="text"
          autocomplete="off"
          spellcheck="false"
          aria-label="{label}: a frame number or MM:SS:FF"
          title="{label}. A frame number or MM:SS:FF. Return applies, Esc reverts."
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
    </span>
  {:else if docked}
    <output aria-label="Frame range">{@render when()}</output>
  {:else}
    {@render when()}
  {/if}
  {#if picked}
    <button
      type="button"
      class="token-clear"
      aria-label="Clear selection"
      title="Clear selection"
      onclick={(e) => {
        actions.clearSelection();
        // Hand focus back so Space, the arrows, I, O and Escape drive the viewer again.
        e.currentTarget.blur();
      }}><Icon name="close" /></button
    >
  {/if}
</span>
{#if docked}<span class="sel-error" role="status" aria-live="polite" title={error ?? ''} hidden={!error}>Use a frame number or 00:01:06</span>{/if}
