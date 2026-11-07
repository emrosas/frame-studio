<!--
  The sidebar: the logo with search and one + menu, then a switch between
  Footage and Threads (Command-1 and 2), so the threads have a place of their
  own beside the conversation. Both list one group per project (ADR 0013): the
  one on screen open at the top, the other recent projects below it, folded
  until you open them. Footage has the library above them. Which are open is
  kept in the app, since every project's page has an origin of its own. The
  filter stays out of sight until Command-F or the search icon, and spans every
  project. At the bottom, the app's update when it has one. Sound files live in
  the library. A browser has the one group.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { desktop, type ProjectEntry } from '../desktop';
  import { readPref, writePref } from '../prefs';
  import { projectGroups } from '../project-groups';
  import { threadSummary } from '../../studio/protocol';
  import { isSeen, sceneDots, threadGroups } from '../thread-groups';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import Popover from './Popover.svelte';
  import ProjectGroup from './ProjectGroup.svelte';
  import ThreadGroup from './ThreadGroup.svelte';
  import UpdateCard from './UpdateCard.svelte';

  let { ui, actions, hidden }: { ui: ViewerUi; actions: ViewerActions; hidden: boolean } = $props();

  /** Which folds you've set and the last project on screen. */
  const SIDEBAR_KEY = 'frame-studio:sidebar';

  function savedSidebar(): { folds: Record<string, boolean>; last: string | null } {
    try {
      const saved = JSON.parse(readPref(SIDEBAR_KEY) ?? '{}') as { folds?: Record<string, boolean>; last?: string };
      return { folds: saved.folds ?? {}, last: saved.last ?? null };
    } catch {
      return { folds: {}, last: null };
    }
  }

  const folder = $derived(ui.folder?.path ?? '');
  const canSwitch = $derived(ui.folder?.canSwitch ?? false);
  const saved = savedSidebar();
  let folds = $state<Record<string, boolean>>(saved.folds);
  // A project just arrived on screen sits open, even if you left it folded. Each switch loads the page, so this runs once per project.
  const arrived = untrack(() => folder);
  if (saved.last !== arrived && folds[arrived] === false) delete folds[arrived];
  let projects = $state.raw<readonly ProjectEntry[]>(desktop()?.boot.projects ?? []);

  function keep(): void {
    writePref(SIDEBAR_KEY, JSON.stringify({ folds: $state.snapshot(folds), last: arrived }));
  }
  keep();

  function fold(key: string, open: boolean): void {
    folds[key] = open;
    keep();
  }

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

  let filter = $state('');
  let filtering = $state(false);
  let field = $state<HTMLInputElement | null>(null);
  const name = $derived(folder.split(/[\\/]/).filter(Boolean).pop() ?? folder);
  const query = $derived(filtering ? filter : '');
  const groups = $derived(projectGroups({ entries: projects, scenes: ui.scenes, folder: { path: folder, name }, folds, query }));

  const threads = $derived(ui.layout.side === 'threads');
  const live = $derived(ui.studio.requests.map((r) => threadSummary(r, ui.studio.now, { poster: ui.thumbs[r.sceneId] ?? null })));
  const threadsIn = (q: string) => threadGroups({ entries: projects, live, folder: { path: folder, name }, folds, seen: ui.threadsSeen, query: q });
  const allThreads = $derived(threadsIn(''));
  const shownThreads = $derived(query.trim() === '' ? allThreads : threadsIn(query));
  const waiting = $derived(allThreads.reduce((sum, g) => sum + g.waiting, 0));
  const dots = $derived(Object.fromEntries(allThreads.map((g) => [g.path, sceneDots(g.threads, (t) => isSeen(ui.threadsSeen, g.path, t))])));

  function show(side: 'footage' | 'threads'): void {
    ui.layout.side = side;
    ui.layout.sidebar = true;
  }

  function openFilter(): void {
    filtering = true;
    void tick().then(() => field?.focus());
  }

  function closeFilter(): void {
    filtering = false;
    filter = '';
  }

  let adding = $state(false);
  let addBox = $state<HTMLElement | null>(null);
  let note = $state<{ text: string; error: boolean } | null>(null);

  function add(what: 'video' | 'scene'): void {
    adding = false;
    ui.newRequest = what === 'video' ? { kind: 'video' } : { kind: 'scene', project: null };
  }

  async function newProject(): Promise<void> {
    adding = false;
    const problem = await actions.newProject();
    note = problem ? { text: problem, error: true } : null;
  }

  function openFolder(): void {
    adding = false;
    note = null;
    actions.openFolder();
  }

  // Showing a scene of an older film opens its fold; after that you can fold it again.
  const film = $derived(ui.scenes.find((s) => s.key === ui.selectedScene)?.film ?? null);
  $effect(() => {
    const id = film;
    if (id === null) return;
    untrack(() => {
      if (folds[`${folder}#films`] !== true || folds[`${folder}#film:${id}`] === false) {
        folds[`${folder}#films`] = true;
        folds[`${folder}#film:${id}`] = true;
        keep();
      }
    });
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || ui.newRequest) return;
    if (e.key.toLowerCase() === 'f' && !hidden) {
      e.preventDefault();
      openFilter();
    } else if (e.key === '1' || e.key === '2') {
      e.preventDefault();
      show(e.key === '1' ? 'footage' : 'threads');
    }
  }}
/>

<nav class="sidebar" aria-label="Studio" {hidden}>
  <header class="sidebar-head">
    <span class="sidebar-logo" title="Frame Studio"><Logo size={20} /></span>
    <span class="spacer"></span>
    <button type="button" class="icon-btn" aria-label="Search" title="Search (⌘F)" aria-expanded={filtering} onclick={() => (filtering ? closeFilter() : openFilter())}><Icon name="search" /></button>
    <div class="anchor" bind:this={addBox}>
      <button type="button" class="icon-btn" aria-label="New" title="New" aria-haspopup="menu" aria-expanded={adding} onclick={() => (adding = !adding)}><Icon name="plus" /></button>
      {#if adding}
        <Popover label="New" role="menu" class="add-menu" anchor={addBox} onclose={() => (adding = false)}>
          <button type="button" role="menuitem" class="menu-item" onclick={() => add('video')}>New video</button>
          <button type="button" role="menuitem" class="menu-item" onclick={() => add('scene')}>New scene</button>
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            onclick={() => {
              adding = false;
              ui.voiceOpen = true;
            }}>Generate voice…</button
          >
          {#if canSwitch}
            <div class="menu-rule"></div>
            <button type="button" role="menuitem" class="menu-item" onclick={newProject}>New project…</button>
            <button type="button" role="menuitem" class="menu-item" onclick={openFolder}>Open project folder…</button>
          {/if}
        </Popover>
      {/if}
    </div>
  </header>

  <div class="side-switch" role="group" aria-label="Sidebar view">
    <button type="button" aria-pressed={!threads} title="Footage (⌘1)" onclick={() => show('footage')}>Footage</button>
    <button type="button" aria-pressed={threads} aria-label={waiting > 0 ? `Threads, ${waiting} waiting for you` : 'Threads'} title="Threads (⌘2)" onclick={() => show('threads')}>
      Threads
      {#if waiting > 0}<span class="count">{waiting}</span>{/if}
    </button>
  </div>

  {#if !threads}
    <div class="sidebar-top">
      <button type="button" class="side-item" aria-current={ui.home ? 'page' : undefined} onclick={(e) => { actions.showHome(true); e.currentTarget.blur(); }}>
        <Icon name="library" />
        <span class="name">Library</span>
      </button>
    </div>
  {/if}

  <div class="sidebar-scroll">
    {#if filtering}
      <input
        class="side-filter"
        type="search"
        placeholder="Filter"
        aria-label={threads ? 'Filter threads' : 'Filter videos and scenes'}
        autocomplete="off"
        spellcheck="false"
        bind:this={field}
        bind:value={filter}
        onkeydown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeFilter();
          }
        }}
      />
    {/if}
    {#if note}<p class="side-empty panel-note" class:is-error={note.error} role="status">{note.text}</p>{/if}
    {#if threads}
      {#each shownThreads as group (group.path)}
        <ThreadGroup {group} {ui} {actions} onfold={fold} onnote={(next) => (note = next)} onforget={() => void refresh()} />
      {:else}
        <p class="side-empty">No matches.</p>
      {/each}
    {:else}
      {#each groups as group (group.path)}
        <ProjectGroup group={{ ...group, status: allThreads.find((g) => g.path === group.path)?.status ?? group.status }} {ui} {actions} filtering={query.trim() !== ''} {folds} dots={dots[group.path] ?? {}} onfold={fold} onnote={(next) => (note = next)} onforget={() => void refresh()} />
      {:else}
        <p class="side-empty">No matches.</p>
      {/each}
    {/if}
  </div>

  {#if ui.update && ui.update.status !== 'idle' && ui.update.status !== 'checking'}
    <footer class="sidebar-foot">
      <UpdateCard update={ui.update} {actions} />
    </footer>
  {/if}
</nav>
