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
    firstRevertableTurn,
    isReferencePath,
    type RequestSelection,
    type StudioRequest,
    type Turn,
    threadSummary,
    type TurnSettings,
  } from '../../studio/protocol';
  import { readDraft, writeDraft } from '../prefs';
  import { clockTime, selectionLabel } from '../selection';
  import { threadBadge } from '../thread-groups';
  import { describeUsage, foldTurn, groupSteps } from '../transcript';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Composer from './Composer.svelte';
  import Icon from './Icon.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import SelectionToken from './SelectionToken.svelte';

  let { ui, actions, thread }: { ui: ViewerUi; actions: ViewerActions; thread: StudioRequest } = $props();

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

  // A reply not sent yet outlives a reload and a switch to another project. The panel keys this on the thread.
  const draftKey = untrack(() => String(thread.id));
  let reply = $state(readDraft(draftKey));
  $effect(() => writeDraft(draftKey, reply));
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

  const summary = $derived(threadSummary(thread, ui.studio.now));
  // You're here, so it's your turn: the same words its card shows while it's open.
  const badge = $derived(threadBadge(summary, false));
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

  // A thread's times read at its own scene's rate, which may not be the scene on screen.
  const fps = $derived(ui.scenes.find((o) => o.key === thread.sceneId)?.format?.fps ?? ui.selection.fps);
  const askLabel = (s: RequestSelection) => selectionLabel(s.layerId, s.partId, { from: s.from, to: s.to }, fps);

  // What a reply is about, by the App's rule: a layer or range picked on this thread's scene, else the newest
  // turn's selection. Try again asks about the turn it reverts.
  const onScene = $derived(!retrying && ui.selection.sceneId === thread.sceneId && (ui.selection.layer !== '' || ui.selection.range !== null));
  const threadTarget = $derived(askLabel((retrying && lastCounted >= 0 ? thread.turns[lastCounted] : currentTurn(thread)).ask.selection));

  // Stick to the bottom while the agent works, as T3 Code's list does: follow whatever grows (streamed text,
  // thumbnails that load late) and whatever shrinks the view (a question card, the reply box). Only scrolling
  // up yourself lets go: our own scrolls only ever go down, so a scroll event that arrives after more content
  // (and so measures far from the bottom) can't let go by mistake. Scrolling back near the bottom, the jump
  // button, or sending a reply takes hold again.
  let body = $state<HTMLElement | null>(null);
  let list = $state<HTMLElement | null>(null);
  let pinned = $state(true);
  let lastTop = 0;
  const NEAR_BOTTOM = 40;

  function toBottom(): void {
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    lastTop = body.scrollTop;
  }

  function stick(): void {
    pinned = true;
    toBottom();
  }

  function onScroll(): void {
    if (!body) return;
    const gap = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (gap <= NEAR_BOTTOM) pinned = true;
    else if (body.scrollTop < lastTop - 1) pinned = false;
    lastTop = body.scrollTop;
  }

  $effect(() => {
    if (!body || !list) return;
    const follow = new ResizeObserver(() => {
      if (pinned) toBottom();
    });
    follow.observe(list);
    follow.observe(body);
    return () => follow.disconnect();
  });

  const frameUrl = (turn: number, file: string) => `/__studio/requests/${thread.id}/turns/${turn}/frames/${encodeURIComponent(file)}`;
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
    // Your reply goes to the bottom, so you follow the agent's answer to it.
    stick();
    for (const f of files) URL.revokeObjectURL(f.url);
    files = [];
    reply = '';
    retrying = false;
  }
</script>

{#snippet target()}
  {#if onScene}
    <SelectionToken {ui} {actions} />
  {:else}
    <span class="token is-quiet">{threadTarget}</span>
  {/if}
{/snippet}

<section class="thread" aria-label="Request {thread.id}">
  <header class="panel-head">
    <h2 class="panel-title thread-head-title" title={thread.turns[0].ask.prompt}>{summary.title}</h2>
    <span class="thread-status" role="status" aria-label="Request status" title="#{thread.id} · {agentLabel}"><span class="status-dot is-{badge.kind}" aria-hidden="true"></span>{badge.label}</span>
    <div class="actions">
      <button type="button" class="icon-btn" aria-label="New thread" title="New thread" onclick={() => actions.openThread(null)}><Icon name="plus" /></button>
    </div>
  </header>
  {#if ui.studio.error}<p class="panel-note is-error thread-error">{ui.studio.error}</p>{/if}

  <div class="panel-body" bind:this={body} onscroll={onScroll} onwheel={(e) => e.deltaY < 0 && (pinned = false)}>
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
              {askLabel(turn.ask.selection)}{turn.attempt && turn.attempt > 1 ? ` · attempt ${turn.attempt}` : ''}{settingsText(turn.settings) ? ` · ${settingsText(turn.settings)}` : ''}
            </p>
          </div>

          <div class="work">
            {#each groupSteps(transcript.items) as item, i (i)}
              {#if item.kind === 'text'}
                <p class="work-text">{item.text}</p>
              {:else if item.kind === 'steps'}
                {@const running = item.steps.some((step) => step.status === 'running')}
                {@const failed = item.steps.some((step) => step.status === 'failed')}
                <details class="work-steps" class:is-running={running} class:is-failed={failed}>
                  <summary>{item.steps.length} {item.steps.length === 1 ? 'step' : 'steps'}</summary>
                  {#each item.steps as step (step.id)}
                    <p class="work-step is-{step.status}" title={step.detail ?? ''}>{step.label}</p>
                  {/each}
                </details>
              {:else if item.kind === 'frames'}
                <div class="work-frames">
                  {#each item.frames as f (f.file)}
                    <button type="button" class="frame-thumb" title="Show frame {f.frame}" onclick={() => actions.showFrame(thread.id, f.frame)}>
                      <img src={frameUrl(k, f.file)} alt="Frame {f.frame}" />
                      <span>{clockTime(f.frame, fps)}</span>
                    </button>
                  {/each}
                </div>
              {:else if item.kind === 'approval'}
                <div class="approval" class:is-open={item.decision === null} role="group" aria-label="Approval: {item.summary}">
                  <p class="approval-summary">{item.summary}</p>
                  {#if item.detail && item.decision === null}<p class="approval-detail">{item.detail}</p>{/if}
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
            <span class="turn-status">{turn.status === 'working' && turn.waitingSince ? 'waiting for you' : TURN_LABELS[turn.status]}</span>
            {#if transcript.usage}<span class="turn-usage">{describeUsage(transcript.usage)}</span>{/if}
            {#if turn.checkpointAt && canRevert(thread, k, ui.studio.requests)}
              <button type="button" class="btn is-ghost is-small" aria-label="Revert to before turn {k + 1}" title="Put the scene back as it was before this turn" onclick={() => run(() => actions.revert(thread.id, k))}>
                <Icon name="revert" />Revert to here
              </button>
            {/if}
            {#if external && turn.summary}<span class="turn-summary">{turn.summary}</span>{/if}
            {#if !external && turn.summary && transcript.items.length === 0}<span class="turn-summary">{turn.summary}</span>{/if}
          </footer>
        </li>
      {/each}
    </ol>
    {#if !pinned}
      <button type="button" class="jump-latest" aria-label="Jump to the latest" title="Jump to the latest" onclick={stick}><Icon name="chevronDown" /></button>
    {/if}
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
          {#if summary.status === 'stalled'}<button type="button" class="btn is-small" onclick={() => run(() => actions.requestAction(thread.id, 'requeue'))}>Requeue</button>{/if}
          <button type="button" class="btn is-small" onclick={() => run(() => actions.requestAction(thread.id, 'cancel'))}>Cancel</button>
        {:else}
          <button type="button" class="btn is-small is-danger" onclick={async () => (stopFailed = !(await run(() => actions.requestAction(thread.id, 'stop'))))}>
            <Icon name="stop" />Stop
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
            <Icon name="check" />Settle
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
            }}><Icon name="retry" />Try again</button
          >
        {/if}
        {#if retrying}<button type="button" class="btn is-small" onclick={() => ((retrying = false), (reply = ''))}>Cancel</button>{/if}
        {#if canRevertAll}
          <button type="button" class="btn is-small" onclick={() => run(() => actions.revert(thread.id))}><Icon name="revert" />Revert all</button>
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
        layers={ui.layers}
        onmention={(id) => actions.selectLayer(id)}
        fixed
        label={retrying ? 'Prompt for the next attempt' : 'Reply'}
        placeholder={thread.status === 'settled' ? 'Reply to reopen this thread' : 'Reply, e.g. a bit smaller'}
        {target}
        sendLabel={retrying ? 'Revert and try again' : 'Reply'}
        canSend={reply.trim() !== '' && !busy}
        onsubmit={send}
        onproblem={(text) => (problem = text)}
        onrefresh={() => actions.refreshAgents()}
      />
    {/if}
  </footer>
</section>
