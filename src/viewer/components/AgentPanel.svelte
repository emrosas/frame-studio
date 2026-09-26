<!--
  The agent panel (ADR 0003, ADR 0006), right of the canvas: the thread open
  in it, or a new thread about the current selection. The new thread's draft
  lives here, so it waits while you look at a thread or hide the panel. The
  files in .frame-studio/ are the truth; this only shows them.
-->
<script lang="ts">
  import type { AgentId, TurnSettings } from '../../studio/protocol';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import NewThread from './NewThread.svelte';
  import ThreadView from './ThreadView.svelte';

  let { ui, actions, hidden, onhide }: { ui: ViewerUi; actions: ViewerActions; hidden: boolean; onhide: () => void } = $props();

  const AGENT_KEY = 'frame-studio:agent';

  function savedAgent(): AgentId {
    try {
      return (localStorage.getItem(AGENT_KEY) as AgentId | null) ?? 'external';
    } catch {
      return 'external';
    }
  }

  let prompt = $state('');
  let files = $state<{ file: File; url: string }[]>([]);
  let agent = $state<AgentId>(savedAgent());
  // Access starts at studio tools for every new thread; it never carries over.
  let settings = $state<TurnSettings>({ access: 'studio' });

  const open = $derived(ui.studio.open === null ? null : (ui.studio.requests.find((r) => r.id === ui.studio.open) ?? null));
</script>

<aside class="agent-panel" aria-label="Agent" {hidden}>
  {#if open}
    <!-- Keyed, so a reply's draft, attached images or Try again never carry over to another thread. -->
    {#key open.id}
      <ThreadView {ui} {actions} thread={open} {onhide} />
    {/key}
  {:else}
    <NewThread {ui} {actions} {onhide} bind:prompt bind:files bind:agent bind:settings />
  {/if}
</aside>
