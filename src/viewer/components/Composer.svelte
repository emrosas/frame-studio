<!--
  The prompt box, for a new thread and for replies: what it's about, the
  prompt, reference images (paste, drop, or attach), and who works it (ADR
  0006): the agent, its model and effort, and full access. Return sends;
  Shift+Return starts a new line. A thread keeps its agent, so replies show it
  fixed. An agent that isn't ready says why and which command fixes it; the
  studio never asks for credentials itself.
-->
<script lang="ts">
  import { MAX_REFERENCE_BYTES, REFERENCE_TYPES, type AgentId, type AgentStatus, type TurnSettings } from '../../studio/protocol';
  import Icon from './Icon.svelte';

  let {
    value = $bindable(''),
    files = $bindable([]),
    agent = $bindable(),
    settings = $bindable(),
    agents,
    fixed = false,
    label,
    placeholder,
    target,
    sendLabel,
    canSend,
    onsubmit,
    onproblem,
    onrefresh,
  }: {
    value?: string;
    files?: { file: File; url: string }[];
    agent: AgentId;
    settings: TurnSettings;
    agents: AgentStatus[];
    fixed?: boolean;
    label: string;
    placeholder: string;
    /** What the prompt is about, e.g. "bear › nose · [12, 24)". */
    target: string;
    sendLabel: string;
    canSend: boolean;
    onsubmit: () => void;
    onproblem: (text: string) => void;
    onrefresh: () => void;
  } = $props();

  let dragging = $state(false);
  let picker = $state<HTMLInputElement | null>(null);

  const status = $derived(agents.find((a) => a.id === agent));
  const external = $derived(agent === 'external');

  // Keep the model and effort to ones this agent offers. Before the pickers render, since a select bound to a
  // value it doesn't offer takes its first option instead.
  $effect.pre(() => {
    const s = status;
    if (!s) return;
    if (s.models.length > 0 && !s.models.some((m) => m.id === settings.model)) settings.model = s.models[0].id;
    if (s.efforts.length > 0 && (settings.effort === undefined || !s.efforts.includes(settings.effort))) {
      settings.effort = s.efforts.includes('medium') ? 'medium' : s.efforts[0];
    }
  });

  function addFiles(list: Iterable<File>): void {
    for (const file of list) {
      if (!(file.type in REFERENCE_TYPES)) {
        onproblem(`${file.name || 'That file'} is not a PNG, JPEG or WebP image.`);
        continue;
      }
      if (file.size > MAX_REFERENCE_BYTES) {
        onproblem(`${file.name} is over ${MAX_REFERENCE_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      files.push({ file, url: URL.createObjectURL(file) });
    }
  }

  function removeFile(i: number): void {
    URL.revokeObjectURL(files[i].url);
    files.splice(i, 1);
  }
</script>

{#if status && !status.ready}
  <p class="agent-note" role="status">
    {status.label} isn't ready: {status.detail}.
    {#if status.fix}Run <code>{status.fix}</code> in a terminal, then{/if}
    <button type="button" class="link-btn" onclick={onrefresh}>check again</button>
  </p>
{/if}
<div
  class="composer"
  class:is-dragging={dragging}
  role="group"
  aria-label={label}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer) addFiles(e.dataTransfer.files);
  }}
>
  <div class="composer-target" title="What this is about. Select on the canvas to change it.">
    <Icon name="viewfinder" size={13} />
    <span>{target}</span>
  </div>
  <textarea
    aria-label={label}
    rows="2"
    {placeholder}
    bind:value
    onpaste={(e) => {
      const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (images.length > 0) {
        e.preventDefault();
        addFiles(images);
      }
    }}
    onkeydown={(e) => {
      // keyCode 229: Safari's Enter that ends an input method composition, which it doesn't mark as composing.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (canSend) onsubmit();
      }
    }}
  ></textarea>
  {#if files.length > 0}
    <ul class="composer-refs" aria-label="Reference images">
      {#each files as f, i (f.url)}
        <li>
          <img src={f.url} alt={f.file.name} />
          <button type="button" class="ref-remove" aria-label="Remove {f.file.name}" onclick={() => removeFile(i)}>×</button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="composer-tools">
    <button type="button" class="attach" aria-label="Attach image" title="Attach a reference image (or paste or drop one)" onclick={() => picker?.click()}>
      <Icon name="plus" size={15} />
    </button>
    <input
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      hidden
      bind:this={picker}
      onchange={(e) => {
        addFiles(e.currentTarget.files ?? []);
        e.currentTarget.value = '';
      }}
    />
    {#if fixed}
      <span class="picker is-fixed" title="A thread keeps its agent; start a new thread to use another">{status?.label ?? agent}</span>
    {:else}
      <span class="picker" title="Who works this thread">
        <select aria-label="Agent" bind:value={agent}>
          {#each agents as a (a.id)}
            <option value={a.id}>{a.label}{a.ready ? '' : ' (not ready)'}</option>
          {/each}
        </select>
        <Icon name="chevronDown" size={13} />
      </span>
    {/if}
    {#if !external && status}
      {#if status.models.length > 1}
        <span class="picker">
          <select aria-label="Model" bind:value={settings.model}>
            {#each status.models as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
          </select>
          <Icon name="chevronDown" size={13} />
        </span>
      {/if}
      {#if status.efforts.length > 0}
        <span class="picker">
          <select aria-label="Effort" bind:value={settings.effort}>
            {#each status.efforts as e (e)}<option value={e}>{e}</option>{/each}
          </select>
          <Icon name="chevronDown" size={13} />
        </span>
      {/if}
      <label class="toggle" title="Without full access, the agent asks before editing files outside scenes/, rigs and audio, and before running commands">
        <input type="checkbox" checked={settings.access === 'full'} onchange={(e) => (settings.access = e.currentTarget.checked ? 'full' : 'studio')} />
        Full access
      </label>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="send-button" aria-label={sendLabel} title="{sendLabel} (Return)" disabled={!canSend} onclick={onsubmit}>
      <Icon name="send" size={16} />
    </button>
  </div>
</div>
