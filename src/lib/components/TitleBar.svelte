<script lang="ts">
  // Custom title bar (the native one is turned off in lib.rs). The bar itself is a drag
  // region (double-click maximises); Windows still handles resize borders and snapping.
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { Copy, Minus, Search, Square, X } from "@lucide/svelte";
  import { mail } from "$lib/mail.svelte";

  const win = getCurrentWindow();
  let maximized = $state(false);

  const title = $derived.by(() => {
    if (!mail.account) return "PeetMail";
    if (mail.search !== null) return "Search";
    const tab = mail.splits[mail.splitIndex];
    if (!tab) return "PeetMail";
    return tab.unread ? `${tab.name} (${tab.unread})` : tab.name;
  });

  onMount(() => {
    const sync = async () => (maximized = await win.isMaximized());
    sync();
    const off = win.onResized(sync);
    return () => {
      off.then((f) => f());
    };
  });
</script>

<div data-testid="titlebar" data-tauri-drag-region class="flex h-9 shrink-0 items-center bg-chrome text-xs text-ink-500 select-none">
  <div data-tauri-drag-region class="flex w-40 items-center gap-2 pl-3">
    <span class="grid size-5 place-items-center rounded bg-accent text-[11px] font-bold text-chrome">P</span>
    <span data-tauri-drag-region class="text-ink-300">PeetMail</span>
  </div>

  <div data-tauri-drag-region class="flex flex-1 justify-center">
    <button
      data-testid="titlebar-command"
      onclick={() => mail.account && (mail.overlay = "palette")}
      title="Command palette (Ctrl+K)"
      class="flex w-full max-w-md items-center justify-center gap-2 rounded-md border border-ink-800 bg-ink-950/60 px-3 py-1 text-ink-300 hover:border-ink-700 hover:text-ink-100"
    >
      <Search size={13} />
      <span data-testid="titlebar-title" class="truncate">{title}</span>
    </button>
  </div>

  <div class="flex w-40 justify-end self-stretch">
    <button data-testid="window-minimize" onclick={() => win.minimize()} title="Minimise" class="grid w-11 place-items-center hover:bg-ink-800 hover:text-ink-100">
      <Minus size={15} />
    </button>
    <button data-testid="window-maximize" onclick={() => win.toggleMaximize()} title={maximized ? "Restore" : "Maximise"} class="grid w-11 place-items-center hover:bg-ink-800 hover:text-ink-100">
      {#if maximized}<Copy size={13} />{:else}<Square size={13} />{/if}
    </button>
    <button data-testid="window-close" onclick={() => win.close()} title="Close" class="grid w-11 place-items-center hover:bg-[#c42b1c] hover:text-white">
      <X size={16} />
    </button>
  </div>
</div>
