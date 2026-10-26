<script lang="ts">
  import { mail } from "$lib/mail.svelte";
  import { longDate, senderName } from "$lib/format";
  import type { Recipient } from "$lib/api";
  import MessageBody from "./MessageBody.svelte";
  import Attachments from "./Attachments.svelte";
  import { Archive, ArrowLeft, ChevronDown, ChevronUp, Flag, Forward, Mail, Reply, ReplyAll, Trash2 } from "@lucide/svelte";

  const flagged = $derived(mail.current?.isFlagged ?? false);

  const images = $derived(mail.imagesFor !== null && mail.imagesFor === mail.threadFor);

  // Newest and unread messages start expanded; the rest collapse to one line.
  // Initialise once per conversation, after its messages have loaded, so background
  // refreshes don't undo what the user expanded.
  let expanded = $state(new Set<number>());
  let initializedFor: string | null = null;

  $effect(() => {
    const msgs = mail.thread;
    const conv = mail.threadFor;
    if (!msgs.length || conv === initializedFor) return;
    initializedFor = conv;
    const open = new Set(msgs.filter((m) => !m.isRead).map((m) => m.id));
    const last = msgs.at(-1);
    if (last) open.add(last.id);
    expanded = open;
  });

  function toggle(id: number) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  const names = (list: Recipient[]) => list.map((r) => senderName(r.name, r.address)).join(", ");
</script>

{#snippet action(testid: string, label: string, run: () => void, Icon: typeof Archive, extra = "")}
  <button data-testid={testid} title={label} aria-label={label} onclick={run} class="icon-btn {extra}">
    <Icon size={17} />
  </button>
{/snippet}

<div class="flex h-full flex-col">
  <!-- Every keyboard action, also reachable by mouse. Tooltips show the shortcut. -->
  <div data-testid="reader-toolbar" class="flex h-11 shrink-0 items-center gap-1 border-b border-ink-800 px-3">
    {@render action("reader-back", "Back to list (Esc)", () => mail.back(), ArrowLeft)}
    <span class="mx-1 h-5 w-px bg-ink-700"></span>
    {@render action("reader-archive", "Archive (E)", () => mail.act("archive"), Archive)}
    {@render action("reader-trash", "Delete (#)", () => mail.act("trash"), Trash2)}
    {@render action("reader-unread", "Mark as unread (U)", () => mail.act("markUnread"), Mail)}
    {@render action("reader-flag", flagged ? "Unflag (S)" : "Flag (S)", () => mail.toggleFlag(), Flag, flagged ? "text-amber-400" : "")}
    <span class="mx-1 h-5 w-px bg-ink-700"></span>
    {@render action("reader-reply", "Reply (R)", () => mail.respond("reply"), Reply)}
    {@render action("reader-reply-all", "Reply all (A)", () => mail.respond("replyAll"), ReplyAll)}
    {@render action("reader-forward", "Forward (F)", () => mail.respond("forward"), Forward)}
    <span class="ml-auto text-xs text-ink-500 tabular-nums">{mail.pinned ? "From Recent Opens" : `${mail.selected + 1} of ${mail.threads.length}`}</span>
    {@render action("reader-prev", "Previous conversation (K)", () => mail.move(-1), ChevronUp)}
    {@render action("reader-next", "Next conversation (J)", () => mail.move(1), ChevronDown)}
  </div>

<div data-testid="reader" class="min-h-0 flex-1 overflow-y-auto">
  <div class="mx-auto max-w-4xl px-8 py-6">
    <h1 class="mb-5 text-xl font-semibold text-ink-100 select-text">{mail.current?.subject || "(no subject)"}</h1>

    <div class="space-y-2">
      {#each mail.thread as m (m.id)}
        {@const open = expanded.has(m.id)}
        <article data-testid="message" data-message-id={m.id} data-expanded={open} class="overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
          <button data-testid="message-header" class="flex w-full items-baseline gap-3 px-4 py-2.5 text-left text-sm" onclick={() => toggle(m.id)}>
            <span class="shrink-0 font-medium text-ink-100">{senderName(m.fromName, m.fromAddress)}</span>
            {#if m.folderRole === "sentitems"}<span class="shrink-0 rounded bg-ink-800 px-1.5 text-[11px] text-ink-500">Sent</span>{/if}
            {#if m.isFlagged}<span class="shrink-0 text-xs text-amber-400" title="Flagged">●</span>{/if}
            {#if open}
              <span class="min-w-0 flex-1 truncate text-xs text-ink-500">
                to {names(m.to)}{m.cc.length ? `, cc ${names(m.cc)}` : ""}
              </span>
            {:else}
              <span class="min-w-0 flex-1 truncate text-ink-500">{m.preview}</span>
            {/if}
            <span class="shrink-0 text-xs text-ink-500">{longDate(m.receivedAt)}</span>
          </button>
          {#if open}
            <div class="px-2 pb-2"><MessageBody messageId={m.id} {images} /></div>
            {#if m.hasAttachments}<Attachments messageId={m.id} />{/if}
          {/if}
        </article>
      {/each}
    </div>
  </div>
</div>
</div>
