<!--
  Check video, at the foot of the Export popover: measures the scene on screen
  in the render worker (src/export/check.ts) and lists what it found by rank,
  P0 first, findings before passes. A result with frames seeks to them when
  clicked. The report stays while the popover is closed, for as long as that
  scene is on screen.
-->
<script lang="ts">
  import { compareChecks, type CheckRank, type CheckStatus, type RankedResult } from '../../export/check';
  import { clockTime, spanLabel } from '../selection';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  let loop = $state(false);
  let problem = $state<string | null>(null);

  const NAMES: Record<string, string> = {
    format: 'Format',
    duration: 'Length',
    black: 'Black frames',
    freeze: 'Freezes',
    opening: 'Opening',
    'loop-seam': 'Loop',
    flashing: 'Flashing',
    sparse: 'Empty stretches',
    loudness: 'Loudness',
    'true-peak': 'Peaks',
    dropouts: 'Sound gaps',
    markers: 'Sync markers',
    'word-sync': 'Word sync',
    'word-orphans': 'Lost words',
    'caption-cues': 'Caption cues',
    'caption-speed': 'Caption speed',
    'caption-safe': 'Caption placement',
    'text-frame': 'Text in frame',
    'text-safe': 'Text placement',
    'reading-time': 'Reading time',
    'text-contrast': 'Text contrast',
  };
  const WORDS: Record<CheckStatus, string> = { pass: 'Pass', warn: 'Warn', fail: 'Fail' };
  const RANKS: Record<CheckRank, string> = {
    P0: 'P0: breaks the video',
    P1: 'P1: viewers would stop watching or miss something',
    P2: 'P2: costs attention',
    P3: 'P3: polish',
  };

  const job = $derived(ui.checking);
  const report = $derived(job.report?.scene === ui.selection.sceneId ? job.report : null);
  const results = $derived(report ? [...report.checks].sort(compareChecks) : []);
  const fails = $derived(results.filter((r) => r.status === 'fail').length);
  const warns = $derived(results.filter((r) => r.status === 'warn').length);
  const percent = $derived(job.running && job.running.total > 0 ? Math.round((job.running.done / job.running.total) * 100) : 0);

  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary = $derived(fails === 0 && warns === 0 ? 'Everything passed.' : [fails > 0 ? count(fails, 'failure') : '', warns > 0 ? count(warns, 'warning') : ''].filter(Boolean).join(', ') + '.');
  const where = (frames: [number, number][]) => frames.map(([from, to]) => (to - from === 1 ? clockTime(from, ui.selection.fps) : spanLabel({ from, to }, ui.selection.fps))).join('  ');

  async function start(): Promise<void> {
    problem = await actions.startCheck(loop);
  }
</script>

{#snippet result(item: RankedResult)}
  <span class="check-status is-{item.status}">{WORDS[item.status]}</span>
  <span class="check-name">{NAMES[item.id] ?? item.id} <span class="check-rank" class:is-urgent={item.status !== 'pass' && (item.rank === 'P0' || item.rank === 'P1')} title={RANKS[item.rank]}>{item.rank}</span></span>
  <span class="check-message">{item.message}</span>
  {#if item.frames}<span class="check-frames">{where(item.frames)}</span>{/if}
{/snippet}

<section class="check-panel" aria-label="Check">
  <label class="check-row">
    <input type="checkbox" bind:checked={loop} disabled={job.running !== null} />
    This video should loop
  </label>
  <button
    type="button"
    class="btn"
    onclick={() => (job.running ? actions.cancelCheck() : start())}
    disabled={!job.running && ui.selection.sceneId === null}
  >
    {job.running ? 'Cancel check' : 'Check video'}
  </button>
  {#if job.running}
    <div class="export-progress">
      <progress max="100" value={percent} aria-label="Check progress"></progress>
    </div>
    <span class="export-stage" aria-live="polite">{job.running.stage} {percent}%</span>
  {/if}
  {#if problem ?? job.error}<p class="export-error" role="alert">{problem ?? job.error}</p>{/if}
  {#if report}
    <p class="check-summary" role="status">{summary}</p>
    <ul class="check-results" aria-label="Check results">
      {#each results as item (item.id)}
        <li>
          {#if item.frames}
            <button type="button" class="check-result" onclick={() => actions.scrub(item.frames![0][0])}>{@render result(item)}</button>
          {:else}
            <div class="check-result">{@render result(item)}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
