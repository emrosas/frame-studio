<!--
  The sidebar: the project switcher, New thread, the project's compositions
  and scenes (ADR 0013), any films made before compositions (M9, each under
  its name, main scene first), sound files, and the threads, newest first. At
  the bottom, the app's update when it has one. Clicking a scene shows it;
  clicking a thread opens it in the agent panel. The + by Compositions and by
  Scenes, and New scene in an M9 film, open the New dialog.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { currentTurn, displayStatus, type StudioRequest } from '../../studio/protocol';
  import type { NewWhat, SceneOption, ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import ProjectSwitcher from './ProjectSwitcher.svelte';
  import NewDialog from './NewDialog.svelte';
  import UpdateCard from './UpdateCard.svelte';
  import { desktop } from '../desktop';

  const desktopApp = desktop() !== null;

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
    input: 'Input',
    settled: 'Settled',
    cancelled: 'Cancelled',
  };


  // The folder's compositions and scenes, then each M9 film's. The App orders them, so a film's scenes are one run.
  const compositions = $derived(ui.scenes.filter((s) => s.project === null && s.kind === 'composition'));
  const loose = $derived(ui.scenes.filter((s) => s.project === null && s.kind === 'scene'));
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

  let creating = $state<NewWhat | null>(null);
  // The empty stage's New scene opens the same dialog.
  $effect(() => {
    if (ui.newRequest) {
      creating = ui.newRequest;
      ui.newRequest = null;
    }
  });

  // Sound files (ADR 0012): import by picker, list, and place at the playhead.
  let picker = $state<HTMLInputElement | null>(null);
  // "4.5s" under a minute, "2:05" from there.
  const minutes = (s: number) => (s < 60 ? `${Math.round(s * 10) / 10}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
  async function importPicked(files: FileList | null): Promise<void> {
    const list = [...(files ?? [])];
    if (picker) picker.value = '';
    if (list.length === 0) return;
    ui.mediaNote = { text: `Importing ${list.length === 1 ? list[0].name : `${list.length} files`}…`, error: false };
    const problem = await actions.importMedia(list);
    ui.mediaNote = problem ? { text: problem, error: true } : { text: `Imported ${list.length === 1 ? list[0].name : `${list.length} files`}.`, error: false };
  }
  async function place(file: string): Promise<void> {
    const problem = await actions.placeSound(file);
    ui.mediaNote = problem ? { text: problem, error: true } : null;
  }

  // Converting an M9 film into a project folder (ADR 0013). The app asks where; a browser confirms first.
  let convertNote = $state<{ text: string; error: boolean } | null>(null);
  async function convert(id: string, name: string): Promise<void> {
    if (!desktopApp && !confirm(`Convert “${name}” into a project folder of its own, beside this one? The film here stays as it is.`)) return;
    convertNote = null;
    convertNote = await actions.convertFilm(id);
  }

  const threads = $derived([...ui.studio.requests].reverse());
  // Waiting for you: a turn to answer, or a question card or approval in a working turn.
  const yours = $derived(ui.studio.requests.filter((r) => r.status === 'your_turn' || displayStatus(r, ui.studio.now) === 'input').length);
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

{#snippet sceneItem(option: SceneOption, icon: 'scene' | 'project' | null)}
  <li>
    <button
      type="button"
      class="side-item"
      class:is-invalid={option.invalid}
      data-key={option.key}
      aria-label={option.invalid ? `${option.label} (invalid)` : option.label}
      aria-current={option.key === ui.selectedScene ? 'page' : undefined}
      title={option.invalid ? `${option.file} (invalid: see the error panel)` : option.usedIn.length > 0 ? `${option.file}, used in ${option.usedIn.join(', ')}` : option.file}
      onclick={(e) => pick(option.key, e)}
    >
      {#if icon}<Icon name={icon} size={15} />{/if}
      <span class="name">{option.label}</span>
      {#if option.main}<span class="badge">main</span>{/if}
      {#if option.invalid}<span class="badge">invalid</span>{/if}
    </button>
    {#if option.usedIn.length > 0 && option.key === ui.selectedScene}
      <p class="used-in">
        Used in
        {#each option.usedIn as key, i (key)}{#if i > 0}, {/if}<button type="button" class="link-btn" onclick={(e) => pick(key, e)}>{key}</button>{/each}
      </p>
    {/if}
  </li>
{/snippet}

<nav class="sidebar" aria-label="Studio" {hidden}>
  <header class="sidebar-head">
    <ProjectSwitcher {ui} {actions} />
    <button type="button" class="icon-btn" aria-label="Hide sidebar" title="Hide sidebar" onclick={onhide}><Icon name="sidebar" /></button>
  </header>

  <div class="sidebar-top">
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
    <section class="side-section" aria-label="Compositions">
      <div class="side-label">
        Compositions
        <button type="button" class="icon-btn is-small side-add" aria-label="New composition" title="New composition" onclick={() => (creating = { kind: 'composition' })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if compositions.length === 0}
        <p class="side-empty">No compositions yet. A composition arranges scenes on tracks into a video.</p>
      {:else}
        <ul class="side-list">
          {#each compositions as option (option.key)}{@render sceneItem(option, 'project')}{/each}
        </ul>
      {/if}
    </section>

    <section class="side-section" aria-label="Scenes">
      <div class="side-label">
        Scenes
        <button type="button" class="icon-btn is-small side-add" aria-label="New scene" title="New scene" onclick={() => (creating = { kind: 'scene', project: null })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if loose.length === 0}
        <p class="side-empty">No scenes yet.</p>
      {:else}
        <ul class="side-list">
          {#each loose as option (option.key)}{@render sceneItem(option, 'scene')}{/each}
        </ul>
      {/if}
    </section>

    {#if projects.length > 0}
    <section class="side-section" aria-label="Films">
      <div class="side-label" title="Films made before compositions, in projects/">Films</div>
      {#if convertNote}<p class="side-empty panel-note" class:is-error={convertNote.error} role="status">{convertNote.text}</p>{/if}
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
                <li>
                  <button
                    type="button"
                    class="side-item is-add"
                    title="Makes a project folder of its own, with the film as a composition"
                    onclick={() => convert(project.id, project.name)}
                  >
                    <Icon name="project" size={14} />
                    <span class="name">Convert to a project…</span>
                  </button>
                </li>
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
    {/if}

    <section class="side-section" aria-label="Media">
      <div class="side-label">
        Media
        <button type="button" class="icon-btn is-small side-add" aria-label="Import sound files" title="Import sound files (or drop them anywhere)" onclick={() => picker?.click()}>
          <Icon name="plus" size={14} />
        </button>
        <input
          bind:this={picker}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
          multiple
          hidden
          onchange={(e) => importPicked(e.currentTarget.files)}
        />
      </div>
      {#if ui.mediaNote}<p class="side-empty panel-note" class:is-error={ui.mediaNote.error} role="status">{ui.mediaNote.text}</p>{/if}
      {#if ui.media.length === 0}
        <p class="side-empty">No sound files yet. Drop voiceover or music anywhere, or use +.</p>
      {:else}
        <ul class="side-list">
          {#each ui.media as item (item.file)}
            <li class="media-item">
              <span class="side-item is-static" title={item.file}>
                <Icon name="volume" size={15} />
                <span class="name">{item.name}</span>
                {#if item.duration !== undefined}<span class="media-length">{minutes(item.duration)}</span>{/if}
              </span>
              <button
                type="button"
                class="icon-btn is-small media-place"
                aria-label="Add {item.name} at the playhead"
                title="Add at the playhead"
                disabled={ui.selection.sceneId === null}
                onclick={() => place(item.file)}
              >
                <Icon name="plus" size={13} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

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

  {#if creating}
    <NewDialog
      what={creating}
      {ui}
      {actions}
      onclose={() => (creating = null)}
      ondone={() => {
        actions.openThread(null);
        onthread();
      }}
    />
  {/if}

  {#if ui.update && ui.update.status !== 'idle' && ui.update.status !== 'checking'}
    <footer class="sidebar-foot">
      <UpdateCard update={ui.update} {actions} />
    </footer>
  {/if}
</nav>
