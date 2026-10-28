<script lang="ts">
  // A group of related settings: a heading, an optional line of explanation, and its rows.
  import type { Snippet } from "svelte";

  let { title, description, testid, children }: { title?: string; description?: string; testid?: string; children: Snippet } = $props();
</script>

<section data-testid={testid} class="space-y-2">
  {#if title}<h3 class="text-sm font-medium text-ink-100">{title}</h3>{/if}
  {#if description}<p class="text-xs leading-relaxed text-ink-500">{description}</p>{/if}
  <div class="divide-y divide-ink-800 rounded-lg border border-ink-800 bg-ink-950/40 px-4">
    {@render children()}
  </div>
</section>
