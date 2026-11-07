<!--
  One project in the sidebar's Threads view: the same header as Footage, its
  threads as cards, newest first, and the settled ones under a quiet Done fold.
  Clicking a card opens the thread: here, or in another project by switching
  to it, on that scene and thread.
-->
<script lang="ts">
  import type { ThreadSummary } from '../../studio/protocol';
  import { isSeen, threadBadge, type ThreadGroup } from '../thread-groups';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import ProjectHead from './ProjectHead.svelte';
  import ThreadCard from './ThreadCard.svelte';

  let {
    group,
    ui,
    actions,
    onfold,
    onnote,
    onforget,
  }: {
    group: ThreadGroup;
    ui: ViewerUi;
    actions: ViewerActions;
    onfold: (key: string, open: boolean) => void;
    onnote: (note: { text: string; error: boolean } | null) => void;
    onforget: () => void;
  } = $props();

  const isOpen = (t: ThreadSummary) => (ui.switching ? ui.switching.path === group.path && ui.switching.thread === t.id : group.current && ui.studio.open === t.id);

  async function pick(t: ThreadSummary, e: MouseEvent & { currentTarget: HTMLButtonElement }): Promise<void> {
    // Hand focus back so Space and the arrow keys drive playback again.
    e.currentTarget.blur();
    if (group.current) {
      ui.layout.panel = true;
      actions.openThread(t.id);
      return;
    }
    const problem = await actions.openProject(group.path, group.name, { scene: t.sceneId, thread: t.id });
    onnote(problem ? { text: problem, error: true } : null);
  }

  async function add(what: 'video' | 'scene'): Promise<void> {
    if (group.current) ui.newRequest = what === 'video' ? { kind: 'video' } : { kind: 'scene', project: null };
    else onnote(await actions.openProject(group.path, group.name, { new: what }).then((problem) => (problem ? { text: problem, error: true } : null)));
  }
</script>

{#snippet cards(threads: readonly ThreadSummary[])}
  <ul class="thread-cards">
    {#each threads as t (t.id)}
      {@const open = isOpen(t)}
      <li><ThreadCard {ui} thread={t} badge={threadBadge(t, !open && isSeen(ui.threadsSeen, group.path, t))} project={group.current ? null : group.path} {open} onopen={(e) => void pick(t, e)} /></li>
    {/each}
  </ul>
{/snippet}

<section class="project-group" aria-label={group.name}>
  <ProjectHead {group} {onfold} onadd={(what) => void add(what)} onforget={() => void actions.forgetProject(group.path).then(onforget)} />
  {#if group.open}
    <div class="project-body">
      {#if group.threads.length > 0}
        {@render cards(group.threads)}
      {:else if group.done.length === 0}
        <p class="side-empty">No threads yet.</p>
      {/if}
      {#if group.done.length > 0}
        <section class="side-section" aria-label="Done">
          <div class="done-head">
            <button type="button" class="side-label side-fold" aria-expanded={group.doneOpen} onclick={() => onfold(`${group.path}#done`, !group.doneOpen)}>
              <span class="chevron" class:is-closed={!group.doneOpen}><Icon name="chevronDown" /></span>
              Done
            </button>
            {#if group.current}<button type="button" class="link-btn" onclick={() => actions.clearFinished()}>Clear settled</button>{/if}
          </div>
          {#if group.doneOpen}{@render cards(group.done)}{/if}
        </section>
      {/if}
    </div>
  {/if}
</section>
