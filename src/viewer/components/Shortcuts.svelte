<!-- The keyboard shortcuts and pointer gestures, inside the View popover. -->
<script lang="ts">
  let { sound }: { sound: boolean } = $props();

  const rows: { keys: string[]; what: string }[] = $derived([
    { keys: ['Space'], what: 'Play or pause' },
    { keys: ['←', '→'], what: 'Previous or next frame' },
    { keys: ['Shift', '←', '→'], what: 'One second back or on' },
    { keys: ['Home', 'End'], what: 'First or last frame' },
    ...(sound ? [{ keys: ['M'], what: 'Sound on or off' }] : []),
    { keys: ['Click'], what: 'Select what is under the pointer; again to go deeper' },
    { keys: ['Option', 'Click'], what: 'Select a part' },
    { keys: ['Right-click'], what: 'List every layer under the pointer' },
    { keys: ['↑', '↓'], what: 'Next layer, from a timeline row' },
    { keys: ['I', 'O'], what: 'Range starts or ends here' },
    { keys: ['X'], what: 'Mark the selected clip or layer as the range' },
    { keys: ['Esc'], what: 'Clear the layer, then the range' },
    { keys: ['Return'], what: 'Go to the prompt' },
    { keys: ['@'], what: 'Pick a layer, in the prompt' },
    { keys: ['Drag'], what: 'Move what is under the pointer on the canvas' },
    { keys: ['Shift', 'Drag'], what: 'Move along one axis' },
    { keys: ['Delete'], what: 'Remove the selected key' },
    { keys: ['←', '→'], what: 'Nudge the selected key a frame; Shift for ten' },
    { keys: ['⌘', 'Z'], what: 'Undo a key, clip or canvas edit' },
  ]);
</script>

<h2>Shortcuts</h2>
<dl class="shortcuts">
  {#each rows as row (row.what)}
    <dt>{#each row.keys as key (key)}<kbd>{key}</kbd>{/each}</dt>
    <dd>{row.what}</dd>
  {/each}
</dl>
