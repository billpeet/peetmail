<script lang="ts" module>
  import type { Component } from "svelte";

  export type SidebarPage = { id: string; label: string; icon: Component<{ size?: number; class?: string }>; separatorBefore?: boolean };
</script>

<script lang="ts">
  // A dialog with its sections down the left (Settings, Help). Arrow keys move through the
  // sections; Ctrl+PageDown / Ctrl+PageUp work from anywhere in it (registered by the owner).
  import type { Snippet } from "svelte";
  import { mail } from "$lib/mail.svelte";

  let {
    testid,
    title,
    pages,
    current = $bindable(),
    children,
  }: { testid: string; title: string; pages: SidebarPage[]; current: string; children: Snippet } = $props();

  let nav: HTMLElement | undefined = $state();

  function navKeys(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = pages.findIndex((p) => p.id === current);
    const next = pages[(i + (e.key === "ArrowDown" ? 1 : pages.length - 1)) % pages.length];
    current = next.id;
    nav?.querySelector<HTMLButtonElement>(`[data-page="${next.id}"]`)?.focus();
  }

  // Open with the current section focused, so the arrow keys work straight away.
  $effect(() => {
    nav?.querySelector<HTMLButtonElement>(`[data-page="${current}"]`)?.focus();
  });
</script>

<div data-testid={testid} data-page={current} onclick={(e) => e.target === e.currentTarget && (mail.overlay = null)} role="presentation" class="fixed inset-x-0 top-9 bottom-0 z-20 grid place-items-center bg-black/60">
  <div class="flex h-[min(760px,88vh)] w-[min(960px,94vw)] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
    <nav bind:this={nav} aria-label={title} class="flex w-52 shrink-0 flex-col border-r border-ink-800 bg-ink-950/50 p-3">
      <h2 class="px-2 pt-1 pb-4 text-sm font-semibold text-ink-100">{title}</h2>
      <div role="tablist" aria-orientation="vertical" tabindex="-1" onkeydown={navKeys} class="flex flex-col">
      {#each pages as p (p.id)}
        {#if p.separatorBefore}<div class="mx-2 my-2 border-t border-ink-800"></div>{/if}
        <button
          data-testid="{testid}-nav-{p.id}"
          data-page={p.id}
          role="tab"
          aria-selected={current === p.id}
          onclick={() => (current = p.id)}
          class={[
            "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-accent",
            current === p.id ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:bg-ink-900 hover:text-ink-100",
          ]}
        >
          <p.icon size={15} class={current === p.id ? "text-accent" : ""} />
          {p.label}
        </button>
      {/each}
      </div>
      <p class="mt-auto px-2 pt-3 text-[11px] leading-relaxed text-ink-500"><kbd>Ctrl</kbd> <kbd>PgUp</kbd>/<kbd>PgDn</kbd> switch · <kbd>Esc</kbd> close</p>
    </nav>
    <div class="min-w-0 flex-1 overflow-y-auto px-8 py-7">
      {@render children()}
    </div>
  </div>
</div>
