<!--
  The viewer's layout: the requests panel on the left, the stage (canvas and
  selection overlay, drawn by the App class in plain TypeScript) with the
  error panel over it, and the control footer under both. The App finds
  .stage and .stage-frame after this mounts.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Controls from './Controls.svelte';
  import ErrorPanel from './ErrorPanel.svelte';
  import ExportPanel from './ExportPanel.svelte';
  import SelectionBar from './SelectionBar.svelte';
  import StudioPanel from './StudioPanel.svelte';
  import Toast from './Toast.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();
</script>

<main class="viewer">
  <div class="workspace">
    <StudioPanel {ui} {actions} />
    <div class="stage">
      <!-- The canvas and the overlay share one box, so the overlay lines up with the canvas exactly. -->
      <div class="stage-frame"></div>
      <ErrorPanel errors={ui.errors} />
      <Toast toast={ui.toast} {actions} />
      <ExportPanel {ui} {actions} />
    </div>
  </div>
  <footer class="controls" class:is-playing={ui.playing}>
    <Controls {ui} {actions} />
    <SelectionBar {ui} {actions} />
  </footer>
</main>
