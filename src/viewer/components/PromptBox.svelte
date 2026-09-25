<!--
  A prompt with reference images: type, paste or drop images, attach from a
  file, and Cmd/Ctrl+Enter to send. Used to start a thread and to reply in one.
-->
<script lang="ts">
  import { MAX_REFERENCE_BYTES, REFERENCE_TYPES } from '../../studio/protocol';

  let {
    value = $bindable(''),
    files = $bindable([]),
    label,
    placeholder,
    rows = 3,
    onsubmit,
    onproblem,
  }: {
    value?: string;
    files?: { file: File; url: string }[];
    label: string;
    placeholder: string;
    rows?: number;
    onsubmit: () => void;
    onproblem: (text: string) => void;
  } = $props();

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

<div
  class="prompt-box"
  role="group"
  aria-label={label}
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => {
    e.preventDefault();
    if (e.dataTransfer) addFiles(e.dataTransfer.files);
  }}
>
  <textarea
    class="composer-prompt"
    aria-label={label}
    {rows}
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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onsubmit();
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
  <label class="attach">
    Attach image
    <input
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      hidden
      onchange={(e) => {
        addFiles(e.currentTarget.files ?? []);
        e.currentTarget.value = '';
      }}
    />
  </label>
</div>
