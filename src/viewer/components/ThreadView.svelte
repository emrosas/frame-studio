<!--
  One thread (ADR 0006): each turn's ask, what the agent did (streamed text,
  steps, the frames it rendered, approval cards) and how it ended, with
  "Revert to here" on each finished turn. Below, what you can do now: stop a
  working turn, reply, settle, try again. The files in .frame-studio/ are the
  truth; this only shows them.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import {
    canRevert,
    clipboardLine,
    currentTurn,
    describeTarget,
    displayStatus,
    firstRevertableTurn,
    isReferencePath,
    type StudioRequest,
    type Turn,
    type TurnSettings,
  } from '../../studio/protocol';
  import { describeUsage, foldTurn } from '../transcript';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import AgentPicker from './AgentPicker.svelte';
  import PromptBox from './PromptBox.svelte';

  let { ui, actions, thread }: { ui: ViewerUi; actions: ViewerActions; thread: StudioRequest } = $props();

  const THREAD_LABELS: Record<string, string> = {
    pending: 'waiting for the agent',
    working: 'working',
    your_turn: 'your turn',
    settled: 'settled',
    cancelled: 'cancelled',
    stalled: 'stalled',
  };
  const TURN_LABELS: Record<Turn['status'], string> = {
    pending: 'waiting for the agent',
    working: 'working…',
    done: 'done',
    failed: 'failed',
    stopped: 'stopped',
    interrupted: 'interrupted',
    cancelled: 'cancelled',
    reverted: 'reverted',
  };

  let reply = $state('');
  let files = $state<{ file: File; url: string }[]>([]);
  let problem = $state<string | null>(null);
  let busy = $state(false);
  let retrying = $state(false);
  let stopFailed = $state(false);
  // Replies start from the newest turn's settings; they can change between turns. The panel keys this
  // component on the thread, so it starts fresh for each thread.
  const initial = untrack(() => currentTurn(thread).settings);
  let settings = $state<TurnSettings>({
    access: initial?.access ?? 'studio',
    ...(initial?.model ? { model: initial.model } : {}),
    ...(initial?.effort ? { effort: initial.effort } : {}),
  });

  const shown = $derived(displayStatus(thread, ui.studio.now));
  const external = $derived(thread.agent === 'external');
  const agentLabel = $derived(ui.studio.agents.find((a) => a.id === thread.agent)?.label ?? thread.agent);
  const agentReady = $derived(external || (ui.studio.agents.find((a) => a.id === thread.agent)?.ready ?? false));
  const canReply = $derived(thread.status === 'your_turn' || thread.status === 'settled' || thread.status === 'cancelled');
  const lastCounted = $derived.by(() => {
    for (let k = thread.turns.length - 1; k >= 0; k--) if (thread.turns[k].status !== 'reverted' && thread.turns[k].status !== 'cancelled') return k;
    return -1;
  });
  const canRevertAll = $derived(thread.status === 'settled' && firstRevertableTurn(thread, ui.studio.requests) !== null);
  // Try again reverts the newest turn first, so it is offered only when that revert is allowed.
  const canRetry = $derived(
    lastCounted >= 0 &&
      thread.status !== 'cancelled' &&
      (!thread.turns[lastCounted].checkpointAt || canRevert(thread, lastCounted, ui.studio.requests)),
  );

  const frameUrl = (turn: number, file: string) => `/__studio/requests/${thread.id}/turns/${turn}/frames/${encodeURIComponent(file)}`;
  const range = (t: Turn) => `[${t.ask.selection.from}, ${t.ask.selection.to})`;
  const settingsText = (s: TurnSettings | undefined) =>
    s ? [s.model, s.effort, s.access === 'full' ? 'full access' : null].filter(Boolean).join(' · ') : '';

  async function run(call: () => Promise<string | null>): Promise<boolean> {
    busy = true;
    problem = await call();
    busy = false;
    return problem === null;
  }

  async function send(): Promise<void> {
    if (!reply.trim() || busy) return;
    const chosen = external ? undefined : $state.snapshot(settings);
    const ok = retrying
      ? await run(() => actions.retry(thread.id, reply, files.map((f) => f.file), chosen))
      : await run(() => actions.reply(thread.id, reply, files.map((f) => f.file), chosen));
    if (!ok) return;
    for (const f of files) URL.revokeObjectURL(f.url);
    files = [];
    reply = '';
    retrying = false;
  }
</script>

<section class="thread" aria-label="Request {thread.id}">
  <header class="thread-head">
    <button type="button" class="back" aria-label="Back to requests" onclick={() => actions.openThread(null)}>←</button>
    <span class="thread-title">#{thread.id} · {agentLabel}</span>
    <span class="thread-status is-{shown}" role="status" aria-label="Request status">{THREAD_LABELS[shown]}</span>
  </header>

  <ol class="turns">
    {#each thread.turns as turn, k (k)}
      {@const transcript = foldTurn(ui.turnEvents[`${thread.id}:${k}`] ?? [])}
      <li class="turn is-{turn.status}" aria-label="Turn {k + 1}">
        <div class="ask">
          <p class="ask-prompt">{turn.ask.prompt}</p>
          <p class="ask-meta">
            {describeTarget(turn.ask.selection)} · {range(turn)}{turn.attempt && turn.attempt > 1 ? ` · attempt ${turn.attempt}` : ''}{settingsText(turn.settings) ? ` · ${settingsText(turn.settings)}` : ''}
          </p>
          {#if turn.ask.references.length > 0}
            <ul class="composer-refs" aria-label="Reference images">
              {#each turn.ask.references.filter(isReferencePath) as ref (ref)}<li><img src="/{ref}" alt={ref} /></li>{/each}
            </ul>
          {/if}
        </div>

        <div class="work">
          {#each transcript.items as item, i (i)}
            {#if item.kind === 'text'}
              <p class="work-text">{item.text}</p>
            {:else if item.kind === 'step'}
              <p class="work-step is-{item.status}" title={item.detail ?? ''}>{item.label}</p>
            {:else if item.kind === 'frames'}
              <div class="work-frames">
                {#each item.frames as f (f.file)}
                  <button type="button" class="thumb" title="Show frame {f.frame}" onclick={() => actions.showFrame(thread.id, f.frame)}>
                    <img src={frameUrl(k, f.file)} alt="Frame {f.frame}" />
                    <span>{f.frame}</span>
                  </button>
                {/each}
              </div>
            {:else if item.kind === 'approval'}
              <div class="approval" class:is-open={item.decision === null} role="group" aria-label="Approval: {item.summary}">
                <p class="approval-summary">{item.summary}</p>
                {#if item.detail}<p class="approval-detail">{item.detail}</p>{/if}
                {#if item.decision === null && (turn.status === 'working' || turn.status === 'pending')}
                  <div class="composer-row">
                    <button type="button" disabled={busy} onclick={() => run(() => actions.respond(thread.id, item.id, 'decline'))}>Decline</button>
                    <button type="button" class="send" disabled={busy} onclick={() => run(() => actions.respond(thread.id, item.id, 'accept'))}>Allow</button>
                  </div>
                {:else}
                  <p class="approval-answer">{item.decision === 'accept' ? 'Allowed' : item.decision === 'decline' ? 'Declined' : 'Not answered before the turn ended'}</p>
                {/if}
              </div>
            {:else}
              <p class="work-note" class:is-error={item.error}>{item.text}</p>
            {/if}
          {/each}
        </div>

        <footer class="turn-foot">
          <span class="turn-status">{TURN_LABELS[turn.status]}</span>
          {#if external && turn.summary}<span class="turn-summary">{turn.summary}</span>{/if}
          {#if !external && turn.summary && transcript.items.length === 0}<span class="turn-summary">{turn.summary}</span>{/if}
          {#if transcript.usage}<span class="turn-usage">{describeUsage(transcript.usage)}</span>{/if}
          {#if turn.checkpointAt && canRevert(thread, k, ui.studio.requests)}
            <button type="button" aria-label="Revert to before turn {k + 1}" onclick={() => run(() => actions.revert(thread.id, k))}>Revert to here</button>
          {/if}
        </footer>
      </li>
    {/each}
  </ol>

  <footer class="thread-actions">
    {#if problem}<p class="studio-note is-error" role="status">{problem}</p>{/if}
    {#if thread.status === 'working'}
      {#if external}
        {#if shown === 'stalled'}<button type="button" onclick={() => run(() => actions.requestAction(thread.id, 'requeue'))}>Requeue</button>{/if}
        <button type="button" onclick={() => run(() => actions.requestAction(thread.id, 'cancel'))}>Cancel</button>
      {:else}
        <button type="button" class="stop" onclick={async () => (stopFailed = !(await run(() => actions.requestAction(thread.id, 'stop'))))}>Stop</button>
        <!-- Stop works only on a turn this studio server runs; Cancel ends the turn whoever has it. -->
        {#if stopFailed}<button type="button" onclick={() => run(() => actions.requestAction(thread.id, 'cancel'))}>Cancel</button>{/if}
      {/if}
    {:else if thread.status === 'pending'}
      {#if !agentReady}<p class="studio-note" role="status">{agentLabel} isn't ready, so this waits. Pick it in a new request to see why.</p>{/if}
      <button type="button" onclick={() => run(() => actions.requestAction(thread.id, 'cancel'))}>Cancel</button>
      {#if external}
        <button type="button" onclick={() => navigator.clipboard.writeText(clipboardLine(thread)).catch(() => {})}>Copy line for your agent</button>
      {/if}
    {/if}
    {#if canReply}
      <PromptBox
        bind:value={reply}
        bind:files
        label={retrying ? 'Prompt for the next attempt' : 'Reply'}
        placeholder={thread.status === 'settled' ? 'Reply to reopen this request' : 'Reply, e.g. a bit smaller'}
        rows={2}
        onsubmit={send}
        onproblem={(text) => (problem = text)}
      />
      {#if !external}
        <AgentPicker agents={ui.studio.agents} agent={thread.agent} bind:settings fixed onrefresh={() => actions.refreshAgents()} />
      {/if}
      <div class="composer-row">
        <div class="thread-buttons">
          {#if thread.status === 'your_turn'}
            <button type="button" onclick={() => run(() => actions.requestAction(thread.id, 'settle'))}>Settle</button>
          {/if}
          {#if canRetry && !retrying}
            <button
              type="button"
              onclick={() => {
                retrying = true;
                reply = thread.turns[lastCounted].ask.prompt;
              }}>Try again</button
            >
          {/if}
          {#if retrying}<button type="button" onclick={() => ((retrying = false), (reply = ''))}>Cancel</button>{/if}
          {#if canRevertAll}
            <button type="button" onclick={() => run(() => actions.revert(thread.id))}>Revert all</button>
          {/if}
        </div>
        <button type="button" class="send" disabled={!reply.trim() || busy} onclick={send}>
          {retrying ? 'Revert and try again' : 'Reply'}
        </button>
      </div>
    {/if}
  </footer>
</section>
