<!--
  The selection, in the dock's top row: anything to say about it, Open shot for
  a selected shot, and the token. One line, always: a selection never changes
  the dock's height, so the canvas doesn't jump and the bands stay put under a
  double-click.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import SelectionToken from './SelectionToken.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const sel = $derived(ui.selection);
</script>

<div class="selection-bar" role="group" aria-label="Selection">
  <span class="sel-notice" role="status" aria-live="polite" title={sel.notice ?? ''} hidden={!sel.notice}>{sel.notice ?? ''}</span>
  {#if sel.shot}
    <button
      type="button"
      class="btn is-ghost"
      title="Open {sel.shot} at the matching frame"
      onclick={(e) => {
        actions.openShot();
        e.currentTarget.blur();
      }}><Icon name="shot" />Open shot</button
    >
  {/if}
  <SelectionToken {ui} {actions} docked />
</div>
