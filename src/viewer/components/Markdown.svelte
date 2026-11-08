<!--
  An agent's words, drawn from Markdown as T3 Code's chat draws them: headings,
  lists, quotes, tables, inline code, and code blocks with their language and a
  Copy button. Everything is Svelte text, never HTML (src/viewer/markdown.ts).
  Links open outside the app.
-->
<script lang="ts">
  import { parseMarkdown, type Align, type Block, type Inline } from '../markdown';
  import Icon from './Icon.svelte';

  let { text }: { text: string } = $props();

  const tree = $derived(parseMarkdown(text));

  // The text just copied, so its block says so for a moment.
  let copied = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(block: Extract<Block, { kind: 'code' }>): Promise<void> {
    try {
      await navigator.clipboard.writeText(block.text);
    } catch {
      return;
    }
    copied = block.text;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = null), 1500);
  }

  const alignStyle = (a: Align) => (a ? `text-align: ${a}` : undefined);
</script>

{#snippet inline(nodes: readonly Inline[])}
  {#each nodes as node, i (i)}
    {#if node.kind === 'text'}{node.text}{:else if node.kind === 'code'}<code>{node.text}</code>{:else if node.kind === 'strong'}<strong>{@render inline(node.children)}</strong>{:else if node.kind === 'em'}<em>{@render inline(node.children)}</em>{:else if node.kind === 'del'}<del>{@render inline(node.children)}</del>{:else if node.kind === 'link'}{#if node.href}<a href={node.href} target="_blank" rel="noopener noreferrer" title={node.href}>{@render inline(node.children)}</a>{:else}{@render inline(node.children)}{/if}{:else}<br />{/if}
  {/each}
{/snippet}

{#snippet blocks(nodes: readonly Block[])}
  {#each nodes as node, i (i)}
    {#if node.kind === 'paragraph'}
      <p>{@render inline(node.children)}</p>
    {:else if node.kind === 'heading'}
      <svelte:element this={`h${node.level}`}>{@render inline(node.children)}</svelte:element>
    {:else if node.kind === 'code'}
      <figure class="md-code">
        <figcaption>
          <span class="md-lang">{node.lang || 'text'}</span>
          <button type="button" class="md-copy" aria-label="Copy code" title="Copy" onclick={() => void copy(node)}>
            <Icon name={copied === node.text ? 'check' : 'copy'} />{copied === node.text ? 'Copied' : 'Copy'}
          </button>
        </figcaption>
        <pre><code>{node.text}</code></pre>
      </figure>
    {:else if node.kind === 'list'}
      {#if node.ordered}
        <ol class:is-tight={node.tight} start={node.start}>
          {#each node.items as item, j (j)}<li>{@render blocks(item.blocks)}</li>{/each}
        </ol>
      {:else}
        <ul class:is-tight={node.tight}>
          {#each node.items as item, j (j)}
            <li class:is-task={item.checked !== null}>
              {#if item.checked !== null}<input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Done' : 'Not done'} />{/if}
              {@render blocks(item.blocks)}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if node.kind === 'quote'}
      <blockquote>{@render blocks(node.blocks)}</blockquote>
    {:else if node.kind === 'table'}
      <div class="md-table">
        <table>
          <thead>
            <tr>{#each node.header as cell, c (c)}<th style={alignStyle(node.align[c])}>{@render inline(cell)}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each node.rows as row, r (r)}
              <tr>{#each row as cell, c (c)}<td style={alignStyle(node.align[c])}>{@render inline(cell)}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <hr />
    {/if}
  {/each}
{/snippet}

<div class="md">{@render blocks(tree)}</div>
