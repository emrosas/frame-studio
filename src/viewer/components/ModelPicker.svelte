<!--
  Who works the thread, folded into a pill in the composer: the provider's
  logo, the model and the effort. It opens on a rail of providers, with Recent
  above them once you've picked; the models of the one in view; and that
  model's efforts. The rail only looks: picking a model is what changes the
  agent. The external agent has no models, so its rail entry picks it. A thread
  keeps its agent, so replies lock the other entries; model and effort stay
  open. Only what a provider reports shows, and one that isn't ready says why
  and which command fixes it. Keeps the model and effort to ones the agent
  offers.
-->
<script lang="ts">
  import type { AgentId, AgentStatus, TurnSettings } from '../../studio/protocol';
  import { agentIcon, defaultEffort, defaultModel, effortsOf, fitSettings, liveRecents, parseRecents, pushRecent, RECENTS_KEY } from '../picker';
  import { readPref, writePref } from '../prefs';
  import Icon from './Icon.svelte';
  import Popover from './Popover.svelte';

  let {
    agent = $bindable(),
    settings = $bindable(),
    agents,
    fixed,
    onpick,
    onrefresh,
  }: {
    agent: AgentId;
    settings: TurnSettings;
    agents: AgentStatus[];
    fixed: boolean;
    onpick?: (id: AgentId) => void;
    onrefresh: () => void;
  } = $props();

  /** The list gets a search box past this many. */
  const SEARCH_FROM = 10;
  const LOCKED = 'A thread keeps its agent. Start a new thread to use another.';

  let open = $state(false);
  let permissions = $state(false);
  let anchor = $state<HTMLElement | null>(null);
  let bottom = $state(0);
  /** The rail entry in view. */
  let rail = $state<AgentId | 'recent'>(agent);
  let search = $state('');
  let recents = $state(parseRecents(readPref(RECENTS_KEY)));

  const status = $derived(agents.find((a) => a.id === agent));
  const external = $derived(agent === 'external');
  const hasOptions = $derived(!external && status !== undefined);
  const live = $derived(liveRecents(recents, agents, fixed ? agent : undefined));
  const viewed = $derived(rail === 'recent' ? status : agents.find((a) => a.id === rail));
  const viewedExternal = $derived(rail === 'external');
  const models = $derived.by(() => {
    const list = viewed?.models ?? [];
    const words = search.trim().toLowerCase();
    return words === '' ? list : list.filter((m) => m.label.toLowerCase().includes(words));
  });
  // The effort column follows the thread's model on its own provider, and that provider's default on another.
  const columnModel = $derived(viewed && viewed.id === agent ? settings.model : viewed ? defaultModel(viewed)?.id : undefined);
  const efforts = $derived(viewed && viewed.ready ? effortsOf(viewed, columnModel) : []);
  const startsOn = $derived(viewed ? defaultEffort(viewed, columnModel) : undefined);

  const modelName = $derived(status?.models.find((m) => m.id === settings.model)?.label ?? status?.label ?? agent);
  const effortWord = $derived(status && hasOptions && effortsOf(status, settings.model).length > 0 ? settings.effort : undefined);
  const tooltip = $derived([status?.label ?? agent, status?.models.some((m) => m.id === settings.model) ? modelName : null, effortWord, hasOptions && settings.access === 'full' ? 'Full access' : null].filter(Boolean).join(' · '));

  $effect.pre(() => {
    const s = status;
    if (!s || external) return;
    const fitted = fitSettings(s, settings.model, settings.effort);
    if (fitted.model !== settings.model) settings.model = fitted.model;
    if (fitted.effort !== settings.effort) settings.effort = fitted.effort;
  });

  function toggle(): void {
    open = !open;
    permissions = false;
    if (!open) return;
    rail = agent;
    search = '';
    // The panel sits at the window's right edge, and the sheet is wider than it, so it hangs from there.
    if (anchor) bottom = innerHeight - anchor.getBoundingClientRect().top + 8;
  }

  function choose(id: AgentId, model: string, effort?: string): void {
    const s = agents.find((a) => a.id === id);
    if (!s) return;
    if (id !== agent) {
      agent = id;
      onpick?.(id);
    }
    const fitted = fitSettings(s, model, effort ?? settings.effort);
    settings.model = fitted.model;
    settings.effort = fitted.effort;
    if (!model) return;
    recents = pushRecent(recents, { agent: id, model, ...(fitted.effort ? { effort: fitted.effort } : {}) });
    writePref(RECENTS_KEY, JSON.stringify(recents));
  }

  function pickRail(a: AgentStatus): void {
    if (fixed && a.id !== agent) return;
    rail = a.id;
    search = '';
    if (a.id === 'external' && agent !== 'external') {
      agent = 'external';
      onpick?.('external');
    } else if (agent === 'external' && a.id !== 'external' && a.ready) {
      // Leaving your own agent has no row to confirm it, so the logo does.
      choose(a.id, defaultModel(a)?.id ?? '');
    }
  }

  const railTitle = (a: AgentStatus) => {
    if (fixed && a.id !== agent) return `${a.label}. ${LOCKED}`;
    if (a.ready) return a.label;
    return [`${a.label} isn't ready: ${a.detail}.`, a.fix ? `Run ${a.fix} in a terminal.` : ''].filter(Boolean).join(' ');
  };

  const closeSheet = () => {
    // Escape and a press outside close the permissions menu first.
    if (!permissions) open = false;
  };
</script>

<!-- The sheet hangs from where the pill was when it opened. -->
<svelte:window onresize={() => (open = false)} />

{#if !fixed ? agents.length > 1 || hasOptions : hasOptions}
  <div class="anchor" bind:this={anchor}>
    <button type="button" class="pill model-pill" aria-label="Agent settings" title={tooltip} aria-expanded={open} onclick={toggle}>
      <Icon name={agentIcon(agent)} />
      <span class="pill-text">{modelName}</span>
      {#if effortWord}<span class="pill-effort">{effortWord}</span>{/if}
      <Icon name="chevronDown" />
    </button>
    {#if open}
      <Popover label="Agent settings" class="model-menu {efforts.length > 0 ? '' : 'no-efforts'}" style="bottom: {bottom}px" {anchor} onclose={closeSheet}>
        <div class="model-rail" role="radiogroup" aria-label="Agent">
          {#if live.length > 0}
            <button type="button" role="radio" aria-label="Recent" title="Recent" aria-checked={rail === 'recent'} onclick={() => (rail = 'recent')}><Icon name="clock" /></button>
            <span class="model-rail-rule"></span>
          {/if}
          {#each agents as a (a.id)}
            {@const locked = fixed && a.id !== agent}
            <button type="button" role="radio" aria-label={a.label} title={railTitle(a)} aria-checked={rail === a.id} aria-disabled={locked} class:is-dim={!a.ready} class:is-locked={locked} onclick={() => pickRail(a)}><Icon name={agentIcon(a.id)} /></button>
          {/each}
        </div>

        <div class="model-main">
          {#if rail === 'recent'}
            <div class="model-list" role="radiogroup" aria-label="Recent">
              {#each live as p (`${p.agent}:${p.model}`)}
                {@const s = agents.find((a) => a.id === p.agent)}
                {@const on = p.agent === agent && p.model === settings.model}
                <button type="button" role="radio" aria-checked={on} class="menu-item" onclick={() => choose(p.agent, p.model, p.effort)}>
                  <Icon name={agentIcon(p.agent)} />
                  <span class="model-name">{s?.models.find((m) => m.id === p.model)?.label ?? p.model}</span>
                  {#if p.effort}<span class="model-effort">{p.effort}</span>{/if}
                  {#if on}<Icon name="check" />{/if}
                </button>
              {/each}
            </div>
          {:else if viewedExternal}
            <p class="model-note">Your own agent takes it from the queue. Sending copies a line to paste into it.</p>
          {:else if viewed && !viewed.ready}
            <div class="model-note">
              <p>{viewed.label} isn't ready: {viewed.detail}.</p>
              {#if viewed.fix}<p>Run <code>{viewed.fix}</code> in a terminal, then <button type="button" class="link-btn" onclick={onrefresh}>check again</button></p>{/if}
            </div>
          {:else if viewed}
            {#if viewed.models.length > SEARCH_FROM}
              <input class="model-search" type="search" placeholder="Search models" aria-label="Search models" autocomplete="off" spellcheck="false" bind:value={search} />
            {/if}
            <div class="model-list" role="radiogroup" aria-label="Model">
              {#each models as m (m.id)}
                {@const on = viewed.id === agent && m.id === settings.model}
                <button type="button" role="radio" aria-checked={on} aria-label={m.label} title={m.label} class="menu-item" onclick={() => choose(viewed.id, m.id)}>
                  <Icon name={agentIcon(viewed.id)} />
                  <span class="model-name">{m.label}</span>
                  {#if on}<Icon name="check" />{/if}
                </button>
              {:else}
                {#if viewed.models.length === 0}
                  <!-- A provider that lists no models still runs, on its own default. -->
                  <button type="button" role="radio" aria-checked={viewed.id === agent} class="menu-item" onclick={() => choose(viewed.id, '')}>
                    <Icon name={agentIcon(viewed.id)} />
                    <span class="model-name">{viewed.label}</span>
                    {#if viewed.id === agent}<Icon name="check" />{/if}
                  </button>
                {:else}
                  <p class="model-note">No models match.</p>
                {/if}
              {/each}
            </div>
          {/if}
        </div>

        {#if efforts.length > 0 && viewed}
          <div class="model-efforts" role="radiogroup" aria-label="Effort">
            <h3>Effort</h3>
            <p>{viewed.models.find((m) => m.id === columnModel)?.label ?? viewed.label}</p>
            {#each efforts as e (e)}
              {@const on = viewed.id === agent && e === settings.effort}
              <button type="button" role="radio" aria-checked={on} aria-label={e} class="menu-item" onclick={() => choose(viewed.id, columnModel ?? '', e)}>
                <span class="model-name">{e}</span>
                {#if e === startsOn}<span class="model-effort">Default</span>{/if}
                {#if on}<Icon name="check" />{/if}
              </button>
            {/each}
          </div>
        {/if}

        {#if !external}
          <footer class="model-foot">
            <div class="anchor">
              <button type="button" class="pill" aria-label="Permissions" title="What the agent may do without asking" aria-haspopup="menu" aria-expanded={permissions} onclick={() => (permissions = !permissions)}>
                <Icon name="shield" />
                <span class="pill-text">{settings.access === 'full' ? 'Full access' : 'Studio access'}</span>
                <span class="chevron is-up"><Icon name="chevronDown" /></span>
              </button>
              {#if permissions}
                <Popover label="Permissions" role="menu" class="permissions-menu" onclose={() => (permissions = false)}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={settings.access !== 'full'}
                    class="menu-item"
                    title="Asks before editing files outside scenes/, rigs and audio, and before running commands"
                    onclick={() => {
                      settings.access = 'studio';
                      permissions = false;
                    }}>Studio access{#if settings.access !== 'full'}<Icon name="check" />{/if}</button
                  >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={settings.access === 'full'}
                    class="menu-item"
                    title="Never asks: the agent can edit any file and run any command"
                    onclick={() => {
                      settings.access = 'full';
                      permissions = false;
                    }}>Full access{#if settings.access === 'full'}<Icon name="check" />{/if}</button
                  >
                </Popover>
              {/if}
            </div>
          </footer>
        {/if}
      </Popover>
    {/if}
  </div>
{:else if fixed}
  <span class="pill is-fixed" title={LOCKED}><Icon name={agentIcon(agent)} /><span class="pill-text">{status?.label ?? agent}</span></span>
{/if}
