<!--
  Who works a thread, and how (ADR 0006): the agent, its model and effort, and
  the access mode. A thread keeps its agent, so replies show it fixed and only
  offer the model, effort and access. An agent that isn't ready says why and
  which command fixes it; the studio never asks for credentials itself.
-->
<script lang="ts">
  import type { AgentId, AgentStatus, TurnSettings } from '../../studio/protocol';

  let {
    agents,
    agent = $bindable(),
    settings = $bindable(),
    fixed = false,
    onrefresh,
  }: {
    agents: AgentStatus[];
    agent: AgentId;
    settings: TurnSettings;
    fixed?: boolean;
    onrefresh: () => void;
  } = $props();

  const status = $derived(agents.find((a) => a.id === agent));

  // Keep the model and effort to ones this agent offers.
  $effect(() => {
    const s = status;
    if (!s) return;
    if (s.models.length > 0 && !s.models.some((m) => m.id === settings.model)) settings.model = s.models[0].id;
    if (s.efforts.length > 0 && (settings.effort === undefined || !s.efforts.includes(settings.effort))) {
      settings.effort = s.efforts.includes('medium') ? 'medium' : s.efforts[0];
    }
  });
</script>

<div class="agent-picker">
  <div class="agent-row">
    {#if fixed}
      <span class="agent-fixed" title="A thread keeps its agent; start a new request to use another">{status?.label ?? agent}</span>
    {:else}
      <select aria-label="Agent" bind:value={agent}>
        {#each agents as a (a.id)}
          <option value={a.id}>{a.label}{a.ready ? '' : ' (not ready)'}</option>
        {/each}
      </select>
    {/if}
    {#if agent !== 'external' && status}
      {#if status.models.length > 1}
        <select aria-label="Model" bind:value={settings.model}>
          {#each status.models as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
        </select>
      {/if}
      {#if status.efforts.length > 0}
        <select aria-label="Effort" bind:value={settings.effort}>
          {#each status.efforts as e (e)}<option value={e}>{e}</option>{/each}
        </select>
      {/if}
    {/if}
  </div>
  {#if agent !== 'external'}
    <label class="full-access" title="Without full access, the agent asks before editing files outside scenes/, src/rigs/ and src/audio/, and before running commands">
      <input
        type="checkbox"
        checked={settings.access === 'full'}
        onchange={(e) => (settings.access = e.currentTarget.checked ? 'full' : 'studio')}
      />
      Full access
    </label>
  {/if}
  {#if status && !status.ready}
    <p class="agent-note" role="status">
      {status.label} isn't ready: {status.detail}.
      {#if status.fix}Run <code>{status.fix}</code> in a terminal, then{/if}
      <button type="button" class="link" onclick={onrefresh}>check again</button>
    </p>
  {/if}
</div>
