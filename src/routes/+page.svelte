<script lang="ts">
  import { onMount } from "svelte";
  import { api, onMailChanged, onOutbox, onSyncStatus } from "$lib/api";
  import { keymap } from "$lib/keys.svelte";
  import { mail } from "$lib/mail.svelte";
  import Setup from "$lib/components/Setup.svelte";
  import ThreadList from "$lib/components/ThreadList.svelte";
  import Reader from "$lib/components/Reader.svelte";
  import ShortcutHelp from "$lib/components/ShortcutHelp.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import Palette from "$lib/components/Palette.svelte";

  // `ready`: signed in, nothing modal open. Every mail binding hangs off it.
  const ready = () => !!mail.account && mail.overlay === null && !mail.composer;
  const inList = () => ready() && mail.view === "list";
  const inReader = () => ready() && mail.view === "reader";
  const hasThread = () => ready() && !!mail.current;

  let searchInput: HTMLInputElement | undefined = $state();

  function focusSearch() {
    mail.startSearch();
    queueMicrotask(() => searchInput?.focus());
  }

  function searchKeys(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      searchInput?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      searchInput?.blur();
      mail.endSearch();
    }
  }

  onMount(() => {
    mail.init();
    api.outboxStatus().then((s) => (mail.outbox = s));
    const unlisten = [
      onMailChanged(() => mail.scheduleRefresh()),
      onSyncStatus((s) => (mail.sync = s)),
      onOutbox((s) => {
        if (s.failed > mail.outbox.failed && s.lastError) mail.showToast({ text: `Couldn't sync a change: ${s.lastError}`, error: true });
        mail.outbox = s;
      }),
    ];

    const unregister = keymap.register([
      { id: "list.down", keys: "j", label: "Next conversation", group: "Navigate", when: ready, run: () => mail.move(1) },
      { id: "list.up", keys: "k", label: "Previous conversation", group: "Navigate", when: ready, run: () => mail.move(-1) },
      { id: "list.down.arrow", keys: "ArrowDown", label: "Next conversation", group: "Navigate", when: inList, run: () => mail.move(1) },
      { id: "list.up.arrow", keys: "ArrowUp", label: "Previous conversation", group: "Navigate", when: inList, run: () => mail.move(-1) },
      { id: "list.open", keys: "Enter", label: "Open conversation", group: "Navigate", when: inList, run: () => mail.open() },
      { id: "reader.back", keys: "Escape", label: "Back to list", group: "Navigate", when: inReader, run: () => mail.back() },
      { id: "search.clear", keys: "Escape", label: "Clear search", group: "Navigate", when: () => inList() && mail.search !== null, run: () => mail.endSearch() },
      { id: "list.top", keys: "g g", label: "Jump to top", group: "Navigate", when: inList, run: () => mail.select(0) },
      { id: "list.bottom", keys: "G", label: "Jump to bottom", group: "Navigate", when: inList, run: () => mail.select(mail.threads.length - 1) },
      { id: "split.next", keys: "Tab", label: "Next split", group: "Navigate", when: ready, run: () => mail.switchSplit(mail.splitIndex + 1) },
      { id: "split.prev", keys: "shift+Tab", label: "Previous split", group: "Navigate", when: ready, run: () => mail.switchSplit(mail.splitIndex - 1) },
      { id: "go.inbox", keys: "g i", label: "Go to inbox", group: "Go to", when: ready, run: () => mail.switchSplit(0) },
      { id: "search", keys: "/", label: "Search", group: "Go to", when: ready, run: focusSearch },

      { id: "triage.archive", keys: "e", label: "Archive", group: "Triage", when: hasThread, run: () => mail.act("archive") },
      { id: "triage.trash", keys: "#", label: "Delete", group: "Triage", when: hasThread, run: () => mail.act("trash") },
      { id: "triage.read", keys: "u", label: "Toggle read", group: "Triage", when: hasThread, run: () => mail.toggleRead() },
      { id: "triage.flag", keys: "s", label: "Toggle flag", group: "Triage", when: hasThread, run: () => mail.toggleFlag() },
      { id: "triage.undo", keys: "z", label: "Undo", group: "Triage", when: ready, run: () => mail.undo() },

      { id: "compose.new", keys: "c", label: "Compose", group: "Write", when: ready, run: () => mail.compose() },
      { id: "compose.reply", keys: "r", label: "Reply", group: "Write", when: hasThread, run: () => mail.respond("reply") },
      { id: "compose.replyAll", keys: "a", label: "Reply all", group: "Write", when: hasThread, run: () => mail.respond("replyAll") },
      { id: "compose.forward", keys: "f", label: "Forward", group: "Write", when: hasThread, run: () => mail.respond("forward") },

      { id: "reader.images", keys: "i", label: "Load images", group: "Read", when: inReader, run: () => (mail.imagesFor = mail.threadFor) },

      { id: "app.palette", keys: "ctrl+k", label: "Command palette", group: "App", when: () => !!mail.account && !mail.composer && mail.overlay !== "palette", run: () => (mail.overlay = "palette") },
      { id: "app.sync", keys: "ctrl+r", label: "Sync now", group: "App", when: ready, run: () => mail.syncNow() },
      { id: "app.settings", keys: "ctrl+,", label: "Settings", group: "App", when: ready, run: () => (mail.overlay = "settings") },
      { id: "app.help", keys: "?", label: "Keyboard shortcuts", group: "App", when: () => !!mail.account && !mail.composer, run: () => (mail.overlay = mail.overlay === "help" ? null : "help") },
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
    <header data-testid="inbox" class="flex h-11 shrink-0 items-center gap-1 border-b border-ink-800 px-3 text-sm">
      {#if mail.search === null}
        <nav data-testid="splits" class="flex items-center gap-1">
          {#each mail.splits as s, i (s.name)}
            <button
              data-testid="split-tab"
              data-active={i === mail.splitIndex}
              onclick={() => mail.switchSplit(i)}
              class={["rounded-md px-2.5 py-1", i === mail.splitIndex ? "bg-ink-800 font-semibold text-ink-100" : "text-ink-500 hover:text-ink-300"]}
            >
              {s.name}
              {#if s.unread}<span class="ml-1 text-xs font-normal text-accent">{s.unread}</span>{/if}
            </button>
          {/each}
        </nav>
        <span data-testid="thread-count" class="ml-3 text-xs text-ink-500">{mail.threads.length} conversations</span>
      {:else}
        <span class="px-2 text-ink-500">Search</span>
        <input
          data-testid="search-input"
          bind:this={searchInput}
          value={mail.search}
          oninput={(e) => mail.setSearch(e.currentTarget.value)}
          onkeydown={searchKeys}
          placeholder="from:sam is:unread budget"
          spellcheck="false"
          autocomplete="off"
          class="min-w-0 flex-1 bg-transparent px-1 text-ink-100 outline-none select-text"
        />
        <span data-testid="thread-count" class="text-xs text-ink-500">{mail.threads.length} conversations</span>
      {/if}
      <span class="ml-auto pl-4 text-xs text-ink-500">{mail.account.email}</span>
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
      {#if mail.outbox.pending}<span data-testid="outbox-pending">Sending {mail.outbox.pending} change{mail.outbox.pending === 1 ? "" : "s"}…</span>{/if}
      {#if mail.outbox.failed}<span data-testid="outbox-failed" class="text-red-300" title={mail.outbox.lastError ?? ""}>{mail.outbox.failed} failed</span>{/if}
      {#if keymap.pending.length}<span class="text-ink-300">{keymap.pending.join(" ")} …</span>{/if}
      <span class="ml-auto"><kbd>Ctrl</kbd> <kbd>K</kbd> commands · <kbd>?</kbd> shortcuts</span>
    </footer>
  {/if}

  {#if mail.toast}
    <div
      data-testid="toast"
      class={[
        "fixed bottom-10 left-1/2 z-40 -translate-x-1/2 rounded-md border px-4 py-2 text-sm shadow-xl select-text",
        mail.toast.error ? "border-red-900/60 bg-red-950/90 text-red-200" : "border-ink-700 bg-ink-800 text-ink-100",
      ]}
    >
      {mail.toast.text}
      {#if mail.toast.undo}<span class="ml-3 text-ink-500"><kbd>z</kbd> undo</span>{/if}
    </div>
  {/if}

  {#if mail.error}
    <div data-testid="app-error" class="fixed right-4 bottom-10 max-w-md rounded-md border border-red-900/60 bg-red-950/80 px-3 py-2 text-sm text-red-200 select-text">
      {mail.error}
    </div>
  {/if}
</div>

{#if mail.composer}<Composer />{/if}
{#if mail.overlay === "help"}<ShortcutHelp />{/if}
{#if mail.overlay === "settings"}<Settings />{/if}
{#if mail.overlay === "palette"}<Palette />{/if}
