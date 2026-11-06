<!--
  The dock's transport: play/pause, sound on/off for scenes with audio, and the
  clock. The clock reads 0:01.00 by default, and a click switches it to MM:SS:FF
  and back. The frame number stays in the tooltip and the accessibility tree.
-->
<script lang="ts">
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import Icon from './Icon.svelte';

  let { ui, actions }: { ui: ViewerUi; actions: ViewerActions } = $props();

  const playLabel = $derived(ui.playing ? 'Pause' : 'Play');
  const soundLabel = $derived(ui.sound?.muted ? 'Unmute' : 'Mute');
  const soundTitle = $derived.by(() => {
    const status = ui.sound?.status;
    if (status === 'rendering') return 'Sound is rendering';
    if (status === 'failed') return 'Sound failed to render (see the error panel)';
    if (status === 'locked') return 'Sound starts once you click or press a key';
    return `${soundLabel} (M)`;
  });
  const timecode = $derived(ui.layout.clock === 'timecode');
  const clock = $derived.by(() => {
    const t = ui.timeline;
    if (!t) return timecode ? '--:--:-- / --:--:--' : '-:--.-- / -:--.--';
    return timecode ? `${t.timecode} / ${t.endTimecode}` : `${t.clock} / ${t.endClock}`;
  });
</script>

<div class="transport">
  <button
    type="button"
    class="play-button"
    aria-keyshortcuts="Space"
    aria-label={playLabel}
    title="{playLabel} (Space)"
    disabled={!ui.canPlay}
    onclick={() => actions.togglePlay()}
  >
    <Icon name={ui.playing ? 'pause' : 'play'} />
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
  <div class="clock">
    <output aria-label="Timecode">
      <button
        type="button"
        class="clock-button"
        title="{ui.timeline ? `Frame ${ui.timeline.frame} of ${ui.timeline.frameCount}. ` : ''}{timecode ? 'Click for seconds.' : 'Click for MM:SS:FF.'}"
        onclick={(e) => {
          ui.layout.clock = timecode ? 'time' : 'timecode';
          e.currentTarget.blur();
        }}>{clock}</button
      >
    </output>
    <output class="sr-only" aria-label="Frame number">
      {ui.timeline ? `frame ${ui.timeline.frame} of ${ui.timeline.frameCount}` : ''}
    </output>
  </div>
</div>
