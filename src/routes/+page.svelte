<script lang="ts">
  import { onMount } from "svelte";
  import { onMailChanged, onSyncStatus } from "$lib/api";
  import { keymap } from "$lib/keys.svelte";
  import { mail } from "$lib/mail.svelte";
  import Setup from "$lib/components/Setup.svelte";
  import ThreadList from "$lib/components/ThreadList.svelte";
  import Reader from "$lib/components/Reader.svelte";
  import ShortcutHelp from "$lib/components/ShortcutHelp.svelte";
  import Settings from "$lib/components/Settings.svelte";

  const ready = () => !!mail.account && mail.overlay === null;
  const inList = () => ready() && mail.view === "list";
  const inReader = () => ready() && mail.view === "reader";

  onMount(() => {
    mail.init();
    const unlisten = [onMailChanged(() => mail.scheduleRefresh()), onSyncStatus((s) => (mail.sync = s))];

    const unregister = keymap.register([
      { id: "list.down", keys: "j", label: "Next conversation", group: "Navigate", when: ready, run: () => mail.move(1) },
      { id: "list.up", keys: "k", label: "Previous conversation", group: "Navigate", when: ready, run: () => mail.move(-1) },
      { id: "list.down.arrow", keys: "ArrowDown", label: "Next conversation", group: "Navigate", when: inList, run: () => mail.move(1) },
      { id: "list.up.arrow", keys: "ArrowUp", label: "Previous conversation", group: "Navigate", when: inList, run: () => mail.move(-1) },
      { id: "list.open", keys: "Enter", label: "Open conversation", group: "Navigate", when: inList, run: () => mail.open() },
      { id: "reader.back", keys: "Escape", label: "Back to list", group: "Navigate", when: inReader, run: () => mail.back() },
      { id: "list.top", keys: "g g", label: "Jump to top", group: "Navigate", when: inList, run: () => mail.select(0) },
      { id: "list.bottom", keys: "G", label: "Jump to bottom", group: "Navigate", when: inList, run: () => mail.select(mail.threads.length - 1) },
      { id: "go.inbox", keys: "g i", label: "Go to inbox", group: "Go to", when: ready, run: () => { mail.back(); mail.select(0); } },
      { id: "app.sync", keys: "ctrl+r", label: "Sync now", group: "App", when: ready, run: () => mail.syncNow() },
      { id: "app.settings", keys: "ctrl+,", label: "Settings", group: "App", when: ready, run: () => (mail.overlay = "settings") },
      { id: "app.help", keys: "?", label: "Keyboard shortcuts", group: "App", when: () => !!mail.account, run: () => (mail.overlay = mail.overlay === "help" ? null : "help") },
      { id: "app.close", keys: "Escape", label: "Close dialog", group: "App", when: () => mail.overlay !== null, run: () => (mail.overlay = null) },
    ]);

    return () => {
      unregister();
      unlisten.forEach((p) => p.then((f) => f()));
    };
  });

  const syncLabel = $derived(
    mail.sync.state === "syncing" ? "Syncing…" : mail.sync.state === "error" ? "Sync error" : "Up to date",
  );
</script>

<div class="flex h-full flex-col bg-ink-950 text-ink-100">
  {#if !mail.boot}
    <!-- bootstrap is a single local query; nothing to show -->
  {:else if !mail.account}
    <Setup />
  {:else}
    <header data-testid="inbox" class="flex h-11 shrink-0 items-center gap-6 border-b border-ink-800 px-5 text-sm">
      <span class="font-semibold">Inbox</span>
      <span data-testid="thread-count" class="text-ink-500">{mail.threads.length} conversations</span>
      <span class="ml-auto text-xs text-ink-500">{mail.account.email}</span>
    </header>

    <main class="min-h-0 flex-1">
      {#if mail.view === "list"}
        <ThreadList />
      {:else}
        <Reader />
      {/if}
    </main>

    <footer class="flex h-7 shrink-0 items-center gap-4 border-t border-ink-800 px-5 text-xs text-ink-500">
      <span data-testid="sync-status" data-state={mail.sync.state} class={mail.sync.state === "error" ? "text-red-300" : ""} title={mail.sync.message ?? ""}>{syncLabel}</span>
      {#if keymap.pending.length}<span class="text-ink-300">{keymap.pending.join(" ")} …</span>{/if}
      <span class="ml-auto"><kbd>?</kbd> shortcuts</span>
    </footer>
  {/if}

  {#if mail.error}
    <div data-testid="app-error" class="fixed right-4 bottom-10 max-w-md rounded-md border border-red-900/60 bg-red-950/80 px-3 py-2 text-sm text-red-200 select-text">
      {mail.error}
    </div>
  {/if}
</div>

{#if mail.overlay === "help"}<ShortcutHelp />{/if}
{#if mail.overlay === "settings"}<Settings />{/if}
