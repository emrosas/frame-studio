<!--
  One thread in the sidebar: its scene's poster with a status badge on the
  corner, the first prompt, then scene, model and time, then the status in
  words. The same card for the live queue and for a project read off disk.
  Colour, icon and word all say the status, so none of them has to alone.
-->
<script lang="ts" module>
  import type { IconName } from '../icons';
  import type { BadgeKind } from '../thread-groups';

  const ICON: Record<BadgeKind, IconName> = {
    pending: 'clock',
    working: 'working',
    input: 'attention',
    your_turn: 'message',
    done: 'check',
    stalled: 'clock',
    failed: 'close',
    interrupted: 'close',
    settled: 'check',
    cancelled: 'minus',
  };
</script>

<script lang="ts">
  import type { ThreadSummary } from '../../studio/protocol';
  import { agentIcon } from '../picker';
  import { ago, modelLabel, type ThreadBadge } from '../thread-groups';
  import type { ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import Thumb from './Thumb.svelte';

  let {
    ui,
    thread,
    badge,
    project,
    open,
    onopen,
  }: {
    ui: ViewerUi;
    thread: ThreadSummary;
    badge: ThreadBadge;
    /** The project's path when it isn't on screen, so the poster comes off disk. */
    project: string | null;
    open: boolean;
    onopen: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void;
  } = $props();

  const model = $derived(modelLabel(ui.studio.agents, thread.agent, thread.model));
</script>

<article aria-label="Request {thread.id}">
  <button type="button" class="thread-card is-{badge.kind}" aria-current={open ? 'true' : undefined} title={thread.title} onclick={onopen}>
    <span class="thread-poster">
      <Thumb file={thread.poster} {project} />
      <span class="thread-badge"><Icon name={ICON[badge.kind]} /></span>
    </span>
    <span class="thread-text">
      <span class="thread-title">{thread.title}</span>
      <span class="thread-meta">
        <span class="thread-scene">{thread.sceneId}</span>
        {#if model}
          <span aria-hidden="true">·</span>
          <span class="thread-model"><Icon name={agentIcon(thread.agent)} />{model}</span>
        {/if}
        <span aria-hidden="true">·</span>
        <span class="thread-time">{ago(thread.at, ui.studio.now)}</span>
      </span>
      <span class="thread-word">{badge.label}</span>
    </span>
  </button>
</article>
