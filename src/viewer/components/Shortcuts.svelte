<!-- The keyboard shortcuts and canvas gestures, from the top bar. Escape or a click elsewhere closes it. -->
<script lang="ts">
  import Icon from './Icon.svelte';

  let { sound, onclose }: { sound: boolean; onclose: () => void } = $props();

  let box = $state<HTMLElement | null>(null);

  const rows: { keys: string[]; what: string }[] = $derived([
    { keys: ['Space'], what: 'Play or pause' },
    { keys: ['←', '→'], what: 'Previous or next frame' },
    { keys: ['Shift', '←', '→'], what: 'One second back or on' },
    { keys: ['Home', 'End'], what: 'First or last frame' },
    ...(sound ? [{ keys: ['M'], what: 'Sound on or off' }] : []),
    { keys: ['Click'], what: 'Select the layer under the pointer; again to cycle' },
    { keys: ['Alt', 'Click'], what: 'Select a part of the layer' },
    { keys: ['I', 'O'], what: 'Frame range starts or ends here' },
    { keys: ['Esc'], what: 'Clear the selection' },
    { keys: ['Return'], what: 'Send a prompt (Shift+Return for a new line)' },
  ]);
</script>

<!-- Capture, so Escape closes this before the viewer sees it and clears the selection. -->
<svelte:window
  onkeydowncapture={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }}
  onpointerdown={(e) => {
    if (box && !box.contains(e.target as Node) && !(e.target as HTMLElement).closest('[aria-label="Keyboard shortcuts"]')) onclose();
  }}
/>

<div class="popover shortcuts" role="region" aria-label="Keyboard shortcuts" bind:this={box}>
  <header>
    <h2>Shortcuts</h2>
    <button type="button" class="icon-btn is-small" aria-label="Close" onclick={onclose}><Icon name="close" size={14} /></button>
  </header>
  <dl>
    {#each rows as row (row.what)}
      <dt>{#each row.keys as key (key)}<kbd>{key}</kbd>{/each}</dt>
      <dd>{row.what}</dd>
    {/each}
  </dl>
</div>
