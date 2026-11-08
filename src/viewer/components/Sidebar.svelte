<!--
  The sidebar: the logo with search and one + menu, then a switch between
  Footage and Threads (Command-1 and 2), so the threads have a place of their
  own beside the conversation. Footage lists the projects (ADR 0013), the one
  on screen first, and a click opens one's library in the middle, where its
  videos and scenes are picked. Threads is one list for every project, newest
  first, each card naming its project, with the settled ones under a Done
  fold. Whether that fold is open is kept in the app, since every project's
  page has an origin of its own. The filter stays out of sight until Command-F
  or the search icon, and spans every project. At the bottom, the app's update
  when it has one. A browser has the one project.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { desktop, type ProjectEntry } from '../desktop';
  import { readPref, writePref } from '../prefs';
  import { projectRows } from '../project-rows';
  import { threadSummary } from '../../studio/protocol';
  import { isSeen, threadBadge, threadList, type ThreadEntry } from '../thread-groups';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import Popover from './Popover.svelte';
  import ProjectRow from './ProjectRow.svelte';
  import ThreadCard from './ThreadCard.svelte';
  import UpdateCard from './UpdateCard.svelte';

  let { ui, actions, hidden }: { ui: ViewerUi; actions: ViewerActions; hidden: boolean } = $props();

  /** Whether the Done fold is open. */
  const SIDEBAR_KEY = 'frame-studio:sidebar';

  function savedDone(): boolean {
    try {
      return (JSON.parse(readPref(SIDEBAR_KEY) ?? '{}') as { done?: boolean }).done === true;
    } catch {
      return false;
    }
  }

  const folder = $derived(ui.folder?.path ?? '');
  const canSwitch = $derived(ui.folder?.canSwitch ?? false);
  let doneOpen = $state(savedDone());
  let projects = $state.raw<readonly ProjectEntry[]>(desktop()?.boot.projects ?? []);

  function foldDone(open: boolean): void {
    doneOpen = open;
    writePref(SIDEBAR_KEY, JSON.stringify({ done: open }));
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
  const rows = $derived(projectRows({ entries: projects, scenes: ui.scenes, folder: { path: folder, name }, query }));

  const threads = $derived(ui.layout.side === 'threads');
  const live = $derived(ui.studio.requests.map((r) => threadSummary(r, ui.studio.now, { poster: ui.thumbs[r.sceneId] ?? null })));
  const threadsIn = (q: string) => threadList({ entries: projects, live, folder: { path: folder, name }, seen: ui.threadsSeen, query: q });
  const allThreads = $derived(threadsIn(''));
  const list = $derived(query.trim() === '' ? allThreads : threadsIn(query));
  const waiting = $derived(allThreads.waiting);
  // One project needs no name on every card.
  const named = $derived(projects.length > 1);
  const showDone = $derived(doneOpen || query.trim() !== '');
  const settledHere = $derived(list.done.some((e) => e.current));

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

  const isOpen = (e: ThreadEntry) => (ui.switching ? ui.switching.path === e.path && ui.switching.thread === e.thread.id : e.current && ui.studio.open === e.thread.id);

  async function pick(e: ThreadEntry, event: MouseEvent & { currentTarget: HTMLButtonElement }): Promise<void> {
    // Hand focus back so Space and the arrow keys drive playback again.
    event.currentTarget.blur();
    if (e.current) {
      ui.layout.panel = true;
      actions.openThread(e.thread.id);
      return;
    }
    const problem = await actions.openProject(e.path, e.name, { scene: e.thread.sceneId, thread: e.thread.id });
    note = problem ? { text: problem, error: true } : null;
  }
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

{#snippet cards(entries: readonly ThreadEntry[])}
  <ul class="thread-cards">
    {#each entries as e (`${e.path}#${e.thread.id}`)}
      {@const open = isOpen(e)}
      <li><ThreadCard {ui} thread={e.thread} badge={threadBadge(e.thread, !open && isSeen(ui.threadsSeen, e.path, e.thread))} project={e.current ? null : e.path} projectName={named ? e.name : null} {open} onopen={(event) => void pick(e, event)} /></li>
    {/each}
  </ul>
{/snippet}

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

  <div class="sidebar-scroll">
    {#if filtering}
      <input
        class="side-filter"
        type="search"
        placeholder="Filter"
        aria-label={threads ? 'Filter threads' : 'Filter projects, videos and scenes'}
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
      {#if list.threads.length > 0}
        {@render cards(list.threads)}
      {:else if list.done.length === 0}
        <p class="side-empty">{query.trim() === '' ? 'No threads yet.' : 'No matches.'}</p>
      {/if}
      {#if list.done.length > 0}
        <section class="side-section" aria-label="Done">
          <div class="done-head">
            <button type="button" class="side-label side-fold" aria-expanded={showDone} onclick={() => foldDone(!showDone)}>
              <span class="chevron" class:is-closed={!showDone}><Icon name="chevronDown" /></span>
              Done
            </button>
            {#if settledHere}<button type="button" class="link-btn" title={named ? `Clears the settled threads in ${name}` : undefined} onclick={() => actions.clearFinished()}>Clear settled</button>{/if}
          </div>
          {#if showDone}{@render cards(list.done)}{/if}
        </section>
      {/if}
    {:else}
      <ul class="project-list" aria-label="Projects">
        {#each rows as row (row.path)}
          <ProjectRow {row} {ui} {actions} onnote={(next) => (note = next)} onforget={() => void refresh()} />
        {/each}
      </ul>
      {#if rows.length === 0}<p class="side-empty">No matches.</p>{/if}
    {/if}
  </div>

  {#if ui.update && ui.update.status !== 'idle' && ui.update.status !== 'checking'}
    <footer class="sidebar-foot">
      <UpdateCard update={ui.update} {actions} />
    </footer>
  {/if}
</nav>
