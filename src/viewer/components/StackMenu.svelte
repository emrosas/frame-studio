<!--
  Keynote's stack menu: right-click the canvas for every layer under the
  pointer, top first, and pick the one a click can't reach. The arrow keys move
  through it and Return picks. Picking hands the keyboard back to the viewer.
-->
<script lang="ts">
  import type { StackMenu, ViewerActions, ViewerUi } from '../ui.svelte';
  import Popover from './Popover.svelte';

  let { ui, actions, menu }: { ui: ViewerUi; actions: ViewerActions; menu: StackMenu } = $props();

  let list = $state<HTMLElement | null>(null);

  // Kept on screen when the click was near an edge.
  const WIDTH = 200;
  const left = $derived(Math.min(menu.x, window.innerWidth - WIDTH - 8));
  const top = $derived(Math.min(menu.y, window.innerHeight - menu.layers.length * 28 - 20));

  $effect(() => {
    list?.querySelector('button')?.focus();
  });

  function move(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(list?.querySelectorAll('button') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }

  function close(): void {
    actions.hoverLayer(null);
    ui.stackMenu = null;
  }
</script>

<Popover label="Layers here" role="menu" class="stack-menu" style="left: {left}px; top: {top}px; width: {WIDTH}px" onclose={close}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="menu-list" bind:this={list} onkeydown={move}>
    {#each menu.layers as id (id)}
      <button
        type="button"
        role="menuitem"
        class="menu-item"
        class:is-on={ui.layerId === id}
        onpointerenter={() => actions.hoverLayer(id)}
        onpointerleave={() => actions.hoverLayer(null)}
        onclick={(e) => {
          actions.hoverLayer(null);
          actions.pickStack(id);
          e.currentTarget.blur();
        }}>{id}</button
      >
    {/each}
  </div>
</Popover>
