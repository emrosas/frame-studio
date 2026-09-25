<!-- An agent's turn just ended: say what it did, and offer View, which opens the thread and loops its range. -->
<script lang="ts">
  import type { Toast, ViewerActions } from '../ui.svelte';

  let { toast, actions }: { toast: Toast | null; actions: ViewerActions } = $props();
</script>

{#if toast}
  <div class="toast is-{toast.status}" role="status" aria-label="Request finished">
    <span class="toast-text"><strong>#{toast.id} {toast.status}</strong>{toast.text ? `: ${toast.text}` : ''}</span>
    <button
      type="button"
      class="toast-view"
      onclick={() => {
        actions.openThread(toast.id);
        actions.viewRequest(toast.id);
        actions.dismissToast();
      }}>View</button
    >
    <button type="button" class="toast-close" aria-label="Dismiss" onclick={() => actions.dismissToast()}>×</button>
  </div>
{/if}
