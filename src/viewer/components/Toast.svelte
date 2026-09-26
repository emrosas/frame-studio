<!-- An agent's turn just ended: say what it did, and offer View, which opens the thread and loops its range. -->
<script lang="ts">
  import type { Toast, ViewerActions } from '../ui.svelte';
  import Icon from './Icon.svelte';

  let { toast, actions, onview }: { toast: Toast | null; actions: ViewerActions; onview: () => void } = $props();
</script>

{#if toast}
  <div class="toast is-{toast.status}" role="status" aria-label="Request finished">
    <span class="status-dot" aria-hidden="true"></span>
    <span class="toast-text"><strong>#{toast.id} {toast.status}</strong>{toast.text ? `: ${toast.text}` : ''}</span>
    <button
      type="button"
      class="btn is-small"
      onclick={() => {
        actions.openThread(toast.id);
        actions.viewRequest(toast.id);
        actions.dismissToast();
        onview();
      }}>View</button
    >
    <button type="button" class="icon-btn is-small" aria-label="Dismiss" onclick={() => actions.dismissToast()}><Icon name="close" size={13} /></button>
  </div>
{/if}
