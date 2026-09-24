<!--
  The control bar under the stage: play/pause, the scrubber with the frame
  range band, timecode, frame and fps readouts, scene picker and shortcut hint.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';

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
  const playLabel = $derived(ui.playing ? 'Pause' : 'Play');

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

<div class="controls-row transport">
  <button
    type="button"
    class="play-button"
    aria-keyshortcuts="Space"
    aria-label={playLabel}
    title="{playLabel} (Space)"
    disabled={!ui.canPlay}
    onclick={() => actions.togglePlay()}
  >
    {#if ui.playing}
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" /></svg>
    {:else}
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" /></svg>
    {/if}
  </button>
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
  </div>
  <output class="frame-readout" aria-label="Frame number">
    {ui.timeline ? `frame ${ui.timeline.frame} of ${ui.timeline.frameCount}` : 'frame -'}
  </output>
</div>

<div class="controls-row info">
  <label class="scene-picker">
    <span class="label">Scene</span>
    <select
      class="scene-select"
      disabled={ui.scenes.length === 0}
      value={ui.selectedScene ?? ''}
      onchange={(e) => {
        actions.selectScene(e.currentTarget.value);
        // Hand focus back so Space and the arrow keys drive playback again.
        e.currentTarget.blur();
      }}
    >
      {#each ui.scenes as option (option.key)}
        <option value={option.key} title={option.file}>{option.invalid ? `${option.label} (invalid)` : option.label}</option>
      {/each}
    </select>
  </label>
  <output class="fps-readout" aria-label="Frame rate">
    {ui.fps ? `${ui.fps.scene} fps · playback ${ui.fps.measured === null ? '–' : ui.fps.measured.toFixed(1)}` : ''}
  </output>
  <span class="spacer"></span>
  <div class="hint">
    <kbd>Space</kbd> play/pause <span class="sep">·</span> <kbd>←</kbd><kbd>→</kbd> frame <span class="sep">·</span>
    <kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd> 1 s <span class="sep">·</span> <kbd>Home</kbd><kbd>End</kbd>
  </div>
</div>
