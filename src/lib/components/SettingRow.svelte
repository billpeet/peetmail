<script lang="ts">
  // One setting: its name and a short hint on the left, the control on the right. A row
  // without a control (`children`) is a plain block of content in the card.
  import type { Snippet } from "svelte";

  let { label, hint, children, block }: { label?: string; hint?: string; children?: Snippet; block?: Snippet } = $props();
</script>

<div class="py-3">
  {#if label}
    <div class="flex items-center justify-between gap-6">
      <div class="min-w-0">
        <div class="text-sm text-ink-100">{label}</div>
        {#if hint}<div class="mt-0.5 text-xs leading-relaxed text-ink-500">{hint}</div>{/if}
      </div>
      {#if children}<div class="shrink-0">{@render children()}</div>{/if}
    </div>
  {/if}
  {#if block}<div class={label ? "mt-3" : ""}>{@render block()}</div>{/if}
</div>
