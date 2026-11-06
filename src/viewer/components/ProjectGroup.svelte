<!--
  One project in the sidebar's Footage view (ADR 0013): its header, then its
  videos, its scenes and, last, its older films, folded, each with Convert. A
  row whose scene has a thread going shows a dot. The project on screen shows
  its live list; another shows what the app read off disk, and clicking a row
  there opens that project on it.
-->
<script lang="ts">
  import type { OpenTarget } from '../desktop';
  import type { GroupRow, ProjectGroup } from '../project-groups';
  import type { ThreadBadge } from '../thread-groups';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import ProjectHead from './ProjectHead.svelte';
  import Thumb from './Thumb.svelte';

  let {
    group,
    ui,
    actions,
    filtering,
    folds,
    dots,
    onfold,
    onnote,
    onforget,
  }: {
    group: ProjectGroup;
    ui: ViewerUi;
    actions: ViewerActions;
    filtering: boolean;
    folds: Readonly<Record<string, boolean>>;
    /** The scenes with a thread working or waiting, by key. */
    dots: Readonly<Record<string, ThreadBadge>>;
    onfold: (key: string, open: boolean) => void;
    /** Something to say under the sidebar's head, or null to clear it. */
    onnote: (note: { text: string; error: boolean } | null) => void;
    onforget: () => void;
  } = $props();

  const canSwitch = $derived(ui.folder?.canSwitch ?? false);

  const filmsKey = $derived(`${group.path}#films`);
  const filmKey = (id: string) => `${group.path}#film:${id}`;
  const filmsOpen = $derived(filtering || (folds[filmsKey] ?? false));
  const filmOpen = (id: string) => filtering || (folds[filmKey(id)] ?? true);

  let noted = false;

  async function open(target?: OpenTarget): Promise<void> {
    const problem = await actions.openProject(group.path, group.name, target);
    noted = problem !== null;
    onnote(problem ? { text: problem, error: true } : null);
  }

  // The row says Not found by itself, so a note about the same folder goes.
  $effect(() => {
    if (!group.missing || !noted) return;
    noted = false;
    onnote(null);
  });

  function pick(row: GroupRow, e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (group.current) actions.selectScene(row.key);
    else void open({ scene: row.key });
    // Hand focus back so Space and the arrow keys drive playback again.
    e.currentTarget.blur();
  }

  function add(what: 'video' | 'scene'): void {
    if (group.current) ui.newRequest = what === 'video' ? { kind: 'video' } : { kind: 'scene', project: null };
    else void open({ new: what });
  }

  async function convert(id: string, name: string): Promise<void> {
    if (!canSwitch && !confirm(`Convert "${name}" into a project folder of its own, beside this one? The film here stays as it is.`)) return;
    onnote(null);
    onnote(await actions.convertFilm(id, group.current ? undefined : group.path));
  }

  const isOn = (row: GroupRow) => (ui.switching ? ui.switching.path === group.path && ui.switching.key === row.key : group.current && row.key === ui.selectedScene && !ui.home);
</script>

{#snippet sceneItem(row: GroupRow, poster: boolean)}
  <li>
    <button
      type="button"
      class="side-item"
      class:has-thumb={poster}
      class:is-invalid={row.invalid}
      data-key={row.key}
      aria-label={row.invalid ? `${row.label} (invalid)` : row.label}
      aria-current={isOn(row) ? 'page' : undefined}
      title={row.invalid ? `${row.file} (invalid: see the error panel)` : row.usedIn.length > 0 ? `${row.file}, used in ${row.usedIn.join(', ')}` : row.file}
      onclick={(e) => pick(row, e)}
    >
      {#if poster}<Thumb file={group.current ? ui.thumbs[row.key] : row.poster} project={group.current ? null : group.path} />{/if}
      <span class="name">{row.label}</span>
      {#if dots[row.key]}<span class="status-dot is-{dots[row.key].kind}" title={dots[row.key].label}></span>{/if}
      {#if row.main}<span class="badge">main</span>{/if}
      {#if row.invalid}<span class="badge">invalid</span>{/if}
    </button>
    {#if group.current && row.usedIn.length > 0 && row.key === ui.selectedScene && !ui.home}
      <p class="used-in">
        Used in
        {#each row.usedIn as key, i (key)}{#if i > 0}{', '}{/if}<button type="button" class="link-btn" onclick={() => actions.selectScene(key)}>{key}</button>{/each}
      </p>
    {/if}
  </li>
{/snippet}

<section class="project-group" aria-label={group.name}>
  <ProjectHead {group} {onfold} onadd={add} onforget={() => void actions.forgetProject(group.path).then(onforget)} />

  {#if group.open}
    <div class="project-body">
      {#if group.videos.length > 0}
        <section class="side-section" aria-label="Videos">
          <div class="side-label">Videos</div>
          <ul class="side-list">
            {#each group.videos as row (row.key)}{@render sceneItem(row, true)}{/each}
          </ul>
        </section>
      {/if}

      {#if group.current || group.scenes.length > 0}
        <section class="side-section" aria-label="Scenes">
          <div class="side-label">Scenes</div>
          {#if group.scenes.length === 0}
            <p class="side-empty">{filtering ? 'No matches.' : 'No scenes yet.'}</p>
          {:else}
            <ul class="side-list">
              {#each group.scenes as row (row.key)}{@render sceneItem(row, true)}{/each}
            </ul>
          {/if}
        </section>
      {/if}

      {#if !group.current && group.count === 0}
        <p class="side-empty">Nothing here yet. <button type="button" class="link-btn" onclick={() => open()}>Open</button></p>
      {/if}

      {#if group.films.length > 0}
        <section class="side-section" aria-label="Older films">
          <button type="button" class="side-label side-fold" aria-expanded={filmsOpen} title="Films made before compositions, in projects/" onclick={() => onfold(filmsKey, !filmsOpen)}>
            <span class="chevron" class:is-closed={!filmsOpen}><Icon name="chevronDown" /></span>
            Older films
          </button>
          {#if filmsOpen}
            <ul class="side-list">
              {#each group.films as film (film.id)}
                <li role="group" aria-label={film.name}>
                  <div class="film-row">
                    <button type="button" class="side-item" aria-expanded={filmOpen(film.id)} onclick={() => onfold(filmKey(film.id), !filmOpen(film.id))}>
                      <Icon name="project" />
                      <span class="name">{film.name}</span>
                      <span class="chevron" class:is-closed={!filmOpen(film.id)}><Icon name="chevronDown" /></span>
                    </button>
                    <button type="button" class="link-btn" title="Makes a project folder of its own, with the film as a composition" onclick={() => convert(film.id, film.name)}>Convert</button>
                  </div>
                  {#if filmOpen(film.id)}
                    <ul class="side-list side-children">
                      {#each film.rows as row (row.key)}{@render sceneItem(row, false)}{/each}
                    </ul>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</section>
