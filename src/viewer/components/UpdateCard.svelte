<!--
  The app's update (ADR 0009), at the foot of the sidebar: a new version with
  Update, its download, the restart, or why it failed. Where the app can't
  replace itself (not in a writable folder), it links the release instead.
-->
<script lang="ts">
  import type { UpdateState } from '../desktop';
  import type { ViewerActions } from '../ui.svelte';

  let { update, actions }: { update: UpdateState; actions: ViewerActions } = $props();

  const percent = $derived(update.status === 'downloading' && update.total > 0 ? Math.round((update.done / update.total) * 100) : 0);
</script>

<div class="update-card" class:is-error={update.status === 'error'} role="status" aria-label="Update">
  {#if update.status === 'available'}
    <strong>Frame Studio {update.version}</strong>
    <p>A new version is ready. It installs in place and restarts the app.</p>
    <div class="row">
      <button type="button" class="btn is-primary is-small" onclick={() => actions.installUpdate()}>Update</button>
      <button type="button" class="btn is-ghost is-small" onclick={() => actions.openUpdateNotes()}>What's new</button>
    </div>
  {:else if update.status === 'downloading'}
    <strong>Downloading {update.version}</strong>
    <progress max="100" value={percent} aria-label="Update download"></progress>
    <p>{percent}%. Frame Studio restarts when it's done.</p>
  {:else if update.status === 'restarting'}
    <strong>Restarting</strong>
    <p>Installing Frame Studio {update.version}…</p>
  {:else if update.status === 'error'}
    <strong>{update.version ? `Couldn't update to ${update.version}` : "Couldn't check for updates"}</strong>
    <p>{update.message}</p>
    <div class="row">
      {#if update.manual && update.notes}
        <button type="button" class="btn is-small" onclick={() => actions.openUpdateNotes()}>Release page</button>
      {:else if update.version}
        <button type="button" class="btn is-small" onclick={() => actions.installUpdate()}>Try again</button>
      {:else}
        <button type="button" class="btn is-small" onclick={() => actions.checkForUpdate()}>Check again</button>
      {/if}
    </div>
  {/if}
</div>
