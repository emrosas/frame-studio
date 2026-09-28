<!--
  New scene and New project, from the sidebar's + buttons: a modal form for
  the name and the format. The studio server writes the files (agents do the
  same with create_scene and create_project), and the viewer then shows the
  new scene with a new thread open, so the next step is saying what goes in it.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { NEW_PROJECT_MAIN, toId } from '../../studio/protocol';
  import type { NewWhat, ViewerActions } from '../ui.svelte';
  import Icon from './Icon.svelte';

  let { what, actions, onclose, ondone }: { what: NewWhat; actions: ViewerActions; onclose: () => void; ondone: () => void } = $props();

  const SHAPES = [
    { label: 'Landscape', size: [1920, 1080] },
    { label: 'Portrait', size: [1080, 1920] },
    { label: 'Square', size: [1080, 1080] },
  ] as const;
  const RATES = [12, 24, 30] as const;

  let dialog = $state<HTMLDialogElement | null>(null);
  let name = $state('');
  let shape = $state(0);
  let fps = $state(24);
  // The dialog is made for one kind, so its first value is the one it keeps.
  let duration = $state(untrack(() => (what.kind === 'project' ? 10 : 5)));
  let busy = $state(false);
  let error = $state<string | null>(null);

  const project = $derived(what.kind === 'scene' ? what.project : null);
  const id = $derived(toId(name));
  const title = $derived(what.kind === 'project' ? 'New project' : project ? `New scene in ${project.name}` : 'New scene');
  const where = $derived.by(() => {
    const shown = id || '…';
    if (what.kind === 'project') return `Saved in projects/${shown}/. Its first scene is ${NEW_PROJECT_MAIN}.`;
    return project ? `Saved as projects/${project.id}/${shown}.json` : `Saved as scenes/${shown}.json`;
  });

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
    const size: [number, number] = [SHAPES[shape].size[0], SHAPES[shape].size[1]];
    const problem =
      what.kind === 'project'
        ? await actions.createProject({ id, name: name.trim(), fps, size, duration })
        : await actions.createScene(project ? { id, project: project.id, duration } : { id, fps, size, duration });
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
      <button type="button" class="icon-btn is-small" aria-label="Close" title="Close" onclick={() => dialog?.close()}><Icon name="close" size={14} /></button>
    </header>

    <label class="field">
      <span class="field-label">Name</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" bind:value={name} placeholder={what.kind === 'project' ? 'Bears’ story' : 'opening-shot'} maxlength="100" autocomplete="off" spellcheck="false" autofocus required />
      <span class="field-hint">{where}</span>
    </label>

    {#if project}
      <p class="field-hint">
        {project.size ? `${project.size[0]}×${project.size[1]}` : '?'} · {project.fps ?? '?'} fps, like every scene in the project
      </p>
    {:else}
      <div class="field">
        <span class="field-label" id="new-shape">Size</span>
        <div class="segmented" role="radiogroup" aria-labelledby="new-shape">
          {#each SHAPES as s, i (s.label)}
            <label title="{s.size[0]}×{s.size[1]}"><input type="radio" name="new-shape" value={i} bind:group={shape} />{s.label}</label>
          {/each}
        </div>
        <span class="field-hint">{SHAPES[shape].size[0]}×{SHAPES[shape].size[1]}</span>
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

    <label class="field">
      <span class="field-label">{what.kind === 'project' ? 'Length of the main scene' : 'Length'}</span>
      <span class="field-row"><input type="number" bind:value={duration} min="0.5" max="3600" step="0.5" required /> seconds</span>
    </label>

    {#if error}<p class="new-error" role="alert">{error}</p>{/if}

    <footer>
      <button type="button" class="btn is-ghost" onclick={() => dialog?.close()}>Cancel</button>
      <!-- aria-disabled, not disabled, so focus stays on it and in the dialog while it works. -->
      <button type="submit" class="btn is-primary" aria-disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
    </footer>
  </form>
</dialog>
