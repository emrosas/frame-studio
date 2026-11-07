<!--
  Settings (ADR 0017): the voice providers' keys and which projects' code you
  trust. A key shows here as its provider, last four and date, since main never
  hands over more. Removing one deletes it from this computer, and only the
  provider's own page kills a copy. Trust can be taken back here; granting it
  goes through main's native prompt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { desktop, type DesktopTrust, type VoiceProvider } from '../desktop';
  import Icon from './Icon.svelte';

  let { onclose }: { onclose: () => void } = $props();

  const app = desktop();
  let dialog = $state<HTMLDialogElement | null>(null);
  let providers = $state<VoiceProvider[]>([]);
  let refusal = $state<string | null>(null);
  let trust = $state<Awaited<ReturnType<DesktopTrust['state']>>>(null);

  async function refresh(): Promise<void> {
    const listed = await app?.voice.providers();
    providers = listed?.providers ?? [];
    refusal = listed?.refusal ?? null;
    trust = (await app?.trust.state()) ?? null;
  }

  onMount(() => {
    dialog?.showModal();
    void refresh();
  });

  const close = () => {
    dialog?.close();
    onclose();
  };

  async function addKey(id: string): Promise<void> {
    await app?.voice.addKey(id);
    await refresh();
  }

  async function removeKey(id: string): Promise<void> {
    await app?.voice.removeKey(id);
    await refresh();
  }

  const shortName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
</script>

<dialog bind:this={dialog} class="new-dialog settings-dialog" aria-label="Settings" oncancel={(e) => { e.preventDefault(); close(); }}>
  <div class="voice-form">
    <header>
      <h2>Settings</h2>
      <button type="button" class="icon-btn" aria-label="Close" onclick={close}><Icon name="close" /></button>
    </header>

    <section aria-label="Voice providers" class="settings-section">
      <h3>Voice providers</h3>
      {#if !app}
        <p class="field-hint">Keys live in the desktop app, which encrypts them. In a browser, Kokoro is the voice.</p>
      {:else}
        {#if refusal}<p class="panel-note is-error" role="alert">{refusal}</p>{/if}
        <ul class="settings-rows">
          {#each providers as p (p.id)}
            <li>
              <span class="settings-row-main">
                <span class="settings-name"><Icon name={p.id === 'elevenlabs' ? 'elevenlabs' : 'kokoro'} />{p.label}</span>
                <span class="field-hint">{p.key ? `Key ending ${p.key.last4}, added ${p.key.added}` : 'No key'}</span>
              </span>
              {#if p.key}
                <a class="link-btn" href={p.keyPage} target="_blank" rel="noopener" title="Removing a key here leaves copies working. Only the provider's page revokes it.">Revoke at {p.label}</a>
                <button type="button" class="btn is-small" aria-label="Remove {p.label} key" onclick={() => removeKey(p.id)}>Remove</button>
              {:else if !refusal}
                <button type="button" class="btn is-small" aria-label="Add {p.label} key" onclick={() => addKey(p.id)}>Add key</button>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="field-hint">A key is encrypted by your system and stays in the app. Use one with a spending limit.</p>
      {/if}
    </section>

    {#if app}
      <section aria-label="Project code" class="settings-section">
        <h3>Project code</h3>
        {#if trust && !trust.trusted}
          <p class="settings-now">
            <span class="field-hint">{shortName(trust.folder)} opened without its code.</span>
            <button type="button" class="btn is-small" onclick={() => void app.trust.ask()}>Trust this project…</button>
          </p>
        {/if}
        {#if trust && trust.trustedFolders.length > 0}
          <ul class="settings-rows">
            {#each trust.trustedFolders as folder (folder.path)}
              <li>
                <span class="settings-row-main">
                  <span class="settings-name" title={folder.path}>{shortName(folder.path)}</span>
                  <span class="field-hint">Trusted {folder.added}</span>
                </span>
                <button
                  type="button"
                  class="btn is-small"
                  aria-label="Revoke trust in {shortName(folder.path)}"
                  onclick={async () => {
                    await app.trust.revoke(folder.path);
                    await refresh();
                  }}>Revoke</button
                >
              </li>
            {/each}
          </ul>
        {:else}
          <p class="field-hint">No project's code is trusted yet.</p>
        {/if}
      </section>
    {/if}
  </div>
</dialog>
