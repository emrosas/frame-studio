<!--
  The agent's questions (ADR 0011), above the thread's actions while its turn
  waits on them, after T3 Code's: one question at a time, its options
  numbered, the recommended one first, and a line to type an answer of your
  own. A single-choice question moves on as soon as you pick; the last one
  sends. Keys 1 to 9 pick, Enter moves on, and Skip lets the agent decide.
-->
<script lang="ts">
  import type { AgentQuestion, QuestionAnswers } from '../../studio/protocol';
  import Icon from './Icon.svelte';

  let { questions, onanswer }: { questions: AgentQuestion[]; onanswer: (answers: QuestionAnswers | null) => Promise<string | null> } = $props();

  let index = $state(0);
  let picks = $state<Record<string, string[]>>({});
  let other = $state<Record<string, string>>({});
  // The option with keyboard focus, whose preview shows. Focus, not hover: a preview appearing under the
  // pointer would grow the card and move the option away from it.
  let focused = $state<number | null>(null);
  let sending = $state(false);
  let problem = $state<string | null>(null);
  let card = $state<HTMLElement | null>(null);

  const q = $derived(questions[index]);
  const last = $derived(index === questions.length - 1);
  const typed = (id: string) => (other[id] ?? '').trim();
  const answerOf = (question: AgentQuestion): string[] => {
    const chosen = picks[question.id] ?? [];
    const own = typed(question.id);
    if (question.multiSelect) return own ? [...chosen, own] : chosen;
    return own ? [own] : chosen.slice(0, 1);
  };
  const answered = $derived(answerOf(q).length > 0);
  const preview = $derived(q.options[focused ?? q.options.findIndex((o) => (picks[q.id] ?? []).includes(o.label))]?.preview ?? null);

  async function send(answers: QuestionAnswers | null): Promise<void> {
    if (sending) return;
    sending = true;
    problem = await onanswer(answers);
    sending = false;
  }

  function next(): void {
    if (!answered) return;
    if (!last) {
      index++;
      focused = null;
      return;
    }
    void send(Object.fromEntries(questions.map((question) => [question.id, answerOf(question)])));
  }

  function pick(label: string): void {
    const id = q.id;
    if (q.multiSelect) {
      const now = picks[id] ?? [];
      picks[id] = now.includes(label) ? now.filter((l) => l !== label) : [...now, label];
      return;
    }
    picks[id] = [label];
    other[id] = '';
    next();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!card || !card.contains(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
    const inText = document.activeElement instanceof HTMLInputElement;
    if (!inText && /^[1-9]$/.test(e.key)) {
      const option = q.options[Number(e.key) - 1];
      if (option) {
        e.preventDefault();
        pick(option.label);
      }
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      next();
    }
  }
</script>

<!-- Capture, so a key the card uses never reaches the viewer's shortcuts. -->
<svelte:window onkeydowncapture={onKeydown} />

<section class="questions" aria-label="Questions from the agent" bind:this={card}>
  <header>
    {#if q.header}<span class="q-chip">{q.header}</span>{/if}
    {#if questions.length > 1}<span class="q-step">{index + 1} of {questions.length}</span>{/if}
    <button type="button" class="link-btn q-skip" disabled={sending} title="Let the agent decide" onclick={() => send(null)}>Skip</button>
  </header>
  <p class="q-text">{q.question}</p>

  {#if q.options.length > 0}
    <ol class="q-options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
      {#each q.options as option, i (option.label)}
        {@const on = (picks[q.id] ?? []).includes(option.label)}
        <li>
          <button
            type="button"
            class="q-option"
            class:is-on={on}
            role={q.multiSelect ? 'checkbox' : 'radio'}
            aria-checked={on}
            disabled={sending}
            onclick={() => pick(option.label)}
            onfocus={() => (focused = i)}
            onblur={() => (focused = null)}
          >
            <span class="q-key" aria-hidden="true">{#if q.multiSelect && on}<Icon name="check" size={12} />{:else}{i + 1}{/if}</span>
            <span class="q-label">
              <span class="q-name">{option.label}</span>
              {#if option.description}<span class="q-desc">{option.description}</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
  {#if preview}<pre class="q-preview">{preview}</pre>{/if}

  <label class="q-other">
    <span class="sr-only">{q.options.length > 0 ? 'Or type your own answer' : 'Your answer'}</span>
    <input
      type="text"
      placeholder={q.options.length > 0 ? 'Or type your own answer…' : 'Type your answer…'}
      maxlength="2000"
      disabled={sending}
      value={other[q.id] ?? ''}
      oninput={(e) => {
        other[q.id] = e.currentTarget.value;
        if (!q.multiSelect && e.currentTarget.value.trim()) picks[q.id] = [];
      }}
    />
  </label>

  {#if problem}<p class="panel-note is-error" role="alert">{problem}</p>{/if}
  <footer>
    {#if index > 0}<button type="button" class="btn is-ghost is-small" disabled={sending} onclick={() => (index--, (focused = null))}>Back</button>{/if}
    <span class="q-hint">{q.multiSelect ? 'Pick any' : 'Pick one'}{q.options.length > 0 ? ', or type' : ''}</span>
    <button type="button" class="btn is-primary is-small" disabled={!answered || sending} onclick={next}>{last ? (sending ? 'Sending…' : 'Send') : 'Next'}</button>
  </footer>
</section>
