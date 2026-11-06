<!--
  A project's header row, the same in Footage and Threads: its name, what its
  threads ask for, what the fold hides, and a + on hover. Clicking it only
  folds it.
-->
<script lang="ts">
  import type { GroupStatus } from '../project-groups';
  import Icon from './Icon.svelte';
  import Popover from './Popover.svelte';

  let {
    group,
    onfold,
    onadd,
    onforget,
  }: {
    group: { path: string; name: string; missing: boolean; open: boolean; status: GroupStatus | null; count: number };
    onfold: (key: string, open: boolean) => void;
    onadd: (what: 'video' | 'scene') => void;
    onforget: () => void;
  } = $props();

  let adding = $state(false);
  let addBox = $state<HTMLElement | null>(null);

  function add(what: 'video' | 'scene'): void {
    adding = false;
    onadd(what);
  }
</script>

<div class="project-head" class:is-open={group.open} class:is-missing={group.missing}>
  <button type="button" class="project-row" aria-expanded={group.open} disabled={group.missing} title={group.missing ? `${group.path} is gone` : group.path} onclick={() => onfold(group.path, !group.open)}>
    <Icon name="folder" />
    <span class="name">{group.name}</span>
    {#if group.status}<span class="status-dot is-{group.status.kind}" role="img" aria-label={group.status.label} title={group.status.label}></span>{/if}
    {#if !group.missing && !group.open && group.count > 0}<span class="count">{group.count}</span>{/if}
    {#if !group.missing}<span class="chevron" class:is-closed={!group.open}><Icon name="chevronDown" /></span>{/if}
  </button>
  {#if group.missing}
    <span class="project-gone">Not found</span>
    <button type="button" class="link-btn" title="Take {group.name} off this list. Nothing on disk changes." onclick={onforget}>Forget</button>
  {:else}
    <div class="anchor" bind:this={addBox}>
      <button type="button" class="project-add icon-btn" aria-label="New in {group.name}" title="New in {group.name}" aria-haspopup="menu" aria-expanded={adding} onclick={() => (adding = !adding)}><Icon name="plus" /></button>
      {#if adding}
        <Popover label="New in {group.name}" role="menu" class="add-menu" anchor={addBox} onclose={() => (adding = false)}>
          <button type="button" role="menuitem" class="menu-item" onclick={() => add('video')}>New video</button>
          <button type="button" role="menuitem" class="menu-item" onclick={() => add('scene')}>New scene</button>
        </Popover>
      {/if}
    </div>
  {/if}
</div>
