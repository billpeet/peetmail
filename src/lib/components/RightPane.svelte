<script lang="ts">
  // Right-hand pane. For now it shows Recent Opens, like Superhuman: conversations you
  // opened, newest first, grouped by when. Click one to reopen it (even if archived).
  import { mail } from "$lib/mail.svelte";
  import { recentGroup, recentTime, senderName } from "$lib/format";
  import type { RecentOpen } from "$lib/api";
  import ResizeHandle from "./ResizeHandle.svelte";

  // ----- resizing (see ResizeHandle) -----
  const DEFAULT_WIDTH = 320;
  const MIN_WIDTH = 240;
  /** The mail list never gets narrower than this. */
  const MIN_LIST = 560;

  let viewport = $state(typeof window === "undefined" ? 1920 : window.innerWidth);
  const maxWidth = $derived(Math.max(MIN_WIDTH, Math.min(720, viewport - MIN_LIST)));
  let dragWidth = $state<number | null>(null);
  const width = $derived(
    Math.round(Math.max(MIN_WIDTH, Math.min(dragWidth ?? mail.boot?.preferences.rightPaneWidth ?? DEFAULT_WIDTH, maxWidth))),
  );

  const groups = $derived.by(() => {
    const now = new Date();
    const out: { label: string; items: RecentOpen[] }[] = [];
    for (const r of mail.recent) {
      const label = recentGroup(r.openedAt, now);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1)!.items.push(r);
    }
    return out;
  });

  const me = $derived(mail.account?.email.toLowerCase());
  const who = (r: RecentOpen) => (r.fromAddress?.toLowerCase() === me ? "Me" : senderName(r.fromName, r.fromAddress));
  const isOpen = (r: RecentOpen) => mail.view === "reader" && mail.current?.conversationId === r.conversationId;
</script>

<svelte:window bind:innerWidth={viewport} />

<aside data-testid="right-pane" style:width="{width}px" data-width={width} class="relative flex shrink-0 flex-col border-l border-ink-800 bg-ink-950">
  <ResizeHandle
    edge="left"
    testid="pane-resize"
    label="Resize right pane"
    value={width}
    min={MIN_WIDTH}
    max={maxWidth}
    defaultValue={DEFAULT_WIDTH}
    onpreview={(w) => (dragWidth = w)}
    onchange={(w) => mail.setPreference("rightPaneWidth", w)}
  />
  <h2 class="px-6 pt-5 pb-3 text-[15px] font-semibold text-ink-100">Recent Opens</h2>
  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
    {#each groups as g (g.label)}
      <section class="mb-4">
        <h3 class="px-3 py-1.5 text-xs font-semibold text-ink-300">{g.label}</h3>
        <ul>
          {#each g.items as r (r.accountId + r.conversationId)}
            <li>
              <button
                data-testid="recent-item"
                data-conversation-id={r.conversationId}
                onclick={() => mail.openRecent(r)}
                class={["block w-full rounded-md px-3 py-1.5 text-left", isOpen(r) ? "bg-ink-800" : "hover:bg-ink-900"]}
              >
                <span class="flex items-baseline gap-2 text-[13px]">
                  <span class="truncate font-semibold text-ink-100">{who(r)}</span>
                  <span class="shrink-0 text-xs text-ink-500">{recentTime(r.openedAt)}</span>
                </span>
                <span class="block truncate text-[13px] text-ink-300">{r.subject || "(no subject)"}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {:else}
      <p data-testid="recent-empty" class="px-3 text-sm text-ink-500">Conversations you open show up here.</p>
    {/each}
  </div>
</aside>
