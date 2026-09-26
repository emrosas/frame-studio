<!--
  The Export panel (ADR 0008), a popover under Export in the top bar: MP4,
  GIF or HTML of the scene on screen, or of its selected range, with or
  without sound. The studio server encodes it in the render worker while the
  viewer keeps playing, and writes it to out/. Progress shows with Cancel;
  the finished file shows with Reveal in Finder in the app.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';

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

  const formats = [
    ['mp4', 'MP4'],
    ['gif', 'GIF'],
    ['html', 'HTML'],
  ] as const;

  let panel = $state<HTMLElement | null>(null);

  /** Escape closes the panel from inside it, when nothing runs. Capture, so the viewer doesn't also clear the selection. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || job.running || !panel || !panel.contains(document.activeElement)) return;
    e.preventDefault();
    actions.toggleExport(false);
  }

  async function start(): Promise<void> {
    error = await actions.startExport(target, { range: useRange && rangeAllowed, sound: sound && soundAllowed });
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if job.open}
  <!-- A region, not a dialog: it doesn't take focus from the viewer. Escape closes it when nothing runs. -->
  <div class="popover export-panel" role="region" aria-label="Export" bind:this={panel}>
    <header>
      <h2>Export</h2>
      <span class="sub">{ui.selection.sceneId ?? ''}</span>
      <button type="button" class="icon-btn is-small" aria-label="Close export" title="Close" onclick={() => actions.toggleExport(false)}>
        <Icon name="close" size={14} />
      </button>
    </header>
    <div class="segmented" role="radiogroup" aria-label="Format">
      {#each formats as [value, label] (value)}
        <label><input type="radio" name="export-target" {value} bind:group={target} disabled={job.running !== null} />{label}</label>
      {/each}
    </div>
    <label class="check-row" class:is-disabled={!rangeAllowed}>
      <input type="checkbox" bind:checked={useRange} disabled={!rangeAllowed || job.running !== null} />
      {range && target !== 'html' ? `Only frames [${range.from}, ${range.to})` : target === 'html' ? 'HTML is always the whole scene' : 'Only the selected range (none set)'}
    </label>
    <label class="check-row" class:is-disabled={!soundAllowed}>
      <input type="checkbox" bind:checked={sound} disabled={!soundAllowed || job.running !== null} />
      {soundAllowed ? 'With sound' : 'GIFs are silent'}
    </label>
    {#if job.running}
      <div class="export-progress">
        <progress max="100" value={percent} aria-label="Export progress"></progress>
      </div>
    {/if}
    <span class="export-stage" aria-live="polite">{job.running ? `${job.running.stage} ${percent}%` : ''}</span>
    <!-- One button that changes its job, so keyboard focus stays on it through the export. -->
    <button
      type="button"
      class="btn"
      class:is-primary={!job.running}
      onclick={() => (job.running ? actions.cancelExport() : start())}
      disabled={!job.running && ui.selection.sceneId === null}
    >
      {job.running ? 'Cancel' : 'Export'}
    </button>
    {#if error}<p class="export-error" role="alert">{error}</p>{/if}
    {#if job.result}
      {#if 'file' in job.result}
        <p class="export-done" role="status">
          Saved <span class="export-file" title={job.result.file}>{fileName(job.result.file)}</span>
          {#if job.canReveal}<button type="button" class="btn is-small" onclick={() => actions.revealExport()}>Reveal in Finder</button>{:else}<code>{job.result.file}</code>{/if}
        </p>
      {:else}
        <p class="export-error" role="alert">{job.result.error}</p>
      {/if}
    {/if}
  </div>
{/if}
