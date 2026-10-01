<!--
  An agent's turn just ended: say what it did, and offer View, which opens the
  thread and loops its range. Or an agent waits on the user, with a question
  card or an approval in a thread that isn't showing: Answer opens it.
-->
<script lang="ts">
  import type { Toast, ViewerActions } from '../ui.svelte';
  import Icon from './Icon.svelte';

  let { toast, actions, onview }: { toast: Toast | null; actions: ViewerActions; onview: () => void } = $props();
</script>

{#if toast}
  {@const asking = toast.status === 'asking'}
  <div class="toast is-{toast.status}" role="status" aria-label={asking ? 'Agent waits for you' : 'Request finished'}>
    <span class="status-dot" aria-hidden="true"></span>
    <span class="toast-text"><strong>#{toast.id} {asking ? 'needs you' : toast.status}</strong>{toast.text ? `: ${toast.text}` : ''}</span>
    <button
      type="button"
      class="btn is-small"
      onclick={() => {
        actions.openThread(toast.id);
        if (!asking) actions.viewRequest(toast.id);
        actions.dismissToast();
        onview();
      }}>{asking ? 'Answer' : 'View'}</button
    >
    <button type="button" class="icon-btn is-small" aria-label="Dismiss" onclick={() => actions.dismissToast()}><Icon name="close" size={13} /></button>
  </div>
{/if}
