<!--
  Generate Voice (ADR 0017): the text, a rail of providers in the ModelPicker's
  style, the voices for the language, the price, and Generate. Kokoro runs on
  this computer through the studio server and offers its download here, with
  size and licences. A paid provider needs the app: its key stays in the main
  process, so this page only asks, and main shows the native dialog that spends.
  The result lands in media/, with a button that places it at the playhead,
  where it gets its words (ADR 0016).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { KokoroStatus, VoiceChoice } from '../../studio/protocol';
  import { desktop, type VoiceProvider } from '../desktop';
  import type { IconName } from '../icons';
  import type { ViewerActions, ViewerUi } from '../ui.svelte';
  import { megabytes, priceLine } from '../speech';
  import Icon from './Icon.svelte';
  import VoiceCard from './VoiceCard.svelte';

  let { ui, actions, onclose }: { ui: ViewerUi; actions: ViewerActions; onclose: () => void } = $props();

  const app = desktop();
  const MAX_TEXT = 5000;
  const LANGUAGES = [
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Spanish' },
  ];

  let dialog = $state<HTMLDialogElement | null>(null);
  let text = $state('');
  let lang = $state(untrack(() => (ui.projectLang === 'es' ? 'es' : 'en')));
  let rail = $state('kokoro');
  let voice = $state<string | null>(null);
  let kokoro = $state<KokoroStatus | null>(null);
  let paid = $state<VoiceProvider[]>([]);
  let refusal = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let made = $state<string | null>(null);
  let placed = $state(false);

  const provider = $derived(paid.find((p) => p.id === rail) ?? null);
  const progress = $derived(ui.speechInstall);
  const installing = $derived(kokoro?.state === 'installing' || progress !== null);
  const voices = $derived<readonly VoiceChoice[]>((provider ? provider.voices : (kokoro?.voices ?? [])).filter((v) => v.langs.includes(lang)));
  const chosen = $derived(voices.find((v) => v.id === voice) ?? voices[0] ?? null);
  const needsKey = $derived(provider !== null && provider.key === null);
  const ready = $derived(provider ? provider.key !== null : kokoro?.state === 'ready');
  const price = $derived(provider ? priceLine(text.length, provider.usdPer1000Characters) : 'Free, on this computer');
  const canGenerate = $derived(ready && !busy && chosen !== null && text.trim() !== '' && text.length <= MAX_TEXT);

  async function refresh(): Promise<void> {
    kokoro = await actions.speechStatus();
    const listed = await app?.voice.providers();
    paid = listed?.providers ?? [];
    refusal = listed?.refusal ?? null;
  }

  onMount(() => {
    dialog?.showModal();
    void refresh();
  });

  // The download finishing or failing arrives as an event; read where it left things.
  let wasInstalling = false;
  $effect(() => {
    const now = progress !== null;
    if (wasInstalling && !now) {
      error = ui.speechInstallError;
      void refresh();
    }
    wasInstalling = now;
  });

  const close = () => {
    dialog?.close();
    onclose();
  };

  async function install(): Promise<void> {
    error = null;
    kokoro = await actions.installSpeech();
  }

  async function addKey(): Promise<void> {
    if (!provider) return;
    await app?.voice.addKey(provider.id);
    await refresh();
  }

  async function generate(): Promise<void> {
    if (!canGenerate || !chosen) return;
    busy = true;
    error = null;
    made = null;
    placed = false;
    const script = text;
    try {
      const answer = provider ? await app!.voice.generate({ provider: provider.id, text: script, lang, voice: chosen.id }) : await actions.generateSpeech(script, lang, chosen.id);
      if ('error' in answer) error = answer.error;
      else if ('file' in answer) {
        made = answer.file;
        actions.alignVoice({ ...answer, script, lang });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function place(): Promise<void> {
    if (!made) return;
    const problem = await actions.placeSound(made);
    if (problem) error = problem;
    else placed = true;
  }

  const logo = (id: string): IconName => (id === 'elevenlabs' ? 'elevenlabs' : 'kokoro');
</script>

<dialog bind:this={dialog} class="new-dialog voice-sheet" aria-label="Generate voice" oncancel={(e) => { e.preventDefault(); close(); }}>
  <div class="voice-form">
    <header>
      <h2>Generate voice</h2>
      <button type="button" class="icon-btn" aria-label="Close" onclick={close}><Icon name="close" /></button>
    </header>

    <label class="field">
      <span class="field-label">Text</span>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea class="voice-text" rows="5" maxlength={MAX_TEXT} placeholder="What should it say?" autofocus bind:value={text}></textarea>
    </label>

    <div class="voice-body">
      <div class="model-rail" role="radiogroup" aria-label="Provider">
        <button type="button" role="radio" aria-label="Kokoro" title="Kokoro, on this computer" aria-checked={rail === 'kokoro'} onclick={() => (rail = 'kokoro')}><Icon name="kokoro" /></button>
        {#each paid as p (p.id)}
          <button type="button" role="radio" aria-label={p.label} title={p.key ? p.label : `${p.label}: add a key`} class:is-dim={p.key === null} aria-checked={rail === p.id} onclick={() => (rail = p.id)}><Icon name={logo(p.id)} /></button>
        {/each}
      </div>

      <div class="voice-main">
        <div class="voice-head">
          <span class="voice-provider">{provider?.label ?? 'Kokoro'}</span>
          <select aria-label="Language" bind:value={lang}>
            {#each LANGUAGES as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
          </select>
        </div>

        {#if !provider && kokoro && kokoro.state !== 'ready'}
          <div class="speech-card">
            {#if kokoro.state === 'unsupported'}
              <p>Kokoro has no build for this computer.</p>
            {:else}
              <p><strong>Free voices that run on this computer.</strong> One {megabytes(kokoro.bytes)} download, once, into your home folder. Offline after that.</p>
              <p class="field-hint">Kokoro model and sherpa-onnx: Apache 2.0. espeak-ng data, which reads Spanish aloud: GPL 3.0, and that's why it comes as this optional download and not inside Frame Studio.</p>
              {#if installing}
                <div class="voice-progress" role="progressbar" aria-label="Downloading Kokoro" aria-valuemin={0} aria-valuemax={progress?.total ?? kokoro.bytes} aria-valuenow={progress?.done ?? kokoro.done ?? 0}>
                  <span style="width: {(((progress?.done ?? kokoro.done ?? 0) / (progress?.total ?? kokoro.bytes)) * 100).toFixed(1)}%"></span>
                </div>
                <p class="field-hint">{megabytes(progress?.done ?? kokoro.done ?? 0)} of {megabytes(progress?.total ?? kokoro.bytes)}</p>
              {:else}
                {#if kokoro.error}<p class="panel-note is-error" role="alert">{kokoro.error}</p>{/if}
                <div><button type="button" class="btn" onclick={install}>Download Kokoro</button></div>
              {/if}
            {/if}
          </div>
        {:else if needsKey}
          <div class="speech-card">
            <p>{provider?.label} needs a key of yours. It's encrypted on this computer, and scenes, rigs and agents never see it.</p>
            {#if refusal}
              <p class="panel-note is-error" role="alert">{refusal}</p>
            {:else}
              <div><button type="button" class="btn" onclick={addKey}>Add key</button></div>
            {/if}
          </div>
        {:else}
          <div class="model-list voice-list" role="radiogroup" aria-label="Voice">
            {#each voices as option (option.id)}
              <button type="button" role="radio" class="menu-item" aria-checked={chosen?.id === option.id} onclick={() => (voice = option.id)}>
                <span class="model-name">{option.label}</span>
                {#if option.detail}<span class="model-effort">{option.detail}</span>{/if}
                {#if chosen?.id === option.id}<Icon name="check" />{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    {#if error}<p class="panel-note is-error" role="alert">{error}</p>{/if}
    {#if made}
      <p class="panel-note voice-made" role="status">
        Saved as {made}.
        {#if placed}Placed at the playhead.{:else}
          <button type="button" class="btn is-small" disabled={ui.selection.sceneId === null} title={ui.header ? `Adds it to ${ui.header.name} at the playhead` : 'Open a scene first'} onclick={place}>Place at playhead</button>
        {/if}
      </p>
    {/if}
    <!-- The timeline's card sits behind this dialog, and it may be asking about the model. -->
    {#if ui.voiceJob}<VoiceCard job={ui.voiceJob} {actions} />{/if}

    <footer>
      <span class="field-hint voice-price">{price}</span>
      <button type="button" class="btn is-primary" disabled={!canGenerate} onclick={generate}>{busy ? 'Generating…' : 'Generate'}</button>
    </footer>
  </div>
</dialog>
