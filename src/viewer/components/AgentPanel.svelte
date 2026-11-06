<!--
  The agent panel (ADR 0003, ADR 0006), right of the canvas: the threads, then
  the thread open, or a new thread about the current selection. The new
  thread's draft lives here, so it waits while you look at a thread or hide the
  panel. The files in .frame-studio/ are the truth; this only shows them.
-->
<script lang="ts">
  import type { AgentId, TurnSettings } from '../../studio/protocol';
  import { readDraft, readPref, writeDraft, writePref } from '../prefs';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import NewThread from './NewThread.svelte';
  import ThreadList from './ThreadList.svelte';
  import ThreadView from './ThreadView.svelte';

  let { ui, actions, hidden }: { ui: ViewerUi; actions: ViewerActions; hidden: boolean } = $props();

  /** The agent you picked by hand, kept between visits. Without one, the panel goes to the integrated agent when it's ready. */
  const AGENT_KEY = 'frame-studio:agent-choice';

  /** The model and effort picked last. An id the agent doesn't offer falls back to its default. */
  const PICK_KEY = 'frame-studio:model-choice';

  function savedPick(): { model?: string; effort?: string } {
    try {
      return JSON.parse(readPref(PICK_KEY) ?? '{}') as { model?: string; effort?: string };
    } catch {
      return {};
    }
  }

  const saved = readPref(AGENT_KEY) as AgentId | null;
  let picked = $state<AgentId | null>(saved);
  // Unsent words outlive a reload and a switch to another project.
  let prompt = $state(readDraft('new'));
  let files = $state<{ file: File; url: string }[]>([]);
  let agent = $state<AgentId>(saved ?? 'external');
  // Access starts at studio tools for every new thread; it never carries over.
  let settings = $state<TurnSettings>({ access: 'studio', ...savedPick() });
  $effect(() => writePref(PICK_KEY, JSON.stringify({ model: settings.model, effort: settings.effort })));

  // One agent ready means no choice to make. Otherwise a pick stands, and without one the integrated agent goes first.
  $effect(() => {
    const ready = ui.studio.agents.filter((a) => a.ready);
    if (ready.length === 0) return;
    const pick = ready.find((a) => a.id === picked);
    agent = ready.length === 1 ? ready[0].id : (pick?.id ?? ready.find((a) => a.id !== 'external')?.id ?? 'external');
  });

  $effect(() => writeDraft('new', prompt));

  function pick(id: AgentId): void {
    picked = id;
    writePref(AGENT_KEY, id);
  }

  const open = $derived(ui.studio.open === null ? null : (ui.studio.requests.find((r) => r.id === ui.studio.open) ?? null));
</script>

<aside class="agent-panel" aria-label="Agent" {hidden}>
  <ThreadList {ui} {actions} />
  {#if open}
    <!-- Keyed, so a reply's draft, attached images or Try again never carry over to another thread. -->
    {#key open.id}
      <ThreadView {ui} {actions} thread={open} />
    {/key}
  {:else}
    <NewThread {ui} {actions} onpick={pick} bind:prompt bind:files bind:agent bind:settings />
  {/if}
</aside>
