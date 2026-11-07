<!--
  The bar over the canvas: the sidebar toggle at the far left, the way back from
  an opened shot, which scene this is and a quiet line of its format, then View,
  Export and the agent panel's toggle at the far right. View holds what a person
  reaches for now and then: the safe zones on a 9:16 scene, the shortcuts and
  Settings.
  Over the library it only names the library.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import ExportPanel from './ExportPanel.svelte';
  import Icon from './Icon.svelte';
  import Popover from './Popover.svelte';
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

  let view = $state(false);
  let viewBox = $state<HTMLElement | null>(null);

  const header = $derived(ui.header);
  const seconds = $derived(header && header.fps ? header.frames / header.fps : 0);
</script>

<header class="topbar">
  <button type="button" class="icon-btn" aria-label={sidebar ? 'Hide sidebar' : 'Show sidebar'} title={sidebar ? 'Hide sidebar' : 'Show sidebar'} onclick={ontogglesidebar}><Icon name="sidebar" /></button>
  {#if !sidebar && !ui.home}
    <button type="button" class="icon-btn" aria-label="Library" title="Library" onclick={() => actions.showHome(true)}><Icon name="library" /></button>
  {/if}
  {#if ui.back && !ui.home}
    <button type="button" class="back-link" aria-label="Back to {ui.back.key}" title="Back to {ui.back.key} at the matching frame" onclick={() => actions.back()}>
      <Icon name="back" />
      {ui.back.label}
    </button>
  {/if}
  <div class="crumbs">
    {#if ui.home}
      <span class="scene">Library</span>
    {:else}
      {#if header?.project}
        <span class="project">{header.project}</span>
        <span class="sep">/</span>
      {/if}
      <span class="scene" title={header?.key ?? ''}>{header?.name ?? 'No scene'}</span>
    {/if}
  </div>
  {#if header?.size && header.fps && !ui.home}
    <span class="scene-meta">
      {header.size[0]}×{header.size[1]} · <output aria-label="Frame rate">{ui.fps} fps</output> · {Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s
    </span>
  {/if}
  <span class="spacer"></span>
  <div class="anchor" bind:this={viewBox}>
    <button
      type="button"
      class="icon-btn"
      aria-label="View"
      title="View"
      aria-expanded={view}
      onclick={(e) => {
        view = !view;
        if (view) actions.toggleExport(false);
        if (e.detail > 0) e.currentTarget.blur();
      }}><Icon name="view" /></button
    >
    {#if view}
      <Popover label="View options" class="view-menu" anchor={viewBox} onclose={() => (view = false)}>
        {#if header?.vertical && !ui.home}
          <button
            type="button"
            class="menu-item"
            class:is-on={ui.layout.safeZones}
            aria-pressed={ui.layout.safeZones}
            title="Show where TikTok, Reels and Shorts cover the frame. This never appears in exports."
            onclick={(e) => {
              ui.layout.safeZones = !ui.layout.safeZones;
              actions.syncGuides();
              e.currentTarget.blur();
            }}><Icon name="safe" />Safe zones</button
          >
        {/if}
        <Shortcuts sound={ui.sound !== null} />
        <button
          type="button"
          class="menu-item"
          onclick={() => {
            view = false;
            ui.settingsOpen = true;
          }}><Icon name="key" />Settings…</button
        >
      </Popover>
    {/if}
  </div>
  <button
    type="button"
    class="btn"
    hidden={ui.home}
    aria-expanded={ui.exporting.open}
    onclick={(e) => {
      view = false;
      actions.toggleExport();
      // After a mouse click, hand focus back so Space and the arrows drive playback; from the keyboard, keep it,
      // so Tab goes on into the panel.
      if (e.detail > 0) e.currentTarget.blur();
    }}
  >
    Export
  </button>
  <button type="button" class="icon-btn" aria-label={panel ? 'Hide agent panel' : 'Show agent panel'} title={panel ? 'Hide agent panel' : 'Show agent panel'} onclick={ontogglepanel}>
    <Icon name="panel" />
  </button>
</header>
<ExportPanel {ui} {actions} />
