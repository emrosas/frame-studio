<!--
  One sound cue on the timeline (ADR 0012), in a row under the clips: its id
  when that fits, and for a sound file its waveform over the seconds of the file
  the cue plays. The waveform comes once the file has decoded for the scene's
  sound. It drags to move, its edges trim, and the marks in its top corners set
  the fades (ADR 0018). A sound file without words offers Timing (ADR 0016),
  which gets it a voice row.
-->
<script lang="ts">
  import { labelFits } from '../timeline';
  import { spanLabel } from '../selection';
  import type { SoundBand, ViewerActions } from '../ui.svelte';

  let { band, style, ready, actions, px, fps, selected, editable }: { band: SoundBand; style: string; ready: boolean; actions: ViewerActions; px: number; fps: number; selected: boolean; editable: boolean } = $props();

  const seconds = $derived(band.place ? (band.place.to - band.place.from) / fps : 0);
  const fades = $derived(editable && band.place?.file === true);
  const title = $derived(`${band.label}, ${spanLabel(band, fps)}. ${editable && band.place ? 'Drag to move, drag an edge to trim. ' : ''}Click, then X to mark it.`);

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

<div class="sound-band" class:is-file={band.file !== undefined} class:is-selected={selected} class:is-editable={editable && band.place !== undefined} {style} data-cue={band.id} {title} role="img" aria-label="Sound {band.label}">
  {#if path}
    <svg class="waveform" viewBox="0 0 {BUCKETS} 1" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
  {/if}
  {#if band.place && seconds > 0}
    {#if band.place.fadeIn > 0}<span class="sound-fade is-in" style="width: {(band.place.fadeIn / seconds) * 100}%"></span>{/if}
    {#if band.place.fadeOut > 0}<span class="sound-fade is-out" style="width: {(band.place.fadeOut / seconds) * 100}%"></span>{/if}
  {/if}
  {#if editable && band.place}
    <span class="clip-edge is-start" data-edge="start"></span>
    <span class="clip-edge is-end" data-edge="end"></span>
    {#if fades && seconds > 0}
      <span class="fade-mark is-in" data-fade="in" title="Fade in" style="left: {(band.place.fadeIn / seconds) * 100}%"></span>
      <span class="fade-mark is-out" data-fade="out" title="Fade out" style="right: {(band.place.fadeOut / seconds) * 100}%"></span>
    {/if}
  {/if}
  {#if labelFits(band.id, px)}<span class="sound-label">{band.id}</span>{/if}
  {#if band.canTime && px >= 64}
    <button type="button" class="sound-time" title="Find when each word is said, for captions and word anchors" onpointerdown={(e) => e.stopPropagation()} onclick={() => actions.timeVoice(band.id)}>Timing</button>
  {/if}
</div>
