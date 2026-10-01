<!--
  The transport under the stage: play/pause, sound on/off for scenes with
  audio, timecode, the scrubber with the frame range band and, on a scene that
  places shots, a band per shot (click selects it, double-click opens it), and
  the frame readout.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import SoundBand from './SoundBand.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  let scrubbing = false;

  const last = $derived(ui.timeline ? ui.timeline.frameCount - 1 : 0);
  const progress = $derived(ui.timeline && last > 0 ? (ui.timeline.frame / last) * 100 : 0);
  // The band runs from the in frame's slot to the out frame's (to - 1). The thumb centre sits at frame / last of the track.
  const bandStyle = $derived.by(() => {
    if (!ui.band || ui.band.frameCount < 1) return null;
    const end = ui.band.frameCount - 1;
    const start = end > 0 ? (ui.band.range.from - 0.5) / end : 0;
    const stop = end > 0 ? (ui.band.range.to - 0.5) / end : 1;
    return `--in: ${start}; --out: ${stop}`;
  });
  /** Where a span sits on the track, on the same scale as the range band. */
  function spanStyle(from: number, to: number, frameCount: number, lane: number): string {
    const end = frameCount - 1;
    const start = end > 0 ? (from - 0.5) / end : 0;
    const stop = end > 0 ? (to - 0.5) / end : 1;
    return `--in: ${start}; --out: ${stop}; --lane: ${lane}`;
  }

  /** The band clicked last, so a double-click opens it even if the first click moved the bands under the pointer. */
  let lastBand: { layerId: string; at: number } | null = null;
  function openBand(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-layer]');
    const recent = lastBand && performance.now() - lastBand.at < 800 ? lastBand.layerId : null;
    const layerId = recent ?? target?.dataset.layer ?? null;
    lastBand = null;
    if (layerId) actions.openShot(layerId);
  }

  const playLabel = $derived(ui.playing ? 'Pause' : 'Play');
  const soundLabel = $derived(ui.sound?.muted ? 'Unmute' : 'Mute');
  const soundTitle = $derived.by(() => {
    const status = ui.sound?.status;
    if (status === 'rendering') return 'Sound is rendering';
    if (status === 'failed') return 'Sound failed to render (see the error panel)';
    if (status === 'locked') return 'Sound starts once you click or press a key';
    return `${soundLabel} (M)`;
  });

  function endScrub(): void {
    if (!scrubbing) return;
    scrubbing = false;
    window.removeEventListener('pointerup', endScrub);
    window.removeEventListener('pointercancel', endScrub);
    actions.scrubEnd();
  }

  function startScrub(): void {
    if (scrubbing) return;
    scrubbing = true;
    window.addEventListener('pointerup', endScrub);
    window.addEventListener('pointercancel', endScrub);
    actions.scrubStart();
  }
</script>

<div
  class="transport"
  class:has-shots={ui.shots !== null || ui.sounds !== null}
  style="--lanes: {(ui.shots?.lanes ?? 0) + (ui.sounds?.lanes ?? 0)}; --shot-lanes: {ui.shots?.lanes ?? 0}"
>
  <button
    type="button"
    class="play-button"
    aria-keyshortcuts="Space"
    aria-label={playLabel}
    title="{playLabel} (Space)"
    disabled={!ui.canPlay}
    onclick={() => actions.togglePlay()}
  >
    <Icon name={ui.playing ? 'pause' : 'play'} size={14} />
  </button>
  {#if ui.sound}
    <button
      type="button"
      class="icon-btn sound-button"
      class:is-waiting={ui.sound.status !== 'ready'}
      aria-keyshortcuts="M"
      aria-label={soundLabel}
      aria-pressed={ui.sound.muted}
      title={soundTitle}
      onclick={() => actions.toggleMute()}
    >
      <Icon name={ui.sound.muted ? 'mute' : 'volume'} />
    </button>
  {/if}
  <output class="timecode" aria-label="Timecode">
    {ui.timeline ? `${ui.timeline.timecode} / ${ui.timeline.endTimecode}` : '--:--:-- / --:--:--'}
  </output>
  <div class="scrubber-wrap">
    <div class="range-band" hidden={bandStyle === null} aria-hidden="true" style={bandStyle ?? ''} title={ui.band ? `[${ui.band.range.from}, ${ui.band.range.to})` : ''}>
      <span class="range-mark is-in"></span><span class="range-mark is-out"></span>
    </div>
    <input
      class="scrubber"
      type="range"
      min="0"
      max={last}
      step="1"
      value={ui.timeline?.frame ?? 0}
      disabled={!ui.timeline}
      aria-label="Frame"
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
      style="--progress: {progress}%"
      onpointerdown={startScrub}
      oninput={(e) => actions.scrub(Number(e.currentTarget.value))}
      onchange={endScrub}
    />
    {#if ui.shots}
      <div class="shots" role="group" aria-label="Shots" ondblclick={openBand}>
        {#each ui.shots.bands as band (band.layerId)}
          <button
            type="button"
            class="shot-band"
            class:is-selected={band.selected}
            data-layer={band.layerId}
            aria-pressed={band.selected}
            aria-label={band.layerId === band.label ? band.label : `${band.label} (layer ${band.layerId})`}
            style={spanStyle(band.from, band.to, ui.shots.frameCount, band.lane)}
            title="{band.label}, frames [{band.from}, {band.to}). Click to select, double-click to open."
            onclick={(e) => {
              lastBand = { layerId: band.layerId, at: performance.now() };
              actions.selectShot(band.layerId);
              e.currentTarget.blur();
            }}
          >
            {band.label}
          </button>
        {/each}
      </div>
    {/if}
    {#if ui.sounds}
      <div class="sounds" role="group" aria-label="Sounds">
        {#each ui.sounds.bands as band (band.id)}
          <SoundBand {band} {actions} ready={ui.sound?.status === 'ready' || ui.sound?.status === 'locked'} style={spanStyle(band.from, band.to, ui.sounds.frameCount, band.lane)} />
        {/each}
      </div>
    {/if}
  </div>
  <output class="frame-readout" aria-label="Frame number">
    {ui.timeline ? `frame ${ui.timeline.frame} of ${ui.timeline.frameCount}` : 'frame -'}
  </output>
</div>
