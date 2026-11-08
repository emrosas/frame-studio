<!--
  One project in the sidebar's Footage view (ADR 0013): its name and how much
  it holds, and a + on hover. Clicking it opens the project's library, where
  its videos and scenes are picked: here for the project on screen, or by
  switching to another. A project whose folder is gone says so, with Forget.
-->
<script lang="ts">
  import type { ProjectRow } from '../project-rows';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Popover from './Popover.svelte';

  let {
    row,
    ui,
    actions,
    onnote,
    onforget,
  }: {
    row: ProjectRow;
    ui: ViewerUi;
    actions: ViewerActions;
    /** Something to say under the sidebar's head, or null to clear it. */
    onnote: (note: { text: string; error: boolean } | null) => void;
    onforget: () => void;
  } = $props();

  let adding = $state(false);
  let addBox = $state<HTMLElement | null>(null);
  let noted = false;

  // The library on screen is this project's, or the app is switching to it.
  const on = $derived(ui.switching ? ui.switching.path === row.path : row.current && ui.home);

  async function switchTo(target?: { new: 'video' | 'scene' }): Promise<void> {
    const problem = await actions.openProject(row.path, row.name, target);
    noted = problem !== null;
    onnote(problem ? { text: problem, error: true } : null);
  }

  // The row says Not found by itself, so a note about the same folder goes.
  $effect(() => {
    if (!row.missing || !noted) return;
    noted = false;
    onnote(null);
  });

  function open(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (row.current) actions.showHome(true);
    else void switchTo();
    // Hand focus back so Space and the arrow keys drive playback again.
    e.currentTarget.blur();
  }

  function add(what: 'video' | 'scene'): void {
    adding = false;
    if (row.current) ui.newRequest = what === 'video' ? { kind: 'video' } : { kind: 'scene', project: null };
    else void switchTo({ new: what });
  }
</script>

<li class="project-head" class:is-on={on} class:is-current={row.current} class:is-missing={row.missing}>
  <button type="button" class="project-row" aria-current={on ? 'page' : undefined} disabled={row.missing} title={row.missing ? `${row.path} is gone` : row.path} onclick={open}>
    <Icon name="folder" />
    <span class="name">{row.name}</span>
    {#if !row.missing && row.count > 0}<span class="count" aria-label="{row.count} videos and scenes">{row.count}</span>{/if}
  </button>
  {#if row.missing}
    <span class="project-gone">Not found</span>
    <button type="button" class="link-btn" title="Take {row.name} off this list. Nothing on disk changes." onclick={() => void actions.forgetProject(row.path).then(onforget)}>Forget</button>
  {:else}
    <div class="anchor" bind:this={addBox}>
      <button type="button" class="project-add icon-btn" aria-label="New in {row.name}" title="New in {row.name}" aria-haspopup="menu" aria-expanded={adding} onclick={() => (adding = !adding)}><Icon name="plus" /></button>
      {#if adding}
        <Popover label="New in {row.name}" role="menu" class="add-menu" anchor={addBox} onclose={() => (adding = false)}>
          <button type="button" role="menuitem" class="menu-item" onclick={() => add('video')}>New video</button>
          <button type="button" role="menuitem" class="menu-item" onclick={() => add('scene')}>New scene</button>
        </Popover>
      {/if}
    </div>
  {/if}
</li>
