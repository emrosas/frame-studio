<!--
  The brand mark, as the app icon draws it (tools/desktop/icon.ts): four
  viewfinder corners around the accent dot, on a black rounded square.
-->
<script lang="ts">
  let { size = 22 }: { size?: number } = $props();
</script>

<svg class="logo" width={size} height={size} viewBox="0 0 824 824" aria-hidden="true">
  <rect width="824" height="824" rx="190" fill="#111" />
  <path
    d="M162 308V162h146M516 162h146v146M662 516v146H516M308 662H162V516"
    fill="none"
    stroke="#f5f5f4"
    stroke-width="56"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <circle cx="412" cy="412" r="116" fill="var(--accent, #ff5a1f)" />
</svg>
