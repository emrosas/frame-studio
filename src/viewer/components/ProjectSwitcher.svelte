<!--
  The project switcher (ADR 0013), at the top left: the logo and the project
  on screen. In the app it opens a list of recent projects, each with its
  threads that are working, waiting on your input, or your turn, so agents at
  work elsewhere stay in sight; and New project and Open project. A dot on the
  button says another project needs a look. In a browser it only names the
  project.
-->
<script lang="ts">
  import type { ProjectEntry } from '../desktop';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const name = $derived(ui.folder ? (ui.folder.path.split(/[\\/]/).filter(Boolean).pop() ?? ui.folder.path) : 'Frame Studio');
  const canSwitch = $derived(ui.folder?.canSwitch ?? false);

  let open = $state(false);
  let projects = $state<ProjectEntry[]>([]);
  let problem = $state<string | null>(null);
  let root = $state<HTMLElement | null>(null);

  // Other projects with something going on, for the dot on the button.
  const elsewhere = $derived(projects.filter((p) => !p.current));
  // The most pressing first: waiting on your input (blue), your turn, then working.
  const flag = $derived(
    elsewhere.some((p) => p.input > 0)
      ? { kind: 'input', label: 'Another project waits on your input' }
      : elsewhere.some((p) => p.yours > 0)
        ? { kind: 'your_turn', label: "It's your turn in another project" }
        : elsewhere.some((p) => p.working > 0)
          ? { kind: 'working', label: 'An agent works in another project' }
          : null,
  );

  async function refresh(): Promise<void> {
    // The actions arrive once the App has started, after the components mount.
    if (typeof actions.projects !== 'function') return;
    projects = await actions.projects();
  }

  $effect(() => {
    if (!canSwitch) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  });

  async function go(action: () => Promise<string | null>): Promise<void> {
    problem = await action();
    if (!problem) open = false;
  }

  const where = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }}
  onkeydowncapture={(e) => {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      open = false;
    }
  }}
/>

<div class="switcher" bind:this={root}>
  {#if canSwitch}
    <button
      type="button"
      class="switcher-btn"
      aria-haspopup="menu"
      aria-expanded={open}
      title="{ui.folder?.path ?? ''}\nSwitch project"
      onclick={() => {
        open = !open;
        problem = null;
        if (open) void refresh();
      }}
    >
      <Logo size={20} />
      <span class="switcher-name">{name}</span>
      <Icon name="chevronDown" size={14} />
      {#if flag}<span class="status-dot is-{flag.kind} switcher-dot" role="img" aria-label={flag.label}></span>{/if}
    </button>
  {:else}
    <span class="switcher-btn is-static" title={ui.folder?.path ?? ''}><Logo size={20} /><span class="switcher-name">{name}</span></span>
  {/if}

  {#if open}
    <div class="popover switcher-menu" role="menu" aria-label="Projects">
      <ul>
        {#each projects as p (p.path)}
          <li>
            <button
              type="button"
              role="menuitem"
              class="switcher-item"
              class:is-current={p.current}
              disabled={p.missing}
              title={p.missing ? `${p.path} is gone` : p.path}
              onclick={() => (p.current ? (open = false) : go(() => actions.openProject(p.path)))}
            >
              <span class="switcher-check">{#if p.current}<Icon name="check" size={13} />{/if}</span>
              <span class="switcher-text">
                <span class="switcher-item-name">{p.name}</span>
                <span class="switcher-path">{p.missing ? 'Folder not found' : where(p.path)}</span>
              </span>
              <span class="switcher-counts">
                {#if p.working > 0}<span class="switcher-count" title="{p.working} working"><span class="status-dot is-working"></span>{p.working}</span>{/if}
                {#if p.input > 0}<span class="switcher-count" title="{p.input} waiting on your input"><span class="status-dot is-input"></span>{p.input}</span>{/if}
                {#if p.yours > 0}<span class="switcher-count" title="{p.yours} your turn"><span class="status-dot is-your_turn"></span>{p.yours}</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="switcher-actions">
        <button type="button" role="menuitem" class="switcher-action" onclick={() => go(() => actions.newProject())}><Icon name="plus" size={14} />New project…</button>
        <button
          type="button"
          role="menuitem"
          class="switcher-action"
          onclick={() =>
            go(async () => {
              actions.openFolder();
              return null;
            })}><Icon name="folder" size={14} />Open project folder…</button
        >
      </div>
      {#if problem}<p class="panel-note is-error" role="alert">{problem}</p>{/if}
    </div>
  {/if}
</div>
