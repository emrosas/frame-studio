<!--
  New video and New scene: a modal form for the name and the format, picked
  from cards, with Custom for anything else. It starts at project.json's format
  where that has one. A pixel short also picks a look, which the server writes
  into the scene's `pixel` field. A new video starts with an empty scene on its
  track unless you untick that, since a pixel stage lives on a scene and an
  empty composition gives you nothing to point at. The studio server writes the
  files (agents do the same with create_scene and create_composition), and the
  viewer then shows the new one with a new thread open, so the next step is
  saying what goes in it.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { DEFAULT_FORMAT, toId, type NewPixel } from '../../studio/protocol';
  import { FORMATS, LOOKS, PIXEL_DITHER } from '../formats';
  import type { NewWhat, ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';

  let { what, ui, actions, onclose, ondone }: { what: NewWhat; ui: ViewerUi; actions: ViewerActions; onclose: () => void; ondone: () => void } = $props();

  const BASE_RATES = [12, 24, 30] as const;

  // The dialog is made for one kind, so what it starts from stays.
  const start = untrack(() => ({
    fps: ui.format.fps ?? DEFAULT_FORMAT.fps,
    size: ui.format.size ?? DEFAULT_FORMAT.size,
    video: what.kind === 'video',
  }));
  const RATES: readonly number[] = BASE_RATES.includes(start.fps as 12) ? BASE_RATES : [start.fps, ...BASE_RATES];
  const matching = FORMATS.find((f) => f.pixelScale === undefined && f.size[0] === start.size[0] && f.size[1] === start.size[1] && f.fps === start.fps);

  let dialog = $state<HTMLDialogElement | null>(null);
  let name = $state('');
  let format = $state(matching?.id ?? 'custom');
  let width = $state(start.size[0]);
  let height = $state(start.size[1]);
  let fps = $state(start.fps);
  let look = $state(LOOKS[0].id);
  let duration = $state<number>(start.video ? (matching?.duration ?? 10) : 5);
  let firstScene = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const project = $derived(what.kind === 'scene' ? what.project : null);
  const preset = $derived(FORMATS.find((f) => f.id === format) ?? null);
  const pixel = $derived(preset?.pixelScale !== undefined);
  const id = $derived(toId(name));
  const title = $derived(what.kind === 'video' ? 'New video' : project ? `New scene in ${project.name}` : 'New scene');
  const where = $derived.by(() => {
    const shown = id || '…';
    if (what.kind === 'video') return firstScene || pixel ? `Saved as compositions/${shown}.json, with scenes/${shown}-1.json on its track.` : `Saved as compositions/${shown}.json, with one empty track.`;
    return project ? `Saved as projects/${project.id}/${shown}.json` : `Saved as scenes/${shown}.json`;
  });

  function choose(next: string): void {
    format = next;
    const chosen = FORMATS.find((f) => f.id === next);
    if (chosen) duration = chosen.duration;
  }

  /** The shape a format card shows, at most 28 px on its long side. */
  function shape(w: number, h: number): string {
    const scale = 28 / Math.max(w, h);
    return `width: ${Math.round(w * scale)}px; height: ${Math.round(h * scale)}px`;
  }

  onMount(() => dialog?.showModal());

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!id) {
      error = 'The name needs at least one letter or digit.';
      return;
    }
    busy = true;
    error = null;
    const size: [number, number] = preset ? [preset.size[0], preset.size[1]] : [width, height];
    const rate = preset?.fps ?? fps;
    const stage: NewPixel | undefined = preset?.pixelScale ? { scale: preset.pixelScale, palette: [...(LOOKS.find((l) => l.id === look) ?? LOOKS[0]).palette], dither: PIXEL_DITHER } : undefined;
    const problem =
      what.kind === 'video'
        ? await actions.createVideo({ id, fps: rate, size, duration, ...(stage ? { pixel: stage } : firstScene ? {} : { scene: false }) })
        : await actions.createScene(project ? { id, project: project.id, duration } : { id, fps: rate, size, duration, ...(stage ? { pixel: stage } : {}) });
    busy = false;
    if (problem) error = problem;
    else {
      dialog?.close();
      ondone();
    }
  }
</script>

<!-- Keys typed here stay here, so Space and Escape don't also drive the viewer. -->
<dialog class="new-dialog" aria-labelledby="new-dialog-title" bind:this={dialog} onclose={onclose} onkeydown={(e) => e.stopPropagation()}>
  <form method="dialog" onsubmit={submit}>
    <header>
      <h2 id="new-dialog-title">{title}</h2>
      <button type="button" class="icon-btn is-small" aria-label="Close" title="Close" onclick={() => dialog?.close()}><Icon name="close" /></button>
    </header>

    <label class="field">
      <span class="field-label">Name</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" bind:value={name} placeholder={what.kind === 'video' ? 'why-bread-rises' : 'opening-shot'} maxlength="100" autocomplete="off" spellcheck="false" autofocus required />
      <span class="field-hint">{where}</span>
    </label>

    {#if project}
      <p class="field-hint">
        {project.size ? `${project.size[0]}×${project.size[1]}` : '?'} · {project.fps ?? '?'} fps, like every scene in the project
      </p>
    {:else}
      <div class="field">
        <span class="field-label" id="new-format">Format</span>
        <div class="format-cards" role="radiogroup" aria-labelledby="new-format">
          {#each FORMATS as f (f.id)}
            <label class="format-card" class:is-on={format === f.id} title="{f.size[0]}×{f.size[1]} at {f.fps} fps">
              <input type="radio" name="new-format" value={f.id} checked={format === f.id} onchange={() => choose(f.id)} />
              <span class="format-shape" class:is-pixel={f.pixelScale !== undefined} style={shape(f.size[0], f.size[1])}></span>
              <span class="format-name">{f.label}</span>
              <span class="format-hint">{f.hint}</span>
            </label>
          {/each}
          <label class="format-card" class:is-on={format === 'custom'}>
            <input type="radio" name="new-format" value="custom" checked={format === 'custom'} onchange={() => choose('custom')} />
            <span class="format-shape is-custom" style={shape(width > 0 ? width : 16, height > 0 ? height : 9)}></span>
            <span class="format-name">Custom</span>
            <span class="format-hint">Any size</span>
          </label>
        </div>
      </div>

      {#if pixel}
        <div class="field">
          <span class="field-label" id="new-look">Look</span>
          <div class="look-cards" role="radiogroup" aria-labelledby="new-look">
            {#each LOOKS as l (l.id)}
              <label class="look-card" class:is-on={look === l.id}>
                <input type="radio" name="new-look" value={l.id} bind:group={look} />
                <span class="look-swatches" aria-hidden="true">
                  {#each l.palette as colour (colour)}<span style="background: {colour}"></span>{/each}
                </span>
                <span class="format-name">{l.name}</span>
              </label>
            {/each}
          </div>
          <span class="field-hint">Sixteen colours with ordered dither. Agents draw on a 180×320 stage.</span>
        </div>
      {/if}

      {#if format === 'custom'}
        <div class="field">
          <span class="field-label">Size</span>
          <span class="field-row">
            <input type="number" aria-label="Width" bind:value={width} min="16" max="8192" step="1" required />
            ×
            <input type="number" aria-label="Height" bind:value={height} min="16" max="8192" step="1" required />
          </span>
        </div>
        <div class="field">
          <span class="field-label" id="new-fps">Frame rate</span>
          <div class="segmented" role="radiogroup" aria-labelledby="new-fps">
            {#each RATES as rate (rate)}
              <label><input type="radio" name="new-fps" value={rate} bind:group={fps} />{rate} fps</label>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    <label class="field">
      <span class="field-label">Length</span>
      <span class="field-row"><input type="number" bind:value={duration} min="0.5" max="3600" step="0.5" required /> seconds</span>
    </label>

    {#if what.kind === 'video' && !pixel}
      <label class="field-check"><input type="checkbox" bind:checked={firstScene} /> Start with an empty scene</label>
    {/if}

    {#if error}<p class="new-error" role="alert">{error}</p>{/if}

    <footer>
      <button type="button" class="btn is-ghost" onclick={() => dialog?.close()}>Cancel</button>
      <!-- aria-disabled, not disabled, so focus stays on it and in the dialog while it works. -->
      <button type="submit" class="btn is-primary" aria-disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
    </footer>
  </form>
</dialog>
