<!--
  The requests panel (ADR 0003, ADR 0006), on the left of the canvas. Start a
  request about the current selection and pick who works it: an agent the
  studio runs, or an external agent over MCP. Below, every request as a
  thread; open one to follow it, reply and settle it. The files in
  .frame-studio/ are the truth; this only shows them.
-->
<script lang="ts">
  import { currentTurn, describeTarget, displayStatus, type AgentId, type StudioRequest, type TurnSettings } from '../../studio/protocol';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import AgentPicker from './AgentPicker.svelte';
  import PromptBox from './PromptBox.svelte';
  import ThreadView from './ThreadView.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const LABELS: Record<string, string> = {
    pending: 'waiting',
    working: 'working',
    stalled: 'stalled',
    your_turn: 'your turn',
    settled: 'settled',
    cancelled: 'cancelled',
  };
  const AGENT_KEY = 'frame-studio:agent';

  let prompt = $state('');
  let files = $state<{ file: File; url: string }[]>([]);
  let sending = $state(false);
  let status = $state<{ text: string; error: boolean } | null>(null);
  let agent = $state<AgentId>(savedAgent());
  // Access starts at studio tools for every new request; it never carries over.
  let settings = $state<TurnSettings>({ access: 'studio' });

  function savedAgent(): AgentId {
    try {
      return (localStorage.getItem(AGENT_KEY) as AgentId | null) ?? 'external';
    } catch {
      return 'external';
    }
  }

  // An agent the server no longer offers (the test agent, say) falls back to the external agent.
  $effect(() => {
    if (ui.studio.agents.length > 0 && !ui.studio.agents.some((a) => a.id === agent)) agent = 'external';
  });

  const sel = $derived(ui.selection);
  const target = $derived.by(() => {
    if (!sel.sceneId) return 'No valid scene';
    const what = sel.layer === '' ? (sel.range ? 'all layers' : 'the whole scene') : sel.layer;
    return `${sel.sceneId} · ${what}${sel.range ? ` · ${sel.rangeText?.interval ?? ''}` : ''}`;
  });
  const agentStatus = $derived(ui.studio.agents.find((a) => a.id === agent));
  const ready = $derived(agent === 'external' || (agentStatus?.ready ?? false));
  const threads = $derived([...ui.studio.requests].reverse());
  const open = $derived(ui.studio.open === null ? null : (ui.studio.requests.find((r) => r.id === ui.studio.open) ?? null));
  const waiting = $derived(ui.studio.requests.filter((r) => r.status === 'pending').length);
  const yours = $derived(ui.studio.requests.filter((r) => r.status === 'your_turn').length);
  const finished = $derived(ui.studio.requests.filter((r) => r.status === 'settled' || r.status === 'cancelled').length);

  const agentLabel = (id: AgentId) => ui.studio.agents.find((a) => a.id === id)?.label ?? id;

  function describe(r: StudioRequest): string {
    const s = currentTurn(r).ask.selection;
    const turns = r.turns.length > 1 ? ` · ${r.turns.length} turns` : '';
    return `${s.sceneId} · ${describeTarget(s)} · [${s.from}, ${s.to})${turns}`;
  }

  /** The newest thing the agent said about the thread. */
  function lastSummary(r: StudioRequest): string | undefined {
    for (let k = r.turns.length - 1; k >= 0; k--) if (r.turns[k].summary) return r.turns[k].summary;
    return undefined;
  }

  async function send(): Promise<void> {
    if (!prompt.trim() || sending || !ready) return;
    sending = true;
    status = null;
    const result = await actions.sendRequest(prompt, files.map((f) => f.file), agent, agent === 'external' ? undefined : $state.snapshot(settings));
    sending = false;
    if (!result.ok) {
      status = { text: result.error, error: true };
      return;
    }
    try {
      localStorage.setItem(AGENT_KEY, agent);
    } catch {
      // storage unavailable; the picker starts on the external agent next time
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

<aside class="studio-panel" aria-label="Requests">
  {#if !ui.studio.available}
    <header class="studio-head"><h2>Requests</h2></header>
    <p class="studio-note">Sending requests needs the studio server, which runs with <code>npm run dev</code>.</p>
  {:else if open}
    <!-- Keyed, so a draft, attached images or Try again never carry over to another thread. -->
    {#key open.id}
      <ThreadView {ui} {actions} thread={open} />
    {/key}
  {:else}
    <header class="studio-head">
      <h2>Requests</h2>
      {#if yours > 0}<span class="studio-count">{yours} your turn</span>{/if}
      {#if waiting > 0}<span class="studio-count is-quiet">{waiting} waiting</span>{/if}
    </header>
    <section class="composer" aria-label="New request">
      <div class="composer-target" title="What the request is about">{target}</div>
      <PromptBox
        bind:value={prompt}
        bind:files
        label="Prompt"
        placeholder="What should change? e.g. make pip look sad here"
        onsubmit={send}
        onproblem={(text) => (status = { text, error: true })}
      />
      <AgentPicker agents={ui.studio.agents} bind:agent bind:settings onrefresh={() => actions.refreshAgents()} />
      <div class="composer-row">
        <span></span>
        <button type="button" class="send" disabled={!prompt.trim() || sending || !sel.sceneId || !ready} onclick={send}>
          {sending ? 'Sending…' : 'Send to agent'}
        </button>
      </div>
      {#if status}<p class="composer-status" class:is-error={status.error} role="status">{status.text}</p>{/if}
    </section>

    <section class="queue" aria-label="Request queue">
      {#if ui.studio.error}<p class="studio-note is-error">{ui.studio.error}</p>{/if}
      {#if threads.length === 0}
        <p class="studio-note">Requests you send show up here as threads: follow the agent's work, reply, and settle each when it's right.</p>
      {/if}
      {#each threads as r (r.id)}
        {@const shown = displayStatus(r, ui.studio.now)}
        {@const summary = lastSummary(r)}
        <article class="request is-{shown}" aria-label="Request {r.id}">
          <button type="button" class="request-main" title="Open this request" onclick={() => actions.openThread(r.id)}>
            <span class="request-top">
              <span class="request-id">#{r.id} · {agentLabel(r.agent)}</span>
              <span class="request-status">{LABELS[shown]}</span>
            </span>
            <span class="request-prompt">{r.turns[0].ask.prompt}</span>
            <span class="request-meta">{describe(r)}</span>
            {#if summary}<span class="request-summary">{summary}</span>{/if}
          </button>
        </article>
      {/each}
      {#if finished > 0}
        <button type="button" class="clear-finished" onclick={() => actions.clearFinished()}>Clear settled</button>
      {/if}
    </section>
  {/if}
</aside>
