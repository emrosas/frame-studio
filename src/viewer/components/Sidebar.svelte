<!--
  The sidebar: the studio folder (the app can switch it), New thread, the
  folder's scenes (loose ones, then each project's under its name, main scene
  first), and the threads, newest first. At the bottom, the app's update when
  it has one. Clicking a scene shows it; clicking a thread opens it in the
  agent panel.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { currentTurn, displayStatus, type StudioRequest } from '../../studio/protocol';
  import type { SceneOption, ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import UpdateCard from './UpdateCard.svelte';

  let {
    ui,
    actions,
    hidden,
    onhide,
    onthread,
  }: { ui: ViewerUi; actions: ViewerActions; hidden: boolean; onhide: () => void; onthread: () => void } = $props();

  const LABELS: Record<string, string> = {
    pending: 'Waiting',
    working: 'Working',
    stalled: 'Stalled',
    your_turn: 'Your turn',
    settled: 'Settled',
    cancelled: 'Cancelled',
  };

  const folderName = $derived(ui.folder ? (ui.folder.path.split(/[\\/]/).filter(Boolean).pop() ?? ui.folder.path) : '');

  // Loose scenes, then each project's. The App orders them, so a project's scenes are one run.
  const loose = $derived(ui.scenes.filter((s) => s.project === null));
  const projects = $derived.by(() => {
    const groups: { id: string; name: string; scenes: SceneOption[] }[] = [];
    for (const option of ui.scenes) {
      if (option.project === null) continue;
      const last = groups.at(-1);
      if (last && last.id === option.project) last.scenes.push(option);
      else groups.push({ id: option.project, name: option.group ?? option.project, scenes: [option] });
    }
    return groups;
  });

  // Projects fold. Showing a scene opens its project; after that you can fold it again.
  let folded = $state<Record<string, boolean>>({});
  const current = $derived(ui.scenes.find((s) => s.key === ui.selectedScene)?.project ?? null);
  $effect(() => {
    const project = current;
    if (project !== null) untrack(() => (folded[project] = false));
  });

  const threads = $derived([...ui.studio.requests].reverse());
  const yours = $derived(ui.studio.requests.filter((r) => r.status === 'your_turn').length);
  const finished = $derived(ui.studio.requests.filter((r) => r.status === 'settled' || r.status === 'cancelled').length);

  const agentLabel = (r: StudioRequest) => ui.studio.agents.find((a) => a.id === r.agent)?.label ?? r.agent;

  function ago(iso: string | undefined): string {
    if (!iso) return '';
    const s = Math.max(0, (ui.studio.now - Date.parse(iso)) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  function threadMeta(r: StudioRequest, shown: string): string {
    const last = currentTurn(r);
    const when = ago(last.completedAt ?? last.claimedAt ?? r.createdAt);
    return [LABELS[shown], agentLabel(r), r.sceneId, when].filter(Boolean).join(' · ');
  }

  function pick(key: string, e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    actions.selectScene(key);
    // Hand focus back so Space and the arrow keys drive playback again.
    e.currentTarget.blur();
  }
</script>

{#snippet sceneItem(option: SceneOption, icon: 'scene' | null)}
  <li>
    <button
      type="button"
      class="side-item"
      class:is-invalid={option.invalid}
      data-key={option.key}
      aria-label={option.invalid ? `${option.label} (invalid)` : option.label}
      aria-current={option.key === ui.selectedScene ? 'page' : undefined}
      title={option.invalid ? `${option.file} (invalid: see the error panel)` : option.file}
      onclick={(e) => pick(option.key, e)}
    >
      {#if icon}<Icon name={icon} size={15} />{/if}
      <span class="name">{option.label}</span>
      {#if option.main}<span class="badge">main</span>{/if}
      {#if option.invalid}<span class="badge">invalid</span>{/if}
    </button>
  </li>
{/snippet}

<nav class="sidebar" aria-label="Studio" {hidden}>
  <header class="sidebar-head">
    <span class="brand"><Logo size={20} /> Frame Studio</span>
    <button type="button" class="icon-btn" aria-label="Hide sidebar" title="Hide sidebar" onclick={onhide}><Icon name="sidebar" /></button>
  </header>

  <div class="sidebar-top">
    {#if ui.folder}
      <button
        type="button"
        class="side-item folder-btn"
        title={ui.folder.canSwitch ? `${ui.folder.path}\nOpen another studio folder` : ui.folder.path}
        disabled={!ui.folder.canSwitch}
        onclick={() => actions.openFolder()}
      >
        <Icon name="folder" size={15} />
        <span class="name">{folderName}</span>
        {#if ui.folder.canSwitch}<Icon name="chevronDown" size={14} />{/if}
      </button>
    {/if}
    <button
      type="button"
      class="side-item"
      onclick={() => {
        actions.openThread(null);
        onthread();
      }}
    >
      <Icon name="plus" size={15} />
      <span class="name">New thread</span>
    </button>
  </div>

  <div class="sidebar-scroll">
    {#if loose.length > 0}
      <section class="side-section" aria-label="Scenes">
        <div class="side-label">Scenes</div>
        <ul class="side-list">
          {#each loose as option (option.key)}{@render sceneItem(option, 'scene')}{/each}
        </ul>
      </section>
    {/if}

    {#if projects.length > 0}
      <section class="side-section" aria-label="Projects">
        <div class="side-label">Projects</div>
        <ul class="side-list">
          {#each projects as project (project.id)}
            <li role="group" aria-label={project.name}>
              <button type="button" class="side-item" aria-expanded={!folded[project.id]} onclick={() => (folded[project.id] = !folded[project.id])}>
                <Icon name="project" size={15} />
                <span class="name">{project.name}</span>
                <span class="chevron" class:is-closed={folded[project.id]}><Icon name="chevronDown" size={14} /></span>
              </button>
              {#if !folded[project.id]}
                <ul class="side-list side-children">
                  {#each project.scenes as option (option.key)}{@render sceneItem(option, null)}{/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="side-section" aria-label="Threads">
      <div class="side-label">
        Threads
        {#if yours > 0}<span class="count" title="{yours} waiting for you">{yours}</span>{/if}
        {#if finished > 0}<button type="button" class="link-btn" onclick={() => actions.clearFinished()}>Clear settled</button>{/if}
      </div>
      {#if ui.studio.error}<p class="side-empty panel-note is-error">{ui.studio.error}</p>{/if}
      {#if threads.length === 0}
        <p class="side-empty">Threads you start show up here.</p>
      {:else}
        <ul class="side-list">
          {#each threads as r (r.id)}
            {@const shown = displayStatus(r, ui.studio.now)}
            <li>
              <article aria-label="Request {r.id}">
                <button
                  type="button"
                  class="side-item thread-item is-{shown}"
                  aria-current={ui.studio.open === r.id ? 'true' : undefined}
                  title={r.turns[0].ask.prompt}
                  onclick={() => {
                    actions.openThread(r.id);
                    onthread();
                  }}
                >
                  <span class="status-dot is-{shown}" aria-hidden="true"></span>
                  <span class="text">
                    <span class="prompt">{r.turns[0].ask.prompt}</span>
                    <span class="meta">{threadMeta(r, shown)}</span>
                  </span>
                </button>
              </article>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  {#if ui.update && ui.update.status !== 'idle' && ui.update.status !== 'checking'}
    <footer class="sidebar-foot">
      <UpdateCard update={ui.update} {actions} />
    </footer>
  {/if}
</nav>
