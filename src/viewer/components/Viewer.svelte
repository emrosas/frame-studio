<!--
  The viewer's layout, in three columns: the sidebar (project, videos,
  scenes), the canvas with its top bar and timeline dock, and the agent panel
  (threads). The stage (canvas and selection overlay, drawn by the App class in
  plain TypeScript) has the error panel and the finished-thread toast over it.
  The library covers the stage, with it still in place under it, and the dock
  too unless it's over the scene you came from: then the dock stays in view, so
  a Library item can be dragged onto the timeline.
  The App finds .stage and .stage-frame after this mounts, so they are never
  inside an {#if}. Which side columns show and the dock's height are ui.layout,
  kept with the viewer's prefs.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { mediaFiles } from '../drop';
  import { writePref } from '../prefs';
  import { LAYOUT_KEY, type ViewerActions, type ViewerUi } from '../ui.svelte';
  import AgentPanel from './AgentPanel.svelte';
  import Controls from './Controls.svelte';
  import ErrorPanel from './ErrorPanel.svelte';
  import Library from './Library.svelte';
  import NewDialog from './NewDialog.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import VoiceSheet from './VoiceSheet.svelte';
  import SelectionBar from './SelectionBar.svelte';
  import Sidebar from './Sidebar.svelte';
  import StackMenu from './StackMenu.svelte';
  import Timeline from './Timeline.svelte';
  import Toast from './Toast.svelte';
  import Topbar from './Topbar.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  $effect(() => {
    writePref(LAYOUT_KEY, JSON.stringify(ui.layout));
  });

  // Opening a thread from the sidebar or a notice shows the panel it opens in.
  $effect(() => {
    if (ui.studio.open !== null) untrack(() => (ui.layout.panel = true));
  });

  // Sound, video and image files dropped anywhere but the composer (which takes reference images) or the timeline (which places them too) import into media/ (ADR 0012, 0014).
  let dropping = $state(false);
  async function dropSounds(e: DragEvent): Promise<void> {
    dropping = false;
    if (e.defaultPrevented) return;
    const files = mediaFiles(e.dataTransfer?.files);
    if (files.length === 0) return;
    e.preventDefault();
    ui.mediaNote = { text: `Importing ${files.length === 1 ? files[0].name : `${files.length} files`}…`, error: false };
    const problem = await actions.importMedia(files);
    ui.mediaNote = problem ? { text: problem, error: true } : { text: `Imported ${files.length === 1 ? files[0].name : `${files.length} files`}.`, error: false };
    actions.showHome(true);
  }

  // The dock's height: dragged by its top edge, or the arrow keys there. It starts fitting what's on the timeline.
  const DOCK_MIN = 92;
  const dockMax = () => Math.round(window.innerHeight * 0.55);
  let dock = $state<HTMLElement | null>(null);
  let dockHeight = $state(0);
  const setDock = (height: number) => (ui.layout.dock = Math.max(DOCK_MIN, Math.min(dockMax(), Math.round(height))));
  function startDockDrag(e: PointerEvent): void {
    if (e.button !== 0 || !dock) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    const startHeight = dock.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDock(startHeight + startY - ev.clientY);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  function dockKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setDock((dock?.getBoundingClientRect().height ?? DOCK_MIN) + (e.key === 'ArrowUp' ? 16 : -16));
  }

  const showPanel = () => (ui.layout.panel = true);
  const toggleSidebar = () => (ui.layout.sidebar = !ui.layout.sidebar);
  const togglePanel = () => (ui.layout.panel = !ui.layout.panel);
</script>

<svelte:window
  ondragover={(e) => {
    if (e.defaultPrevented || ![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    dropping = true;
  }}
  ondragleave={(e) => {
    if (e.relatedTarget === null) dropping = false;
  }}
  ondrop={dropSounds}
/>

<main class="viewer" class:has-sidebar={ui.layout.sidebar} class:has-panel={ui.layout.panel} class:is-dropping={dropping}>
  <!-- Both side columns stay mounted when hidden, so a draft, a scroll position or a folded project survives. -->
  <Sidebar {ui} {actions} hidden={!ui.layout.sidebar} />
  <!-- Over the scene you came from, the library leaves the dock in view, so Library items can be dragged onto the timeline. -->
  <section class="main" class:is-docked={ui.libraryOverScene} aria-label="Canvas" style="--dock-h: {dockHeight}px">
    <Topbar {ui} {actions} sidebar={ui.layout.sidebar} panel={ui.layout.panel} ontogglesidebar={toggleSidebar} ontogglepanel={togglePanel} />
    <div class="stage-area">
      <div class="stage" inert={ui.home}>
        <!-- The canvas and the overlay share one box, so the overlay lines up with the canvas exactly. -->
        <div class="stage-frame"></div>
      </div>
      {#if ui.switching}
        <div class="stage-switching" role="status">Opening {ui.switching.name}</div>
      {/if}
      <ErrorPanel errors={ui.errors} />
      <Toast toast={ui.toast} {actions} onview={showPanel} />
    </div>
    <footer class="dock" class:is-sized={ui.layout.dock !== null} bind:this={dock} bind:clientHeight={dockHeight} inert={ui.home && !ui.libraryOverScene} style={ui.layout.dock === null ? '' : `height: ${ui.layout.dock}px`}>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="dock-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Timeline height"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={720}
        aria-valuenow={ui.layout.dock ?? DOCK_MIN}
        tabindex="0"
        title="Drag to resize, double-click to fit"
        onpointerdown={startDockDrag}
        ondblclick={() => (ui.layout.dock = null)}
        onkeydown={dockKey}
      ></div>
      <div class="dock-bar">
        <Controls {ui} {actions} />
        <SelectionBar {ui} {actions} />
      </div>
      <Timeline {ui} {actions} />
    </footer>
    {#if ui.home && !ui.switching}<Library {ui} {actions} />{/if}
  </section>
  <AgentPanel {ui} {actions} hidden={!ui.layout.panel} />
</main>
{#if ui.stackMenu}
  <StackMenu {ui} {actions} menu={ui.stackMenu} />
{/if}
{#if ui.voiceOpen}
  <VoiceSheet {ui} {actions} onclose={() => (ui.voiceOpen = false)} />
{/if}
{#if ui.settingsOpen}
  <SettingsDialog onclose={() => (ui.settingsOpen = false)} />
{/if}
{#if ui.newRequest}
  <NewDialog
    what={ui.newRequest}
    {ui}
    {actions}
    onclose={() => (ui.newRequest = null)}
    ondone={() => {
      actions.openThread(null);
      showPanel();
    }}
  />
{/if}
