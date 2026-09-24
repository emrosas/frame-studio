<!--
  The request panel (ADR 0003): write a prompt about the current selection,
  attach reference images, and send it to the agent's queue; then follow each
  request. Clicking a request brings its selection back. The files in
  .frame-studio/ are the truth; this only shows them.
-->
<script lang="ts">
  import { canRevert, describeTarget, displayStatus, MAX_REFERENCE_BYTES, REFERENCE_TYPES, type StudioRequest } from '../../studio/protocol';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const LABELS: Record<string, string> = {
    pending: 'waiting',
    in_progress: 'in progress',
    stalled: 'stalled',
    done: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
    reverted: 'reverted',
  };

  let prompt = $state('');
  let files = $state<{ file: File; url: string }[]>([]);
  let sending = $state(false);
  let status = $state<{ text: string; error: boolean } | null>(null);
  let retrying = $state<number | null>(null);
  let retryPrompt = $state('');
  let actionError = $state<string | null>(null);

  const sel = $derived(ui.selection);
  const target = $derived.by(() => {
    if (!sel.sceneId) return 'No valid scene';
    const what = sel.layer === '' ? (sel.range ? 'all layers' : 'the whole scene') : sel.layer;
    return `${sel.sceneId} · ${what}${sel.range ? ` · ${sel.rangeText?.interval ?? ''}` : ''}`;
  });
  const requests = $derived([...ui.studio.requests].reverse());
  const waiting = $derived(ui.studio.requests.filter((r) => r.status === 'pending').length);
  const finished = $derived(ui.studio.requests.filter((r) => !['pending', 'in_progress'].includes(r.status)).length);

  function describe(r: StudioRequest): string {
    const s = r.selection;
    return `${s.sceneId} · ${describeTarget(s)} · [${s.from}, ${s.to})${r.attempt && r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}`;
  }

  function addFiles(list: Iterable<File>): void {
    for (const file of list) {
      if (!(file.type in REFERENCE_TYPES)) {
        status = { text: `${file.name || 'That file'} is not a PNG, JPEG or WebP image.`, error: true };
        continue;
      }
      if (file.size > MAX_REFERENCE_BYTES) {
        status = { text: `${file.name} is over ${MAX_REFERENCE_BYTES / 1024 / 1024} MB.`, error: true };
        continue;
      }
      files.push({ file, url: URL.createObjectURL(file) });
    }
  }

  function removeFile(i: number): void {
    URL.revokeObjectURL(files[i].url);
    files.splice(i, 1);
  }

  async function send(): Promise<void> {
    if (!prompt.trim() || sending) return;
    sending = true;
    status = null;
    const result = await actions.sendRequest(prompt, files.map((f) => f.file));
    sending = false;
    if (!result.ok) {
      status = { text: result.error, error: true };
      return;
    }
    for (const f of files) URL.revokeObjectURL(f.url);
    files = [];
    prompt = '';
    status = {
      text: result.copied
        ? `Request #${result.id} queued. A line to paste into your agent is on the clipboard; in Claude Code, /frame-studio:next also works.`
        : `Request #${result.id} queued. In Claude Code run /frame-studio:next, or ask your agent to take the next Frame Studio request.`,
      error: false,
    };
  }

  async function act(id: number, action: 'cancel' | 'requeue' | 'revert' | 'retry', text?: string): Promise<void> {
    actionError = await actions.requestAction(id, action, text);
    if (!actionError && action === 'retry') retrying = null;
  }
</script>

<aside class="studio-panel" aria-label="Requests">
  <header class="studio-head">
    <h2>Requests</h2>
    {#if waiting > 0}<span class="studio-count">{waiting} waiting</span>{/if}
  </header>

  {#if !ui.studio.available}
    <p class="studio-note">Sending requests needs the studio server, which runs with <code>npm run dev</code>.</p>
  {:else}
    <section
      class="composer"
      aria-label="New request"
      ondragover={(e) => e.preventDefault()}
      ondrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer) addFiles(e.dataTransfer.files);
      }}
    >
      <div class="composer-target" title="What the request is about">{target}</div>
      <textarea
        class="composer-prompt"
        aria-label="Prompt"
        rows="3"
        placeholder="What should change? e.g. make pip look sad here"
        bind:value={prompt}
        onpaste={(e) => {
          const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
          if (images.length > 0) {
            e.preventDefault();
            addFiles(images);
          }
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      ></textarea>
      {#if files.length > 0}
        <ul class="composer-refs" aria-label="Reference images">
          {#each files as f, i (f.url)}
            <li>
              <img src={f.url} alt={f.file.name} />
              <button type="button" class="ref-remove" aria-label="Remove {f.file.name}" onclick={() => removeFile(i)}>×</button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="composer-row">
        <label class="attach">
          Attach image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onchange={(e) => {
              addFiles(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
            }}
          />
        </label>
        <button type="button" class="send" disabled={!prompt.trim() || sending || !sel.sceneId} onclick={send}>
          {sending ? 'Sending…' : 'Send to agent'}
        </button>
      </div>
      {#if status}<p class="composer-status" class:is-error={status.error} role="status">{status.text}</p>{/if}
    </section>

    <section class="queue" aria-label="Request queue">
      {#if ui.studio.error}<p class="studio-note is-error">{ui.studio.error}</p>{/if}
      {#if actionError}<p class="studio-note is-error" role="status">{actionError}</p>{/if}
      {#if requests.length === 0}
        <p class="studio-note">Requests you send show up here, with what the agent did.</p>
      {/if}
      {#each requests as r (r.id)}
        {@const shown = displayStatus(r, ui.studio.now)}
        <article class="request is-{shown}" aria-label="Request {r.id}">
          <button type="button" class="request-main" title="Show this selection" onclick={() => actions.restoreRequest(r.id)}>
            <span class="request-top"><span class="request-id">#{r.id}</span><span class="request-status">{LABELS[shown]}</span></span>
            <span class="request-prompt">{r.prompt}</span>
            <span class="request-meta">{describe(r)}</span>
            {#if r.summary}<span class="request-summary">{r.summary}</span>{/if}
          </button>
          <div class="request-actions">
            {#if shown === 'pending' || shown === 'stalled'}
              <button type="button" onclick={() => act(r.id, 'cancel')}>Cancel</button>
            {/if}
            {#if shown === 'stalled' || shown === 'failed'}
              <button type="button" onclick={() => act(r.id, 'requeue')}>Requeue</button>
            {/if}
            {#if shown === 'done' || shown === 'failed'}
              <button type="button" onclick={() => actions.viewRequest(r.id)}>View</button>
              {#if canRevert(r, ui.studio.requests)}
                <button type="button" onclick={() => act(r.id, 'revert')}>Revert</button>
                <button
                  type="button"
                  onclick={() => {
                    retrying = r.id;
                    retryPrompt = r.prompt;
                  }}>Try again</button
                >
              {/if}
            {/if}
          </div>
          {#if retrying === r.id}
            <div class="retry">
              <textarea aria-label="Prompt for the next attempt" rows="2" bind:value={retryPrompt}></textarea>
              <div class="composer-row">
                <button type="button" onclick={() => (retrying = null)}>Cancel</button>
                <button type="button" class="send" disabled={!retryPrompt.trim()} onclick={() => act(r.id, 'retry', retryPrompt)}>
                  Revert and queue attempt {(r.attempt ?? 1) + 1}
                </button>
              </div>
            </div>
          {/if}
        </article>
      {/each}
      {#if finished > 0}
        <button type="button" class="clear-finished" onclick={() => actions.clearFinished()}>Clear finished</button>
      {/if}
    </section>
  {/if}
</aside>
