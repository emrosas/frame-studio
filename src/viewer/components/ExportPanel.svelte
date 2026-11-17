<!--
  The Export panel (ADR 0008), a popover under Export in the top bar: MP4,
  GIF or HTML of the scene on screen, or of its selected range, with or
  without sound, and PNG or JPG of the frame on screen at the scene's exact
  size (ADR 0020). On a still it offers PNG, JPG and HTML, since one frame
  makes no video. The studio server encodes it in the render worker while the
  viewer keeps playing, and writes it to out/. Progress shows with Cancel;
  the finished file shows with Reveal in Finder in the app. Check video, under
  it, measures the scene first (CheckPanel.svelte).
-->
<script lang="ts">
  import { spanLabel } from '../selection';
  import type { ExportFormat, ViewerActions, ViewerUi } from '../ui.svelte';
  import CheckPanel from './CheckPanel.svelte';
  import Icon from './Icon.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const TARGETS = [
    ['mp4', 'MP4'],
    ['gif', 'GIF'],
    ['html', 'HTML'],
    ['png', 'PNG'],
    ['jpg', 'JPG'],
  ] as const;
  const STILL_TARGETS = [
    ['png', 'PNG'],
    ['jpg', 'JPG'],
    ['html', 'HTML'],
  ] as const;

  let picked = $state<ExportFormat | null>(null);
  let quality = $state(90);
  // On a still, what an image export covers (ADR 0022): this still, its carousel in order, or every still.
  let scope = $state<'still' | 'carousel' | 'all'>('still');
  const stillCount = $derived(ui.scenes.filter((s) => s.film === null && s.still).length);
  const scopeNow = $derived(scope === 'carousel' && !ui.carousel ? 'still' : scope);
  let useRange = $state(false);
  let sound = $state(true);
  // HTML leaves sound files out unless asked (ADR 0012): they make the file as big as the sound.
  let media = $state(false);
  let error = $state<string | null>(null);

  const job = $derived(ui.exporting);
  const range = $derived(ui.selection.range);
  const formats = $derived<readonly (readonly [ExportFormat, string])[]>(ui.still ? STILL_TARGETS : TARGETS);
  // What was picked, while this scene offers it; else the first: MP4, or PNG on a still.
  const target = $derived<ExportFormat>(picked !== null && formats.some(([value]) => value === picked) ? picked : formats[0][0]);
  const image = $derived(target === 'png' || target === 'jpg');
  const rangeAllowed = $derived(range !== null && target !== 'html' && !image);
  const soundAllowed = $derived(target !== 'gif' && !image);
  const mediaAllowed = $derived(target === 'html' && sound && ui.usesMedia);
  const percent = $derived(job.running && job.running.total > 0 ? Math.round((job.running.done / job.running.total) * 100) : 0);
  const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

  let panel = $state<HTMLElement | null>(null);

  /** Escape closes the panel, when nothing runs. Capture, so the viewer doesn't also clear the selection. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || job.running || !panel) return;
    e.preventDefault();
    actions.toggleExport(false);
  }

  async function start(): Promise<void> {
    const q = Math.min(100, Math.max(1, Math.round(quality) || 90));
    error = await actions.startExport(target, {
      range: useRange && rangeAllowed,
      sound: sound && soundAllowed,
      media: media && mediaAllowed,
      ...(target === 'jpg' ? { quality: q } : {}),
      ...(image && ui.still && scopeNow !== 'still' ? { stills: scopeNow } : {}),
    });
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
        <Icon name="close" />
      </button>
    </header>
    <div class="segmented" role="radiogroup" aria-label="Format">
      {#each formats as [value, label] (value)}
        <label><input type="radio" name="export-target" {value} checked={target === value} onchange={() => (picked = value)} disabled={job.running !== null} />{label}</label>
      {/each}
    </div>
    {#if image && ui.still && (ui.carousel || stillCount > 1)}
      <div class="export-scope" role="radiogroup" aria-label="What to export">
        <label class="check-row"><input type="radio" name="export-scope" value="still" checked={scopeNow === 'still'} onchange={() => (scope = 'still')} disabled={job.running !== null} />This still</label>
        {#if ui.carousel}
          <label class="check-row" title="To out/{ui.carousel.id}/, numbered in order">
            <input type="radio" name="export-scope" value="carousel" checked={scopeNow === 'carousel'} onchange={() => (scope = 'carousel')} disabled={job.running !== null} />Carousel {ui.carousel.id}, {ui.carousel.slides.length} slides
          </label>
        {/if}
        {#if stillCount > 1}
          <label class="check-row" title="Each to its own folder under out/"><input type="radio" name="export-scope" value="all" checked={scopeNow === 'all'} onchange={() => (scope = 'all')} disabled={job.running !== null} />All {stillCount} stills</label>
        {/if}
      </div>
    {/if}
    {#if image && !(ui.still && scopeNow !== 'still')}
      <p class="panel-note export-image-note">
        {ui.still ? 'The still' : `Frame ${ui.timeline?.frame ?? 0}, the one on screen`}, at {ui.header?.size ? `${ui.header.size[0]}×${ui.header.size[1]}` : 'its own size'}.
      </p>
    {/if}
    {#if image}
      {#if target === 'jpg'}
        <label class="check-row export-quality">
          Quality
          <input type="range" min="1" max="100" step="1" bind:value={quality} disabled={job.running !== null} aria-label="JPG quality" />
          <output>{quality}</output>
        </label>
      {/if}
    {:else}
      {#if !ui.still}
        <label class="check-row" class:is-disabled={!rangeAllowed}>
          <input type="checkbox" bind:checked={useRange} disabled={!rangeAllowed || job.running !== null} />
          {range && target !== 'html' ? `Only ${spanLabel(range, ui.selection.fps)}` : target === 'html' ? 'HTML is always the whole scene' : 'Only the selected range (none set)'}
        </label>
      {/if}
      <label class="check-row" class:is-disabled={!soundAllowed}>
        <input type="checkbox" bind:checked={sound} disabled={!soundAllowed || job.running !== null} />
        {soundAllowed ? 'With sound' : 'GIFs are silent'}
      </label>
    {/if}
    {#if target === 'html' && ui.usesMedia}
      <label class="check-row" class:is-disabled={!mediaAllowed}>
        <input type="checkbox" bind:checked={media} disabled={!mediaAllowed || job.running !== null} />
        Include sound files (makes the file as big as the sound)
      </label>
    {/if}
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
        {#if job.result.note}<p class="panel-note" role="status">{job.result.note}</p>{/if}
      {:else}
        <p class="export-error" role="alert">{job.result.error}</p>
      {/if}
    {/if}
    <CheckPanel {ui} {actions} />
  </div>
{/if}
