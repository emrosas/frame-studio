<!--
  A scene's poster, letterboxed on the stage colour. The picture fades in once
  the render worker has made it. With `project`, it's a poster of a listed
  project on another server, which the app reads off disk.
-->
<script lang="ts" module>
  import { desktop } from '../desktop';

  /** The file name holds a hash of the picture, so a poster never changes. */
  const posters = new Map<string, Promise<string | null>>();

  function posterOf(project: string, file: string): Promise<string | null> {
    const key = `${project}\n${file}`;
    let poster = posters.get(key);
    if (!poster) {
      poster = desktop()?.poster(project, file).catch(() => null) ?? Promise.resolve(null);
      posters.set(key, poster);
    }
    return poster;
  }
</script>

<script lang="ts">
  let { file, project = null }: { file: string | null | undefined; project?: string | null } = $props();

  let loaded = $state<string | null>(null);
  let read = $state<string | null>(null);

  $effect(() => {
    if (!project || !file) return;
    let live = true;
    void posterOf(project, file).then((url) => {
      if (live) read = url;
    });
    return () => {
      live = false;
    };
  });

  const src = $derived(project ? read : file ? `/__studio/thumbs/${encodeURIComponent(file)}` : null);
</script>

<span class="thumb" aria-hidden="true">
  {#if src}
    <img {src} alt="" draggable="false" class:is-loaded={loaded === src} onload={() => (loaded = src)} />
  {/if}
</span>
