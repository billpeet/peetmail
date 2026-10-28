<script lang="ts">
  // Custom title bar (the native one is turned off in lib.rs). The bar itself is a drag
  // region (double-click maximises); Windows still handles resize borders and snapping.
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { Copy, Minus, Search, Square, X } from "@lucide/svelte";
  import { mail } from "#lib/mail.svelte.js";

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
    <!-- The app's mark (src-tauri/icons/source/peetmail.svg without its tile). It ignores the
         pointer so dragging from it still moves the window. -->
    <svg data-testid="titlebar-mark" class="pointer-events-none size-5" viewBox="200 202 640 640" aria-hidden="true">
      <defs>
        <linearGradient id="titlebar-mark-cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bcc1ff" /><stop offset="1" stop-color="#8f97ff" /></linearGradient>
      </defs>
      <rect x="270" y="252" width="168" height="586" rx="84" fill="#5d64cc" />
      <rect x="270" y="252" width="498" height="384" rx="100" fill="#5d64cc" />
      <rect x="270" y="206" width="168" height="586" rx="84" fill="url(#titlebar-mark-cap)" />
      <rect x="270" y="206" width="498" height="384" rx="100" fill="url(#titlebar-mark-cap)" />
      <path d="M 356 304 L 530 432 L 704 304" fill="none" stroke="#1c1c1f" stroke-width="64" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
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
