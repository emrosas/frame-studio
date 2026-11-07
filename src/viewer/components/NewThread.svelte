<!--
  A new thread: one quiet line and the composer. For the external agent, sending
  queues the request and copies a line to paste into it; for an agent the
  studio runs, the thread opens. The draft belongs to the agent panel, which
  keeps it while this is away.
-->
<script lang="ts">
  import type { AgentId, TurnSettings } from '../../studio/protocol';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Composer from './Composer.svelte';
  import SelectionToken from './SelectionToken.svelte';

  let {
    ui,
    actions,
    onpick,
    prompt = $bindable(),
    files = $bindable(),
    agent = $bindable(),
    settings = $bindable(),
  }: {
    ui: ViewerUi;
    actions: ViewerActions;
    onpick: (id: AgentId) => void;
    prompt: string;
    files: { file: File; url: string }[];
    agent: AgentId;
    settings: TurnSettings;
  } = $props();

  let sending = $state(false);
  let status = $state<{ text: string; error: boolean } | null>(null);

  // An agent the server no longer offers (the test agent, say) falls back to the external agent.
  $effect(() => {
    if (ui.studio.agents.length > 0 && !ui.studio.agents.some((a) => a.id === agent)) agent = 'external';
  });

  const sel = $derived(ui.selection);
  const empty = $derived(ui.header?.empty ?? false);
  const what = $derived(ui.header?.video ? 'video' : 'scene');
  // Nothing on this scene yet says so, once; with threads listed above, the composer asks.
  const quiet = $derived(!ui.studio.requests.some((r) => r.sceneId === ui.selectedScene));
  const line = $derived(ui.home ? 'Pick something to work on' : empty ? `What goes in this ${what}?` : quiet ? 'No threads on this scene yet' : null);
  const hint = $derived(!ui.home && !empty && quiet ? 'Click a layer, then ask' : null);
  const placeholder = $derived.by(() => {
    if (ui.home) return 'What should change?';
    if (empty) return `Describe what happens in this ${what}…`;
    if (sel.layer !== '') return `Change ${sel.layer}…`;
    return sel.range ? 'What should change in these seconds?' : 'What should change?';
  });
  const agentStatus = $derived(ui.studio.agents.find((a) => a.id === agent));
  const ready = $derived(agent === 'external' || (agentStatus?.ready ?? false));

  async function send(): Promise<void> {
    if (!prompt.trim() || sending || !ready || ui.home) return;
    sending = true;
    status = null;
    const result = await actions.sendRequest(prompt, files.map((f) => f.file), agent, agent === 'external' ? undefined : $state.snapshot(settings));
    sending = false;
    if (!result.ok) {
      status = { text: result.error, error: true };
      return;
    }
    for (const f of files) URL.revokeObjectURL(f.url);
    files = [];
    prompt = '';
    settings = { access: 'studio', ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) };
    if (agent === 'external') {
      status = {
        text: result.copied
          ? `Request #${result.id} queued. A line to paste into your agent is on the clipboard; in Claude Code, /frame-studio:next also works.`
          : `Request #${result.id} queued. In Claude Code run /frame-studio:next, or ask your agent to take the next Frame Studio request.`,
        error: false,
      };
    } else {
      actions.openThread(result.id);
    }
  }
</script>

{#snippet target()}
  {#if ui.home}
    <span class="token is-quiet">Open a video or scene first</span>
  {:else if !sel.sceneId}
    <span class="token is-quiet">No valid scene</span>
  {:else}
    <SelectionToken {ui} {actions} />
  {/if}
{/snippet}

<div class="panel-body is-empty">
  {#if line}
    <div class="intro">
      <h2>{line}</h2>
      {#if hint}<p>{hint}</p>{/if}
    </div>
  {/if}
</div>

<footer class="panel-foot">
  {#if ui.studio.error}<p class="panel-note is-error">{ui.studio.error}</p>{/if}
  {#if ui.studio.agentsOff}<p class="panel-note" role="status">{ui.studio.agentsOff}</p>{/if}
  {#if status}<p class="composer-status" class:is-error={status.error} role="status">{status.text}</p>{/if}
  <Composer
    bind:value={prompt}
    bind:files
    bind:agent
    bind:settings
    agents={ui.studio.agents}
    layers={ui.layers}
    onmention={(id) => actions.selectLayer(id)}
    label="Prompt"
    {placeholder}
    {target}
    sendLabel="Send to agent"
    canSend={prompt.trim() !== '' && !sending && sel.sceneId !== null && ready && !ui.home}
    onsubmit={send}
    onproblem={(text) => (status = { text, error: true })}
    onrefresh={() => actions.refreshAgents()}
    {onpick}
  />
</footer>
