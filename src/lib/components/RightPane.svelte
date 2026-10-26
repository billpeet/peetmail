<script lang="ts">
  // Right-hand pane. For now it shows Recent Opens, like Superhuman: conversations you
  // opened, newest first, grouped by when. Click one to reopen it (even if archived).
  import { mail } from "$lib/mail.svelte";
  import { recentGroup, recentTime, senderName } from "$lib/format";
  import type { RecentOpen } from "$lib/api";

  // ----- resizing: drag the left edge, arrow keys when focused, double-click to reset -----
  const DEFAULT_WIDTH = 320;
  const MIN_WIDTH = 240;
  const MAX_WIDTH = 720;
  /** The mail list never gets narrower than this. */
  const MIN_LIST = 560;

  let viewport = $state(typeof window === "undefined" ? 1920 : window.innerWidth);
  const clamp = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(w, MAX_WIDTH, viewport - MIN_LIST)));
  let dragWidth = $state<number | null>(null);
  const width = $derived(clamp(dragWidth ?? mail.boot?.preferences.rightPaneWidth ?? DEFAULT_WIDTH));

  function save(w: number) {
    dragWidth = null;
    mail.setPreference("rightPaneWidth", clamp(w));
  }

  function startDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: PointerEvent) => (dragWidth = clamp(startWidth + (startX - ev.clientX)));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (dragWidth !== null) save(dragWidth);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function handleKeys(e: KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") save(width + step);
    else if (e.key === "ArrowRight") save(width - step);
    else if (e.key === "Home") save(DEFAULT_WIDTH);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

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
  <!-- Resize handle: a thin strip over the left border. A focusable separator is the ARIA
       "window splitter" pattern, which the linter doesn't recognise as interactive. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    data-testid="pane-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize right pane"
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={MAX_WIDTH}
    aria-valuenow={width}
    tabindex="0"
    title="Drag to resize · double-click to reset"
    onpointerdown={startDrag}
    ondblclick={() => save(DEFAULT_WIDTH)}
    onkeydown={handleKeys}
    class={[
      "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none",
      "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-accent/60 focus-visible:after:bg-accent",
      dragWidth !== null && "after:bg-accent",
    ]}
  ></div>
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
