<!--
  The viewer's layout, in three columns: the sidebar (folder, scenes,
  threads), the canvas with its top bar and timeline, and the agent panel.
  The stage (canvas and selection overlay, drawn by the App class in plain
  TypeScript) has the error panel and the finished-thread toast over it. The
  App finds .stage and .stage-frame after this mounts, so they are never
  inside an {#if}. Which side columns show is ui.layout, kept in
  localStorage.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { LAYOUT_KEY, type ViewerActions, type ViewerUi } from '../ui.svelte';
  import AgentPanel from './AgentPanel.svelte';
  import Controls from './Controls.svelte';
  import ErrorPanel from './ErrorPanel.svelte';
  import SelectionBar from './SelectionBar.svelte';
  import Sidebar from './Sidebar.svelte';
  import Toast from './Toast.svelte';
  import Topbar from './Topbar.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  $effect(() => {
    const value = JSON.stringify(ui.layout);
    try {
      localStorage.setItem(LAYOUT_KEY, value);
    } catch {
      // storage unavailable; the layout resets next time
    }
  });

  // Opening a thread from the sidebar or a notice shows the panel it opens in.
  $effect(() => {
    if (ui.studio.open !== null) untrack(() => (ui.layout.panel = true));
  });

  // Sound files dropped anywhere but the composer (which takes reference images) import into media/ (ADR 0012).
  const SOUND = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
  const sounds = (files: FileList | undefined | null) => [...(files ?? [])].filter((f) => f.type.startsWith('audio/') || SOUND.test(f.name));
  let dropping = $state(false);
  async function dropSounds(e: DragEvent): Promise<void> {
    dropping = false;
    if (e.defaultPrevented) return;
    const files = sounds(e.dataTransfer?.files);
    if (files.length === 0) return;
    e.preventDefault();
    ui.mediaNote = { text: `Importing ${files.length === 1 ? files[0].name : `${files.length} files`}…`, error: false };
    const problem = await actions.importMedia(files);
    ui.mediaNote = problem ? { text: problem, error: true } : { text: `Imported ${files.length === 1 ? files[0].name : `${files.length} files`}.`, error: false };
    ui.layout.sidebar = true;
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
  <Sidebar {ui} {actions} hidden={!ui.layout.sidebar} onhide={toggleSidebar} onthread={showPanel} />
  <section class="main" aria-label="Canvas">
    <Topbar {ui} {actions} sidebar={ui.layout.sidebar} panel={ui.layout.panel} ontogglesidebar={toggleSidebar} ontogglepanel={togglePanel} />
    <div class="stage">
      <!-- The canvas and the overlay share one box, so the overlay lines up with the canvas exactly. -->
      <div class="stage-frame"></div>
      <ErrorPanel errors={ui.errors} />
      <Toast toast={ui.toast} {actions} onview={showPanel} />
    </div>
    <footer class="timeline">
      <Controls {ui} {actions} />
      <SelectionBar {ui} {actions} />
    </footer>
  </section>
  <AgentPanel {ui} {actions} hidden={!ui.layout.panel} onhide={togglePanel} />
</main>
