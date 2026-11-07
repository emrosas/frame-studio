<!--
  A timing job on the timeline (ADR 0016): the question before the first
  download, with its size, then what it's doing, or why it stopped.
-->
<script lang="ts">
  import type { ViewerActions, VoiceJob } from '../ui.svelte';

  let { job, actions }: { job: VoiceJob; actions: ViewerActions } = $props();

  const STAGES: Record<string, string> = { download: 'Downloading the speech model', decode: 'Reading the sound', listen: 'Listening', write: 'Writing the words', start: 'Starting' };
  const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
  const percent = $derived(job.status === 'working' && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0);
</script>

<div class="voice-card" class:is-error={job.status === 'error'} role="status" aria-label="Voice timing">
  {#if job.status === 'ask'}
    <strong>Download the speech model?</strong>
    <p>Timing a voice needs Whisper {job.name}, {megabytes(job.bytes)}. It's a one time download, and after it timing works offline.</p>
    <div class="row">
      <button type="button" class="btn is-primary is-small" onclick={() => actions.confirmVoice()}>Download</button>
      <button type="button" class="btn is-ghost is-small" onclick={() => actions.cancelVoice()}>Not now</button>
    </div>
  {:else if job.status === 'working'}
    <strong>{STAGES[job.stage] ?? job.stage}</strong>
    <progress max="100" value={percent} aria-label="Timing progress"></progress>
    <div class="row">
      {#if job.stage === 'download'}<p>{megabytes(job.done)} of {megabytes(job.total)}</p>{:else}<p>Cue {job.cue}</p>{/if}
      <button type="button" class="btn is-ghost is-small" onclick={() => actions.cancelVoice()}>Cancel</button>
    </div>
  {:else}
    <strong>Couldn't time the voice</strong>
    <p>{job.message}</p>
    <div class="row">
      <button type="button" class="btn is-small" onclick={() => actions.timeVoice(job.cue)}>Try again</button>
      <button type="button" class="btn is-ghost is-small" onclick={() => actions.cancelVoice()}>Close</button>
    </div>
  {/if}
</div>
