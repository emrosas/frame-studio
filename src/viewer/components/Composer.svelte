<!--
  The prompt box, for a new thread and for replies: what it's about, the
  prompt, reference images (paste, drop, or attach), and who works it (ADR
  0006), folded into one pill. Return sends; Shift+Return starts a new line; Esc
  hands the keyboard back to the viewer. Typing @ lists the scene's layers, and
  picking one sets the selection without adding any text. A thread keeps its
  agent, so replies show it fixed. An agent that isn't ready says why and which
  command fixes it; the studio never asks for credentials itself.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MAX_REFERENCE_BYTES, REFERENCE_TYPES, type AgentId, type AgentStatus, type TurnSettings } from '../../studio/protocol';
  import Icon from './Icon.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import Popover from './Popover.svelte';

  let {
    value = $bindable(''),
    files = $bindable([]),
    agent = $bindable(),
    settings = $bindable(),
    agents,
    layers,
    onmention,
    fixed = false,
    label,
    placeholder,
    target,
    sendLabel,
    canSend,
    onsubmit,
    onproblem,
    onrefresh,
    onpick,
  }: {
    value?: string;
    files?: { file: File; url: string }[];
    agent: AgentId;
    settings: TurnSettings;
    agents: AgentStatus[];
    /** The scene's layers, top first, for the @ list. */
    layers: readonly { id: string }[];
    /** A layer was picked from the @ list. */
    onmention: (id: string) => void;
    fixed?: boolean;
    label: string;
    placeholder: string;
    /** What the prompt is about: the selection token. */
    target: Snippet;
    sendLabel: string;
    canSend: boolean;
    onsubmit: () => void;
    onproblem: (text: string) => void;
    onrefresh: () => void;
    /** You chose an agent in the picker. */
    onpick?: (id: AgentId) => void;
  } = $props();

  let dragging = $state(false);
  let picker = $state<HTMLInputElement | null>(null);
  let box = $state<HTMLTextAreaElement | null>(null);

  const status = $derived(agents.find((a) => a.id === agent));
  const external = $derived(agent === 'external');
  const choices = $derived(agents.filter((a) => a.ready).length);
  // The agent you could have instead, when the external one is all that's ready.
  const signedOut = $derived(!fixed && choices === 1 && external ? agents.find((a) => a.id !== 'external' && a.fix) : undefined);

  // ---- the @ list ----

  /** The @ being typed: where it starts, and the row the keyboard is on. */
  let mention = $state<{ start: number; query: string; index: number } | null>(null);
  const LIST_MAX = 8;
  const matches = $derived(mention ? layers.filter((l) => l.id.toLowerCase().includes(mention!.query)).slice(0, LIST_MAX) : []);

  function readMention(): void {
    if (!box) return;
    const caret = box.selectionStart;
    const typed = /(?:^|\s)@([^\s@]*)$/.exec(box.value.slice(0, caret));
    if (!typed) {
      mention = null;
      return;
    }
    const query = typed[1].toLowerCase();
    mention = { start: caret - typed[1].length - 1, query, index: mention?.query === query ? mention.index : 0 };
  }

  /** Sets the selection and takes the typed @ back out, so the token says it and the prompt doesn't. */
  function pickMention(id: string): void {
    if (!mention || !box) return;
    const caret = box.selectionStart;
    const start = mention.start;
    value = value.slice(0, start) + value.slice(caret);
    mention = null;
    onmention(id);
    const field = box;
    queueMicrotask(() => {
      field.focus();
      field.setSelectionRange(start, start);
    });
  }

  function onPromptKey(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void {
    if (mention && matches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        pickMention(matches[Math.min(mention.index, matches.length - 1)].id);
        return;
      }
    }
    // A popover that took this Escape marked it, so the first press only closes that.
    if (e.key === 'Escape') {
      if (!e.defaultPrevented) {
        e.currentTarget.blur();
        // Back to where Return came from, so Up and Down still walk the layers.
        document.querySelector<HTMLElement>('.tl-row.is-selected')?.focus({ preventScroll: true });
      }
      return;
    }
    // keyCode 229: Safari's Enter that ends an input method composition, which it doesn't mark as composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (canSend) onsubmit();
    }
  }

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
{#if signedOut}
  <p class="agent-note is-quiet" role="status">
    To let {signedOut.label} work here, run <code>{signedOut.fix}</code> in a terminal, then
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
  <div class="composer-target">{@render target()}</div>
  {#if mention && matches.length > 0}
    <Popover label="Layers" role="listbox" class="mention-menu" onclose={() => (mention = null)}>
      {#each matches as layer, i (layer.id)}
        <button
          type="button"
          role="option"
          class="menu-item"
          class:is-on={i === mention.index}
          aria-selected={i === mention.index}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => pickMention(layer.id)}>{layer.id}</button
        >
      {/each}
    </Popover>
  {/if}
  <textarea
    aria-label={label}
    rows="2"
    {placeholder}
    bind:this={box}
    bind:value
    oninput={readMention}
    onblur={() => (mention = null)}
    onpaste={(e) => {
      const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (images.length > 0) {
        e.preventDefault();
        addFiles(images);
      }
    }}
    onkeydown={onPromptKey}
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
      <Icon name="plus" />
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
    <ModelPicker bind:agent bind:settings {agents} {fixed} {onpick} {onrefresh} />
    <span class="spacer"></span>
    <button type="button" class="send-button" aria-label={sendLabel} title="{sendLabel} (Return)" disabled={!canSend} onclick={onsubmit}>
      <Icon name="send" />
    </button>
  </div>
</div>
