<!--
  The project's home, over the stage: videos and scenes as poster cards, then
  the project's sound files and what it has rendered. It's where a project
  opens with nothing selected, and the way back from any scene. The stage stays
  mounted under it, paused. Films made before compositions shrink to a row
  each, with Convert.
-->
<script lang="ts">
  import { desktop } from '../desktop';
  import type { RenderItem, SceneOption, ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Thumb from './Thumb.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const desktopApp = desktop() !== null;

  const videos = $derived(ui.scenes.filter((s) => s.film === null && s.kind === 'composition'));
  const scenes = $derived(ui.scenes.filter((s) => s.film === null && s.kind === 'scene'));
  const films = $derived.by(() => {
    const groups: { id: string; name: string; first: string; count: number }[] = [];
    for (const option of ui.scenes) {
      if (option.film === null) continue;
      const last = groups.at(-1);
      if (last && last.id === option.film) last.count++;
      else groups.push({ id: option.film, name: option.group ?? option.film, first: option.key, count: 1 });
    }
    return groups;
  });
  const projectName = $derived(ui.folder ? (ui.folder.path.split(/[\\/]/).filter(Boolean).pop() ?? ui.folder.path) : 'Project');
  const counted = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  /** "9:16" for the usual shapes, else the size. */
  function shape(size: readonly [number, number]): string {
    const [w, h] = size;
    if (w * 16 === h * 9) return '9:16';
    if (w * 9 === h * 16) return '16:9';
    if (w === h) return '1:1';
    return `${w}×${h}`;
  }

  /** "2:05" from a minute up, "4.5 s" under it. */
  function length(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds * 10) / 10} s`;
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }

  function details(option: SceneOption): string {
    const f = option.format;
    if (!f) return 'Has errors';
    return [shape(f.size), length(f.seconds), ...(f.pixel ? ['Pixel'] : [])].join(' · ');
  }

  function bytes(n: number): string {
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function ago(ms: number): string {
    const s = Math.max(0, (ui.studio.now - ms) / 1000);
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  const renderUrl = (r: RenderItem) => `/__studio/renders/${r.file.split('/').map(encodeURIComponent).join('/')}`;
  const renderName = (r: RenderItem) => r.file.slice(r.file.lastIndexOf('/') + 1);
  const renderType = (r: RenderItem) => r.file.slice(r.file.lastIndexOf('.') + 1).toUpperCase();

  // Sound files (ADR 0012): import by picker, list, and place at the playhead.
  let picker = $state<HTMLInputElement | null>(null);
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
    if (!desktopApp && !confirm(`Convert "${name}" into a project folder of its own, beside this one? The film here stays as it is.`)) return;
    convertNote = null;
    convertNote = await actions.convertFilm(id);
  }
</script>

{#snippet card(option: SceneOption)}
  <li>
    <button
      type="button"
      class="lib-card"
      class:is-invalid={option.invalid}
      data-key={option.key}
      aria-label={option.invalid ? `${option.label} (invalid)` : option.label}
      title={option.usedIn.length > 0 ? `${option.file}, used in ${option.usedIn.join(', ')}` : option.file}
      onclick={() => actions.selectScene(option.key)}
    >
      <span class="lib-poster"><Thumb file={ui.thumbs[option.key]} /></span>
      <span class="lib-name">{option.label}</span>
      <span class="lib-meta">{details(option)}</span>
    </button>
  </li>
{/snippet}

<section class="library" aria-label="Library">
  <header class="lib-head">
    <div>
      <h1>{projectName}</h1>
      <p>{counted(videos.length, 'video')}, {counted(scenes.length, 'scene')}</p>
    </div>
    {#if ui.header && ui.homeReturn}
      <button type="button" class="btn is-ghost" aria-label="Back to {ui.header.name}" title="Back to {ui.header.key} (Esc)" onclick={() => actions.showHome(false)}>
        <Icon name="back" />{ui.header.name}
      </button>
    {/if}
  </header>

  {#if ui.emptyProject}
    <div class="lib-empty">
      <h2>Nothing here yet</h2>
      <p>Start a video and describe what happens. An agent draws it, you point at what to change. Sound files can come in any time.</p>
      <div class="lib-empty-actions">
        <button type="button" class="btn is-primary" onclick={() => (ui.newRequest = { kind: 'video' })}>New video</button>
        <button type="button" class="btn" onclick={() => (ui.newRequest = { kind: 'scene', project: null })}>New scene</button>
      </div>
    </div>
  {:else}
    <section class="lib-section" aria-label="Videos">
      <h2>Videos</h2>
      {#if videos.length === 0}
        <p class="lib-hint">No videos yet. A video arranges scenes on tracks. Start one with New video.</p>
      {:else}
        <ul class="lib-grid">
          {#each videos as option (option.key)}{@render card(option)}{/each}
        </ul>
      {/if}
    </section>

    <section class="lib-section" aria-label="Scenes">
      <h2>Scenes</h2>
      {#if scenes.length === 0}
        <p class="lib-hint">No scenes yet.</p>
      {:else}
        <ul class="lib-grid">
          {#each scenes as option (option.key)}{@render card(option)}{/each}
        </ul>
      {/if}
    </section>
  {/if}

  <section class="lib-section" aria-label="Media">
    <h2>
      Media
      <button type="button" class="btn is-small" aria-label="Import media" title="Import sound, video and images (or drop them anywhere)" onclick={() => picker?.click()}>Import</button>
    </h2>
    <input bind:this={picker} type="file" accept="audio/*,video/*,image/png,image/jpeg,image/webp,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.mov,.mp4" multiple hidden onchange={(e) => importPicked(e.currentTarget.files)} />
    {#if ui.mediaNote}<p class="lib-hint panel-note" class:is-error={ui.mediaNote.error} role="status">{ui.mediaNote.text}</p>{/if}
    {#if ui.media.length === 0}
      <p class="lib-hint">No media yet. Drop voiceover, music, video or images anywhere in the window.</p>
    {:else}
      <ul class="lib-rows">
        {#each ui.media as item (item.file)}
          <li>
            <Icon name="volume" />
            <span class="lib-row-name" title={item.file}>{item.name}</span>
            {#if item.duration !== undefined}<span class="media-length">{length(item.duration)}</span>{/if}
            <button
              type="button"
              class="btn is-small is-ghost"
              aria-label="Add {item.name} at the playhead"
              title={ui.header ? `Adds it to ${ui.header.name} at the playhead` : 'Open a scene first'}
              disabled={ui.selection.sceneId === null}
              onclick={() => place(item.file)}>Add at playhead</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="lib-section" aria-label="Renders">
    <h2>Renders</h2>
    {#if ui.renders.length === 0}
      <p class="lib-hint">Nothing rendered yet. Export writes files here.</p>
    {:else}
      <ul class="lib-grid is-renders">
        {#each ui.renders as render (render.file)}
          <li>
            <a class="lib-card" href={renderUrl(render)} target="_blank" rel="noopener" title={render.file}>
              <span class="lib-poster">
                {#if render.kind === 'video'}
                  <video src="{renderUrl(render)}#t=0.1" muted playsinline preload="metadata" aria-hidden="true"></video>
                {:else if render.kind === 'image'}
                  <img src={renderUrl(render)} alt="" loading="lazy" />
                {:else}
                  <span class="lib-page"><Icon name="page" /></span>
                {/if}
              </span>
              <span class="lib-name">{renderName(render)}</span>
              <span class="lib-meta">{renderType(render)} · {bytes(render.bytes)} · {ago(render.modified)}</span>
            </a>
            {#if desktopApp}<button type="button" class="link-btn lib-reveal" onclick={() => actions.revealRender(render.path)}>Reveal in Finder</button>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if films.length > 0}
    <section class="lib-section" aria-label="Older films">
      <h2>Older films</h2>
      {#if convertNote}<p class="lib-hint panel-note" class:is-error={convertNote.error} role="status">{convertNote.text}</p>{/if}
      <ul class="lib-rows">
        {#each films as film (film.id)}
          <li>
            <Icon name="project" />
            <button type="button" class="link-btn lib-row-name" onclick={() => actions.selectScene(film.first)}>{film.name}</button>
            <span class="media-length">{counted(film.count, 'scene')}</span>
            <button type="button" class="btn is-small is-ghost" title="Makes a project folder of its own, with the film as a composition" onclick={() => convert(film.id, film.name)}>Convert…</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>
