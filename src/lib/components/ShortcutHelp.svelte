<script lang="ts">
  import { keymap, displayKeys } from "$lib/keys.svelte";
  import { mail } from "$lib/mail.svelte";

  const groups = $derived.by(() => {
    const map = new Map<string, typeof keymap.bindings>();
    // Palette-only commands (no keys) aren't shortcuts.
    for (const b of keymap.bindings) if (b.keys) map.set(b.group, [...(map.get(b.group) ?? []), b]);
    return [...map];
  });
</script>

<div data-testid="shortcut-help" onclick={(e) => e.target === e.currentTarget && (mail.overlay = null)} role="presentation" class="fixed inset-x-0 top-9 bottom-0 z-20 grid place-items-center bg-black/60">
  <div class="w-[560px] rounded-xl border border-ink-700 bg-ink-900 p-6 shadow-2xl">
    <h2 class="mb-4 text-sm font-semibold text-ink-100">Keyboard shortcuts</h2>
    <div class="grid grid-cols-2 gap-x-8 gap-y-5">
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
  </div>
</div>
