<!--
  The dock under a still (ADR 0022). A still has no timeline, so this is what
  it has instead: the slides of its carousel in the order they are swiped,
  with the one on screen marked. A click opens a slide, Left and Right step
  through them, a drag moves a slide to another place, and the buttons add a
  slide, take this one out, and ungroup. A still in no carousel offers to
  start one. Reordering saves through the studio server, into project.json.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Thumb from './Thumb.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const carousel = $derived(ui.carousel);
  const sizeOf = (key: string) => ui.scenes.find((s) => s.key === key)?.format?.size ?? [4, 5];
  let note = $state<string | null>(null);
  let dragged = $state<string | null>(null);
  let over = $state<number | null>(null);

  async function run(work: () => Promise<string | null>): Promise<void> {
    note = await work();
  }

  function drop(to: number): void {
    const scene = dragged;
    dragged = null;
    over = null;
    if (!carousel || scene === null) return;
    const from = carousel.slides.indexOf(scene);
    if (from < 0 || from === to) return;
    void run(() => actions.editCarousel({ op: 'move', carousel: carousel.id, scene, to }));
  }
</script>

<div class="still-strip" role="group" aria-label={carousel ? `Carousel ${carousel.id}` : 'Carousel'}>
  {#if carousel}
    <span class="strip-name" title="Carousel {carousel.id}: exported in this order">{carousel.id}</span>
    <ol class="strip-slides">
      {#each carousel.slides as key, i (key)}
        {@const size = sizeOf(key)}
        <li class:is-over={over === i && dragged !== null && dragged !== key}>
          <button
            type="button"
            class="strip-slide"
            class:is-on={i === carousel.index}
            aria-current={i === carousel.index ? 'true' : undefined}
            aria-label="Slide {i + 1} of {carousel.slides.length}, {key}"
            title="{i + 1}. {key}. Drag to reorder."
            draggable="true"
            style="aspect-ratio: {size[0]} / {size[1]}"
            ondragstart={(e) => {
              dragged = key;
              e.dataTransfer?.setData('text/plain', key);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }}
            ondragend={() => {
              dragged = null;
              over = null;
            }}
            ondragover={(e) => {
              if (dragged === null) return;
              e.preventDefault();
              over = i;
            }}
            ondrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              drop(i);
            }}
            onclick={(e) => {
              actions.selectScene(key);
              e.currentTarget.blur();
            }}
          >
            <Thumb file={ui.thumbs[key]} />
            <span class="strip-number">{i + 1}</span>
          </button>
        </li>
      {/each}
    </ol>
    <button type="button" class="icon-btn" aria-label="Add a slide" title="Add an empty slide at the end" onclick={() => run(() => actions.addSlide(carousel.id))}><Icon name="plus" /></button>
    <span class="strip-count">{carousel.index + 1} of {carousel.slides.length}</span>
    <button
      type="button"
      class="btn is-ghost is-small"
      title="Take this still out of the carousel. The still stays in the project."
      onclick={() => run(() => actions.editCarousel({ op: 'remove', carousel: carousel.id, scene: carousel.slides[carousel.index] }))}>Remove slide</button
    >
  {:else}
    <span class="strip-hint">This still is on its own.</span>
    <button type="button" class="btn is-small" title="Group stills as a post that is swiped through. Add slides to it here." onclick={() => run(() => actions.startCarousel())}>Start a carousel</button>
    {#if ui.carousels.length > 0}
      <label class="strip-join">
        or add it to
        <select
          aria-label="Add to a carousel"
          onchange={(e) => {
            const id = e.currentTarget.value;
            e.currentTarget.value = '';
            if (id && ui.selection.sceneId) void run(() => actions.editCarousel({ op: 'add', carousel: id, scene: ui.selection.sceneId! }));
          }}
        >
          <option value="">a carousel…</option>
          {#each ui.carousels as c (c.id)}<option value={c.id}>{c.id}</option>{/each}
        </select>
      </label>
    {/if}
  {/if}
  {#if note}<span class="strip-note" role="alert">{note}</span>{/if}
</div>
