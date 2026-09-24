<!--
  The error panel over the stage. Every failure the viewer knows about shows
  here with its full message list, so the page never goes blank without saying why.
-->
<script lang="ts">
  import type { ErrorBlock } from '../ui.svelte';

  let { errors }: { errors: ErrorBlock[] } = $props();
</script>

<section class="error-panel" role="alert" hidden={errors.length === 0}>
  {#each errors as block (block.source)}
    <div class="error-block error-{block.source}">
      <h2>{block.title}</h2>
      {#if block.lines.length > 0}
        <ul>
          {#each block.lines as line, i (i)}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
      {#if block.detail}
        <pre>{block.detail}</pre>
      {/if}
    </div>
  {/each}
</section>
