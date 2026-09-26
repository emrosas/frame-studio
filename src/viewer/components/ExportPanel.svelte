<!--
  The Export panel (ADR 0008): MP4, GIF or HTML of the scene on screen, or of
  its selected range, with or without sound. The studio server encodes it in
  the render worker while the viewer keeps playing, and writes it to out/.
  Progress shows with Cancel; the finished file shows with Reveal in Finder in
  the app.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  let target = $state<'mp4' | 'gif' | 'html'>('mp4');
  let useRange = $state(false);
  let sound = $state(true);
  let error = $state<string | null>(null);

  const job = $derived(ui.exporting);
  const range = $derived(ui.selection.range);
  const rangeAllowed = $derived(range !== null && target !== 'html');
  const soundAllowed = $derived(target !== 'gif');
  const percent = $derived(job.running && job.running.total > 0 ? Math.round((job.running.done / job.running.total) * 100) : 0);
  const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

  let panel = $state<HTMLElement | null>(null);

  /** Escape closes the panel from inside it, when nothing runs. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || job.running || !panel || !panel.contains(document.activeElement)) return;
    e.stopPropagation();
    actions.toggleExport(false);
  }

  async function start(): Promise<void> {
    error = await actions.startExport(target, { range: useRange && rangeAllowed, sound: sound && soundAllowed });
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if job.open}
  <!-- A region, not a dialog: it doesn't take focus from the viewer. Escape closes it when nothing runs. -->
  <div class="export-panel" role="region" aria-label="Export" bind:this={panel}>
    <header>
      <span class="label">Export {ui.selection.sceneId ?? ''}</span>
      <button type="button" class="sel-clear" aria-label="Close export" title="Close" onclick={() => actions.toggleExport(false)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2z" /></svg>
      </button>
    </header>
    <div class="export-row" role="radiogroup" aria-label="Format">
      {#each [['mp4', 'MP4'], ['gif', 'GIF'], ['html', 'HTML']] as [value, label] (value)}
        <label class="export-choice"><input type="radio" name="export-target" {value} bind:group={target} disabled={job.running !== null} /> {label}</label>
      {/each}
    </div>
    <label class="export-choice" class:is-disabled={!rangeAllowed}>
      <input type="checkbox" bind:checked={useRange} disabled={!rangeAllowed || job.running !== null} />
      {range && target !== 'html' ? `Only frames [${range.from}, ${range.to})` : target === 'html' ? 'HTML is always the whole scene' : 'Only the selected range (none set)'}
    </label>
    <label class="export-choice" class:is-disabled={!soundAllowed}>
      <input type="checkbox" bind:checked={sound} disabled={!soundAllowed || job.running !== null} />
      {soundAllowed ? 'With sound' : 'GIFs are silent'}
    </label>
    {#if job.running}
      <progress max="100" value={percent} aria-label="Export progress"></progress>
    {/if}
    <div class="export-row">
      <!-- One button that changes its job, so keyboard focus stays on it through the export. -->
      <button
        type="button"
        class="export-go"
        onclick={() => (job.running ? actions.cancelExport() : start())}
        disabled={!job.running && ui.selection.sceneId === null}
      >
        {job.running ? 'Cancel' : 'Export'}
      </button>
      <span class="export-stage" aria-live="polite">{job.running ? `${job.running.stage} ${percent}%` : ''}</span>
    </div>
    {#if error}<p class="export-error" role="alert">{error}</p>{/if}
    {#if job.result}
      {#if 'file' in job.result}
        <p class="export-done" role="status">
          Saved <span class="export-file" title={job.result.file}>{fileName(job.result.file)}</span>
          {#if job.canReveal}<button type="button" onclick={() => actions.revealExport()}>Reveal in Finder</button>{:else}<code>{job.result.file}</code>{/if}
        </p>
      {:else}
        <p class="export-error" role="alert">{job.result.error}</p>
      {/if}
    {/if}
  </div>
{/if}
