<!--
  The bar over the canvas: the way back from an opened shot, which scene this
  is (in its project) and its format and frame rate (with the rate playback
  reaches while it plays), then the keyboard shortcuts, Export,
  and the buttons that show or hide the side columns.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import ExportPanel from './ExportPanel.svelte';
  import Icon from './Icon.svelte';
  import Shortcuts from './Shortcuts.svelte';

  let {
    ui,
    actions,
    sidebar,
    panel,
    ontogglesidebar,
    ontogglepanel,
  }: {
    ui: ViewerUi;
    actions: ViewerActions;
    sidebar: boolean;
    panel: boolean;
    ontogglesidebar: () => void;
    ontogglepanel: () => void;
  } = $props();

  let shortcuts = $state(false);

  const header = $derived(ui.header);
  const seconds = $derived(header && header.fps ? header.frames / header.fps : 0);
  // While playing, the rate the viewer actually draws at follows the scene's.
  const rate = $derived(ui.fps ? `${ui.fps.scene} fps${ui.fps.measured === null ? '' : ` (playing at ${ui.fps.measured.toFixed(1)})`}` : '');
</script>

<header class="topbar">
  {#if !sidebar}
    <button type="button" class="icon-btn" aria-label="Show sidebar" title="Show sidebar" onclick={ontogglesidebar}><Icon name="sidebar" /></button>
  {/if}
  {#if ui.back}
    <button type="button" class="back-link" aria-label="Back to {ui.back.key}" title="Back to {ui.back.key} at the matching frame" onclick={() => actions.back()}>
      <Icon name="back" size={14} />
      {ui.back.label}
    </button>
  {/if}
  <div class="crumbs">
    {#if header?.project}
      <span class="project">{header.project}</span>
      <span class="sep">/</span>
    {/if}
    <span class="scene" title={header?.key ?? ''}>{header?.name ?? 'No scene'}</span>
  </div>
  {#if header?.size && header.fps}
    <span class="scene-meta">
      {header.size[0]}×{header.size[1]} · <output aria-label="Frame rate">{rate}</output> · {Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s
    </span>
  {/if}
  <span class="spacer"></span>
  <button
    type="button"
    class="icon-btn"
    aria-label="Keyboard shortcuts"
    title="Keyboard shortcuts"
    aria-expanded={shortcuts}
    onclick={() => {
      shortcuts = !shortcuts;
      if (shortcuts) actions.toggleExport(false);
    }}><Icon name="keyboard" /></button
  >
  <button
    type="button"
    class="btn"
    aria-expanded={ui.exporting.open}
    onclick={(e) => {
      shortcuts = false;
      actions.toggleExport();
      // After a mouse click, hand focus back so Space and the arrows drive playback; from the keyboard, keep it,
      // so Tab goes on into the panel.
      if (e.detail > 0) e.currentTarget.blur();
    }}
  >
    <Icon name="export" size={15} />
    Export
  </button>
  <button type="button" class="icon-btn" aria-label={panel ? 'Hide agent panel' : 'Show agent panel'} title={panel ? 'Hide agent panel' : 'Show agent panel'} onclick={ontogglepanel}>
    <Icon name="panel" />
  </button>
</header>
<ExportPanel {ui} {actions} />
{#if shortcuts}
  <Shortcuts sound={ui.sound !== null} onclose={() => (shortcuts = false)} />
{/if}
