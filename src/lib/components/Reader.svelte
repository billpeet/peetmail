<script lang="ts">
  import { mail } from "$lib/mail.svelte";
  import { longDate, senderName } from "$lib/format";
  import type { Recipient } from "$lib/api";
  import MessageBody from "./MessageBody.svelte";

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

<div data-testid="reader" class="h-full overflow-y-auto">
  <div class="mx-auto max-w-4xl px-8 py-6">
    <h1 class="mb-5 text-xl font-semibold text-ink-100 select-text">{mail.current?.subject || "(no subject)"}</h1>

    <div class="space-y-2">
      {#each mail.thread as m (m.id)}
        {@const open = expanded.has(m.id)}
        <article data-testid="message" data-message-id={m.id} data-expanded={open} class="overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
          <button data-testid="message-header" class="flex w-full items-baseline gap-3 px-4 py-2.5 text-left text-sm" onclick={() => toggle(m.id)}>
            <span class="shrink-0 font-medium text-ink-100">{senderName(m.fromName, m.fromAddress)}</span>
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
            <div class="px-2 pb-2"><MessageBody messageId={m.id} /></div>
          {/if}
        </article>
      {/each}
    </div>
  </div>
</div>
