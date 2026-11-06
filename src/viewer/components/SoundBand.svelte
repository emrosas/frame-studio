<!--
  One sound cue on the timeline (ADR 0012), in a row under the clips: its id
  when that fits, and for a sound file its waveform over the seconds of the file
  the cue plays. The waveform comes once the file has decoded for the scene's
  sound. Read-only.
-->
<script lang="ts">
  import { labelFits } from '../timeline';
  import { spanLabel } from '../selection';
  import type { SoundBand, ViewerActions } from '../ui.svelte';

  let { band, style, ready, actions, px, fps, selected }: { band: SoundBand; style: string; ready: boolean; actions: ViewerActions; px: number; fps: number; selected: boolean } = $props();

  const BUCKETS = 160;
  let path = $state('');

  $effect(() => {
    const file = band.file;
    if (!file || !ready) return;
    let live = true;
    void actions.waveform(file.path, file.from, file.to, BUCKETS).then((peaks) => {
      if (!live || !peaks) return;
      // The peaks as one closed shape, mirrored about the middle.
      const top = Array.from(peaks, (p, i) => `${i} ${0.5 - p / 2}`);
      const bottom = Array.from(peaks, (p, i) => `${i} ${0.5 + p / 2}`).reverse();
      path = `M${top.join('L')}L${bottom.join('L')}Z`;
    });
    return () => {
      live = false;
    };
  });
</script>

<div class="sound-band" class:is-file={band.file !== undefined} class:is-selected={selected} {style} data-cue={band.id} title="{band.label}, {spanLabel(band, fps)}. Click, then X to mark it." role="img" aria-label="Sound {band.label}">
  {#if path}
    <svg class="waveform" viewBox="0 0 {BUCKETS} 1" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
  {/if}
  {#if labelFits(band.id, px)}<span class="sound-label">{band.id}</span>{/if}
</div>
