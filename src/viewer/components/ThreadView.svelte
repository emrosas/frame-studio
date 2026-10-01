<!--
  One thread (ADR 0006), in the agent panel: each turn's ask, what the agent
  did (streamed text, steps, the frames it rendered, approval and question
  cards) and how
  it ended, with "Revert to here" on each finished turn. It follows the newest
  work while you're at the bottom. Below, what you can do now: stop a working
  turn, reply, settle, try again. The files in .frame-studio/ are the truth;
  this only shows them.
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
  import Composer from './Composer.svelte';
  import Icon from './Icon.svelte';
  import QuestionCard from './QuestionCard.svelte';

  let { ui, actions, thread, onhide }: { ui: ViewerUi; actions: ViewerActions; thread: StudioRequest; onhide: () => void } = $props();

  const THREAD_LABELS: Record<string, string> = {
    pending: 'waiting',
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
  // The question card the working turn waits on (ADR 0011), shown above the actions.
  const asking = $derived(thread.status === 'working' ? foldTurn(ui.turnEvents[`${thread.id}:${thread.turns.length - 1}`] ?? []).asking : null);
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

  // What a reply is about, by the App's rule: a layer or range picked on this thread's scene, else the newest
  // turn's selection. Try again asks about the turn it reverts.
  const replyTarget = $derived.by(() => {
    const sel = ui.selection;
    if (!retrying && sel.sceneId === thread.sceneId && (sel.layer !== '' || sel.range !== null)) {
      const what = sel.layer === '' ? 'All layers' : sel.layer;
      return `${what}${sel.range ? ` · ${sel.rangeText?.interval ?? ''}` : ''} · ${thread.sceneId}`;
    }
    const s = (retrying && lastCounted >= 0 ? thread.turns[lastCounted] : currentTurn(thread)).ask.selection;
    return `${describeTarget(s)} · [${s.from}, ${s.to}) · ${thread.sceneId}`;
  });

  // Follow the newest work while scrolled to the bottom, including thumbnails that load late; leave it be once
  // you scroll up to read.
  let body = $state<HTMLElement | null>(null);
  let list = $state<HTMLElement | null>(null);
  let pinned = true;
  $effect(() => {
    if (!body || !list) return;
    const box = body;
    const follow = new ResizeObserver(() => {
      if (pinned) box.scrollTop = box.scrollHeight;
    });
    follow.observe(list);
    return () => follow.disconnect();
  });

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
  <header class="panel-head">
    <span class="panel-title">#{thread.id} <span class="sub">· {agentLabel}</span></span>
    <span class="status-badge is-{shown}" role="status" aria-label="Request status"><span class="status-dot is-{shown}" aria-hidden="true"></span>{THREAD_LABELS[shown]}</span>
    <div class="actions">
      <button type="button" class="icon-btn" aria-label="New thread" title="New thread" onclick={() => actions.openThread(null)}><Icon name="plus" /></button>
      <button type="button" class="icon-btn" aria-label="Hide agent panel" title="Hide agent panel" onclick={onhide}><Icon name="panel" /></button>
    </div>
  </header>

  <div class="panel-body" bind:this={body} onscroll={() => body && (pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 60)}>
    <ol class="turns" bind:this={list}>
      {#each thread.turns as turn, k (k)}
        {@const transcript = foldTurn(ui.turnEvents[`${thread.id}:${k}`] ?? [])}
        <li class="turn is-{turn.status}" aria-label="Turn {k + 1}">
          <div class="ask">
            <p class="ask-prompt">{turn.ask.prompt}</p>
            {#if turn.ask.references.length > 0}
              <ul class="composer-refs" aria-label="Reference images">
                {#each turn.ask.references.filter(isReferencePath) as ref (ref)}<li><img src="/{ref}" alt={ref} /></li>{/each}
              </ul>
            {/if}
            <p class="ask-meta">
              {describeTarget(turn.ask.selection)} · {range(turn)}{turn.attempt && turn.attempt > 1 ? ` · attempt ${turn.attempt}` : ''}{settingsText(turn.settings) ? ` · ${settingsText(turn.settings)}` : ''}
            </p>
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
                    <div class="row">
                      <button type="button" class="btn is-small" disabled={busy} onclick={() => run(() => actions.respond(thread.id, item.id, 'decline'))}>Decline</button>
                      <button type="button" class="btn is-primary is-small" disabled={busy} onclick={() => run(() => actions.respond(thread.id, item.id, 'accept'))}>Allow</button>
                    </div>
                  {:else}
                    <p class="approval-answer">{item.decision === 'accept' ? 'Allowed' : item.decision === 'decline' ? 'Declined' : 'Not answered before the turn ended'}</p>
                  {/if}
                </div>
              {:else if item.kind === 'questions'}
                <div class="asked" role="group" aria-label="Questions">
                  {#each item.questions as question (question.id)}
                    <p class="asked-q">{question.question}</p>
                    {#if item.answers}
                      <p class="asked-a">{(item.answers[question.id] ?? []).join(', ')}</p>
                    {/if}
                  {/each}
                  {#if item.answers === undefined}
                    <p class="approval-answer">{turn.status === 'working' ? 'Waiting for your answer below' : 'Not answered before the turn ended'}</p>
                  {:else if item.answers === null}
                    <p class="approval-answer">Skipped: the agent decides</p>
                  {/if}
                </div>
              {:else}
                <p class="work-note" class:is-error={item.error}>{item.text}</p>
              {/if}
            {/each}
          </div>

          <footer class="turn-foot">
            <span class="turn-status">{TURN_LABELS[turn.status]}</span>
            {#if transcript.usage}<span class="turn-usage">{describeUsage(transcript.usage)}</span>{/if}
            {#if turn.checkpointAt && canRevert(thread, k, ui.studio.requests)}
              <button type="button" class="btn is-ghost is-small" aria-label="Revert to before turn {k + 1}" title="Put the scene back as it was before this turn" onclick={() => run(() => actions.revert(thread.id, k))}>
                <Icon name="revert" size={13} />Revert to here
              </button>
            {/if}
            {#if external && turn.summary}<span class="turn-summary">{turn.summary}</span>{/if}
            {#if !external && turn.summary && transcript.items.length === 0}<span class="turn-summary">{turn.summary}</span>{/if}
          </footer>
        </li>
      {/each}
    </ol>
  </div>

  <footer class="panel-foot">
    {#if asking}
      {#key asking.id}
        <QuestionCard questions={asking.questions} onanswer={(answers) => actions.answer(thread.id, asking.id, answers)} />
      {/key}
    {/if}
    {#if problem}<p class="panel-note is-error" role="status">{problem}</p>{/if}
    {#if thread.status === 'pending' && !agentReady}
      <p class="panel-note" role="status">{agentLabel} isn't ready, so this waits. Pick it in a new thread to see why.</p>
    {/if}
    <div class="thread-actions">
      {#if thread.status === 'working'}
        {#if external}
          {#if shown === 'stalled'}<button type="button" class="btn is-small" onclick={() => run(() => actions.requestAction(thread.id, 'requeue'))}>Requeue</button>{/if}
          <button type="button" class="btn is-small" onclick={() => run(() => actions.requestAction(thread.id, 'cancel'))}>Cancel</button>
        {:else}
          <button type="button" class="btn is-small is-danger" onclick={async () => (stopFailed = !(await run(() => actions.requestAction(thread.id, 'stop'))))}>
            <Icon name="stop" size={12} />Stop
          </button>
          <!-- Stop works only on a turn this studio server runs; Cancel ends the turn whoever has it. -->
          {#if stopFailed}<button type="button" class="btn is-small" onclick={() => run(() => actions.requestAction(thread.id, 'cancel'))}>Cancel</button>{/if}
        {/if}
      {:else if thread.status === 'pending'}
        <button type="button" class="btn is-small" onclick={() => run(() => actions.requestAction(thread.id, 'cancel'))}>Cancel</button>
        {#if external}
          <button type="button" class="btn is-small" onclick={() => navigator.clipboard.writeText(clipboardLine(thread)).catch(() => {})}>Copy line for your agent</button>
        {/if}
      {/if}
      {#if canReply}
        {#if thread.status === 'your_turn'}
          <button type="button" class="btn is-small" title="It's right: close the thread" onclick={() => run(() => actions.requestAction(thread.id, 'settle'))}>
            <Icon name="check" size={13} />Settle
          </button>
        {/if}
        {#if canRetry && !retrying}
          <button
            type="button"
            class="btn is-small"
            title="Revert the last turn and ask again"
            onclick={() => {
              retrying = true;
              reply = thread.turns[lastCounted].ask.prompt;
            }}><Icon name="retry" size={13} />Try again</button
          >
        {/if}
        {#if retrying}<button type="button" class="btn is-small" onclick={() => ((retrying = false), (reply = ''))}>Cancel</button>{/if}
        {#if canRevertAll}
          <button type="button" class="btn is-small" onclick={() => run(() => actions.revert(thread.id))}><Icon name="revert" size={13} />Revert all</button>
        {/if}
      {/if}
    </div>
    {#if retrying}
      <p class="panel-note" role="status">Sending reverts turn {lastCounted + 1}, then asks again with this prompt.</p>
    {/if}
    {#if canReply}
      <Composer
        bind:value={reply}
        bind:files
        bind:settings
        agent={thread.agent}
        agents={ui.studio.agents}
        fixed
        label={retrying ? 'Prompt for the next attempt' : 'Reply'}
        placeholder={thread.status === 'settled' ? 'Reply to reopen this thread' : 'Reply, e.g. a bit smaller'}
        target={replyTarget}
        sendLabel={retrying ? 'Revert and try again' : 'Reply'}
        canSend={reply.trim() !== '' && !busy}
        onsubmit={send}
        onproblem={(text) => (problem = text)}
        onrefresh={() => actions.refreshAgents()}
      />
    {/if}
  </footer>
</section>
