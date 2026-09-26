<!-- One icon from icons.ts, sized in CSS pixels and drawn in the text colour. -->
<script lang="ts">
  import { ICONS, type IconName, type IconShape } from '../icons';

  let { name, size = 16 }: { name: IconName; size?: number } = $props();
  const shape = $derived<IconShape>(ICONS[name]);
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
  {#if shape.filled}
    <path d={shape.d} fill="currentColor" />
  {:else}
    <path d={shape.d} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
  {/if}
</svg>
