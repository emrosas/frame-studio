<!--
  A new thread: how the studio is used (point at the canvas, pick frames,
  say what should change), each step ticked as the selection fills in, and
  the composer. For the external agent, sending queues the request and copies
  a line to paste into it; for an agent the studio runs, the thread opens.
  The draft belongs to the agent panel, which keeps it while this is away.
-->
<script lang="ts">
  import type { AgentId, TurnSettings } from '../../studio/protocol';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Composer from './Composer.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';

  let {
    ui,
    actions,
    onhide,
    prompt = $bindable(),
    files = $bindable(),
    agent = $bindable(),
    settings = $bindable(),
  }: {
    ui: ViewerUi;
    actions: ViewerActions;
    onhide: () => void;
    prompt: string;
    files: { file: File; url: string }[];
    agent: AgentId;
    settings: TurnSettings;
  } = $props();

  const AGENT_KEY = 'frame-studio:agent';

  let sending = $state(false);
  let status = $state<{ text: string; error: boolean } | null>(null);

  // An agent the server no longer offers (the test agent, say) falls back to the external agent.
  $effect(() => {
    if (ui.studio.agents.length > 0 && !ui.studio.agents.some((a) => a.id === agent)) agent = 'external';
  });

  const sel = $derived(ui.selection);
  const target = $derived.by(() => {
    if (!sel.sceneId) return 'No valid scene';
    const what = sel.layer === '' ? (sel.range ? 'All layers' : 'The whole scene') : sel.layer;
    return `${what}${sel.range ? ` · ${sel.rangeText?.interval ?? ''}` : ''} · ${sel.sceneId}`;
  });
  const agentStatus = $derived(ui.studio.agents.find((a) => a.id === agent));
  const ready = $derived(agent === 'external' || (agentStatus?.ready ?? false));

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

<header class="panel-head">
  <span class="panel-title">New thread</span>
  <div class="actions">
    <button type="button" class="icon-btn" aria-label="Hide agent panel" title="Hide agent panel" onclick={onhide}><Icon name="panel" /></button>
  </div>
</header>

<div class="panel-body">
  <div class="intro">
    <Logo size={40} />
    <h2>What should change?</h2>
    <p>Point at what you see, pick the frames, and describe it. The agent edits the scene and shows you the frames.</p>
    <ol class="steps">
      <li class:is-done={sel.layer !== ''}>
        <Icon name={sel.layer !== '' ? 'check' : 'pointer'} size={15} />
        <span>{sel.layer !== '' ? `Selected ${sel.layer}` : 'Click something on the canvas'}</span>
      </li>
      <li class:is-done={sel.range !== null}>
        <Icon name={sel.range !== null ? 'check' : 'range'} size={15} />
        <span>{sel.range !== null ? `Frames ${sel.rangeText?.interval ?? ''}` : 'Mark frames with I and O'}</span>
      </li>
      <li>
        <Icon name="message" size={15} />
        <span>Describe the change below</span>
      </li>
    </ol>
  </div>
</div>

<footer class="panel-foot">
  {#if ui.studio.error}<p class="panel-note is-error">{ui.studio.error}</p>{/if}
  {#if status}<p class="composer-status" class:is-error={status.error} role="status">{status.text}</p>{/if}
  <Composer
    bind:value={prompt}
    bind:files
    bind:agent
    bind:settings
    agents={ui.studio.agents}
    label="Prompt"
    placeholder="Make pip look sad here…"
    {target}
    sendLabel="Send to agent"
    canSend={prompt.trim() !== '' && !sending && sel.sceneId !== null && ready}
    onsubmit={send}
    onproblem={(text) => (status = { text, error: true })}
    onrefresh={() => actions.refreshAgents()}
  />
</footer>
