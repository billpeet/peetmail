<script lang="ts">
  // Fixed-height virtual list: only the visible rows (plus overscan) are in the DOM,
  // so a 50k-thread inbox costs the same to render as a 50-thread one.
  import { mail } from "$lib/mail.svelte";
  import { listDate, senderName } from "$lib/format";

  const ROW = 40;
  const OVERSCAN = 10;

  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(0);

  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const end = $derived(Math.min(mail.threads.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN));
  const visible = $derived(mail.threads.slice(start, end));

  // Keep the selected row in view without animating; smooth scrolling feels slow under j/k.
  $effect(() => {
    const top = mail.selected * ROW;
    if (!viewport) return;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW - viewport.clientHeight;
  });

  function onScroll() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    if (end >= mail.threads.length - OVERSCAN) mail.loadMore();
  }
</script>

<div bind:this={viewport} bind:clientHeight={height} onscroll={onScroll} data-testid="thread-list" class="h-full overflow-y-auto">
  {#if mail.threads.length === 0}
    <div data-testid="thread-list-empty" class="grid h-full place-items-center text-sm text-ink-500">
      {mail.sync.state === "syncing" ? "Syncing your inbox…" : "Inbox zero."}
    </div>
  {:else}
    <div style:height="{mail.threads.length * ROW}px" class="relative">
      {#each visible as t, i (t.conversationId)}
        {@const index = start + i}
        {@const selected = index === mail.selected}
        {@const unread = t.unreadCount > 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          role="option"
          data-testid="thread-row"
          data-conversation-id={t.conversationId}
          data-unread={unread}
          tabindex="-1"
          aria-selected={selected}
          onclick={() => mail.select(index)}
          ondblclick={() => mail.open()}
          style:top="{index * ROW}px"
          style:height="{ROW}px"
          class={[
            "absolute inset-x-0 flex cursor-default items-center gap-4 border-l-2 px-5 text-sm",
            selected ? "border-accent bg-ink-800" : "border-transparent hover:bg-ink-900",
          ]}
        >
          <span class={["w-48 shrink-0 truncate", unread ? "font-semibold text-ink-100" : "text-ink-300"]}>
            {senderName(t.fromName, t.fromAddress)}
            {#if t.messageCount > 1}<span class="ml-1 text-xs font-normal text-ink-500">{t.messageCount}</span>{/if}
          </span>
          <span class="min-w-0 flex-1 truncate">
            <span class={unread ? "font-semibold text-ink-100" : "text-ink-300"}>{t.subject || "(no subject)"}</span>
            <span class="ml-2 text-ink-500">{t.preview}</span>
          </span>
          {#if t.hasAttachments}<span class="text-xs text-ink-500" title="Has attachments">📎</span>{/if}
          {#if t.isFlagged}<span class="text-xs text-amber-400" title="Flagged">●</span>{/if}
          <span class={["w-16 shrink-0 text-right text-xs tabular-nums", unread ? "text-ink-100" : "text-ink-500"]}>
            {listDate(t.receivedAt)}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>
