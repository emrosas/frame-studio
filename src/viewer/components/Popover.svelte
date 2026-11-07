<!--
  The one look every custom popover shares: a floating sheet that closes on
  Escape or a press outside it. `anchor` is the element around its trigger, so
  a press on the trigger stays the trigger's. Where it sits is up to the class.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    role = 'region',
    class: className = '',
    style = '',
    anchor = null,
    onclose,
    children,
  }: {
    label: string;
    role?: 'region' | 'menu' | 'listbox';
    class?: string;
    style?: string;
    anchor?: HTMLElement | null;
    onclose: () => void;
    children: Snippet;
  } = $props();

  let box = $state<HTMLElement | null>(null);
</script>

<!-- Capture, so Escape closes this before the viewer sees it and clears the selection. -->
<svelte:window
  onkeydowncapture={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }}
  onpointerdowncapture={(e) => {
    const target = e.target as Node;
    if (!box || box.contains(target) || anchor?.contains(target)) return;
    // Pressing away from a menu only closes it, as on a Mac: the click under it goes nowhere.
    if (role === 'menu') {
      const swallow = (click: MouseEvent) => click.stopPropagation();
      addEventListener('click', swallow, { capture: true, once: true });
      addEventListener('pointerup', () => setTimeout(() => removeEventListener('click', swallow, { capture: true })), { once: true });
    }
    onclose();
  }}
/>

<div class="popover {className}" {role} aria-label={label} {style} bind:this={box}>
  {@render children()}
</div>
