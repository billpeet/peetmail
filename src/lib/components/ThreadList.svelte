<script lang="ts">
  // Fixed-height virtual list: only the visible rows (plus overscan) are in the DOM,
  // so a 50k-thread inbox costs the same to render as a 50-thread one.
  import { mail } from "$lib/mail.svelte";
  import { listDate, senderName } from "$lib/format";
  import { AlarmClock, Archive, Flag, Mail, MailOpen, Paperclip, Trash2 } from "@lucide/svelte";

  // One line per row in the list layout; three (sender + date, subject, preview) in the
  // narrower preview layout, like Outlook.
  const ROW = $derived(mail.previewing ? 76 : 40);
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
          onclick={() => mail.openAt(index)}
          style:top="{index * ROW}px"
          style:height="{ROW}px"
          class={[
            "group absolute inset-x-0 flex cursor-pointer items-center gap-4 border-l-2 px-5 text-sm",
            selected ? "border-accent bg-ink-800" : "border-transparent hover:bg-ink-900",
          ]}
        >
          {#if mail.previewing}
            <span class="flex min-w-0 flex-1 flex-col gap-0.5 py-2">
              <span class="flex items-baseline gap-2">
                <span class={["min-w-0 flex-1 truncate", unread ? "font-semibold text-ink-100" : "text-ink-300"]}>
                  {senderName(t.fromName, t.fromAddress)}
                  {#if t.messageCount > 1}<span class="ml-1 text-xs font-normal text-ink-500">{t.messageCount}</span>{/if}
                </span>
                {#if t.reminder}<span data-testid="thread-reminder" class="text-xs text-accent" title="Back from a snooze">Reminder</span>{/if}
                {#if t.hasAttachments}<span class="text-ink-500" title="Has attachments"><Paperclip size={13} /></span>{/if}
                {#if t.isFlagged}<span class="text-amber-400" title="Flagged"><Flag size={13} fill="currentColor" /></span>{/if}
                <span class={["shrink-0 text-xs tabular-nums group-hover:hidden", unread ? "text-ink-100" : "text-ink-500"]}>{listDate(t.receivedAt)}</span>
              </span>
              <span class={["truncate", unread ? "font-semibold text-ink-100" : "text-ink-300"]}>{t.subject || "(no subject)"}</span>
              <span class="truncate text-xs text-ink-500">{t.preview}</span>
            </span>
          {:else}
            <span class={["w-48 shrink-0 truncate", unread ? "font-semibold text-ink-100" : "text-ink-300"]}>
              {senderName(t.fromName, t.fromAddress)}
              {#if t.messageCount > 1}<span class="ml-1 text-xs font-normal text-ink-500">{t.messageCount}</span>{/if}
            </span>
            <span class="min-w-0 flex-1 truncate">
              <span class={unread ? "font-semibold text-ink-100" : "text-ink-300"}>{t.subject || "(no subject)"}</span>
              <span class="ml-2 text-ink-500">{t.preview}</span>
            </span>
            {#if t.reminder}<span data-testid="thread-reminder" class="shrink-0 text-xs text-accent" title="Back from a snooze">Reminder</span>{/if}
            {#if t.hasAttachments}<span class="text-ink-500" title="Has attachments"><Paperclip size={14} /></span>{/if}
            {#if t.isFlagged}<span class="text-amber-400" title="Flagged"><Flag size={14} fill="currentColor" /></span>{/if}
            <span class={["w-20 shrink-0 text-right text-xs tabular-nums group-hover:hidden", unread ? "text-ink-100" : "text-ink-500"]}>
              {listDate(t.receivedAt)}
            </span>
          {/if}
          <!-- Quick actions replace the date on hover. -->
          <span data-testid="row-actions" class={["hidden shrink-0 justify-end group-hover:flex", mail.previewing ? "absolute top-1 right-3 rounded-md bg-ink-800" : "w-28"]}>
            <button data-testid="row-snooze" title="Snooze (H)" class="icon-btn size-7" onclick={(e) => { e.stopPropagation(); mail.selected = index; mail.startSnooze(t); }}>
              <AlarmClock size={15} />
            </button>
            <button data-testid="row-archive" title="Archive (E)" class="icon-btn size-7" onclick={(e) => { e.stopPropagation(); mail.actAt(index, "archive"); }}>
              <Archive size={15} />
            </button>
            <button data-testid="row-trash" title="Delete (#)" class="icon-btn size-7" onclick={(e) => { e.stopPropagation(); mail.actAt(index, "trash"); }}>
              <Trash2 size={15} />
            </button>
            <button
              data-testid="row-read"
              title={unread ? "Mark as read (U)" : "Mark as unread (U)"}
              class="icon-btn size-7"
              onclick={(e) => { e.stopPropagation(); mail.actAt(index, unread ? "markRead" : "markUnread"); }}
            >
              {#if unread}<MailOpen size={15} />{:else}<Mail size={15} />{/if}
            </button>
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>
