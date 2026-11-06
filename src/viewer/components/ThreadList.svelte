<!--
  The threads, at the top of the agent panel, newest first, with New thread and
  a badge for the ones waiting on you. It shows this scene's threads and any
  that stopped on a question, and All shows the rest. Clicking one opens it
  below. The list folds out of the way, and the head keeps the badge.
-->
<script lang="ts">
  import { currentTurn, displayStatus, type StudioRequest } from '../../studio/protocol';
  import { STATUS_LABELS } from '../transcript';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const all = $derived([...ui.studio.requests].reverse());
  // This scene's threads, the one that's open, and any agent stopped on a question, wherever it is.
  const here = $derived(all.filter((r) => r.sceneId === ui.selectedScene || r.id === ui.studio.open || displayStatus(r, ui.studio.now) === 'input'));
  const threads = $derived(ui.layout.allThreads ? all : here);
  const elsewhere = $derived(here.length < all.length);
  // Waiting for you: a turn to answer, or a question card or approval in a working turn.
  const yours = $derived(threads.filter((r) => r.status === 'your_turn' || displayStatus(r, ui.studio.now) === 'input').length);
  const finished = $derived(ui.studio.requests.filter((r) => r.status === 'settled' || r.status === 'cancelled').length);

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
    return [STATUS_LABELS[shown], ui.layout.allThreads ? r.sceneId : '', when].filter(Boolean).join(' · ');
  }
</script>

<section class="threads" aria-label="Threads">
  <header class="panel-head">
    {#if all.length > 0}
      <button type="button" class="threads-toggle" aria-expanded={ui.layout.threads} onclick={() => (ui.layout.threads = !ui.layout.threads)}>
        <span class="chevron" class:is-closed={!ui.layout.threads}><Icon name="chevronDown" /></span>
        Threads
      </button>
    {:else}
      <span class="panel-title">Agent</span>
    {/if}
    {#if yours > 0}<span class="count" title="{yours} waiting for you">{yours}</span>{/if}
    <div class="actions">
      {#if elsewhere && ui.layout.threads}
        <button type="button" class="link-btn" aria-pressed={ui.layout.allThreads} title="Show the threads of every scene" onclick={() => (ui.layout.allThreads = !ui.layout.allThreads)}>All</button>
      {/if}
      {#if finished > 0 && ui.layout.threads}<button type="button" class="link-btn" onclick={() => actions.clearFinished()}>Clear settled</button>{/if}
      <button type="button" class="icon-btn" aria-label="New thread" title="New thread" aria-current={ui.studio.open === null ? 'true' : undefined} onclick={() => actions.openThread(null)}><Icon name="plus" /></button>
    </div>
  </header>
  {#if ui.studio.error}<p class="side-empty panel-note is-error">{ui.studio.error}</p>{/if}
  {#if threads.length > 0 && ui.layout.threads}
    <ul class="side-list thread-list">
      {#each threads as r (r.id)}
        {@const shown = displayStatus(r, ui.studio.now)}
        <li>
          <article aria-label="Request {r.id}">
            <button type="button" class="side-item thread-item is-{shown}" aria-current={ui.studio.open === r.id ? 'true' : undefined} title={r.turns[0].ask.prompt} onclick={() => actions.openThread(r.id)}>
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
