<script lang="ts">
  // Every keyboard shortcut, by group, straight from the keymap registry (so it can't
  // drift from what the keys do). Used by the ? overlay and Help.
  import { keymap, displayKeys } from "$lib/keys.svelte";

  let { columns = 2 }: { columns?: 1 | 2 } = $props();

  const groups = $derived.by(() => {
    const map = new Map<string, typeof keymap.bindings>();
    // Palette-only commands (no keys) aren't shortcuts.
    for (const b of keymap.bindings) if (b.keys) map.set(b.group, [...(map.get(b.group) ?? []), b]);
    return [...map];
  });
</script>

<div data-testid="shortcut-list" class={["grid gap-x-8 gap-y-5", columns === 2 ? "grid-cols-2" : "grid-cols-1"]}>
  {#each groups as [group, bindings] (group)}
    <section>
      <h3 class="mb-2 text-xs tracking-wide text-ink-500 uppercase">{group}</h3>
      <ul class="space-y-1.5">
        {#each bindings as b (b.id)}
          <li class="flex items-center justify-between text-sm text-ink-300">
            <span>{b.label}</span>
            <span class="flex items-center gap-1">
              {#each displayKeys(b.keys) as step, i}
                {#if i > 0}<span class="text-xs text-ink-500">then</span>{/if}
                {#each step as k}<kbd>{k}</kbd>{/each}
              {/each}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
