<!-- One icon from icons.ts at 16 px, in the text colour. -->
<script lang="ts">
  import { ICONS, type IconName, type IconShape } from '../icons';

  let { name }: { name: IconName } = $props();
  const shape = $derived<IconShape>(ICONS[name]);
</script>

<svg class="icon" width="16" height="16" viewBox={shape.viewBox ?? '0 0 24 24'} aria-hidden="true">
  {#if shape.filled}
    <path d={shape.d} fill={shape.color ?? 'currentColor'} fill-rule={shape.evenodd ? 'evenodd' : undefined} />
  {:else}
    <path d={shape.d} fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" />
  {/if}
</svg>
