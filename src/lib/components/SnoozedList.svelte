<script lang="ts">
  // Snoozed conversations (g h), soonest back first. Enter opens one, h changes its time,
  // u brings it back to the inbox now.
  import { onMount } from "svelte";
  import { AlarmClock } from "@lucide/svelte";
  import { keymap } from "$lib/keys.svelte";
  import { formatSendAt, mail } from "$lib/mail.svelte";
  import { senderName } from "$lib/format";

  let active = $state(0);
  const items = $derived(mail.snoozed);
  $effect(() => {
    if (active >= items.length) active = Math.max(0, items.length - 1);
  });

  const open = () => mail.overlay === "snoozed";
  const move = (d: number) => (active = Math.min(Math.max(active + d, 0), items.length - 1));

  onMount(() => {
    mail.refreshSnoozed();
    return keymap.register([
      { id: "snoozed.down", keys: "j", label: "Next snoozed conversation", group: "Snoozed", when: open, run: () => move(1) },
      { id: "snoozed.up", keys: "k", label: "Previous snoozed conversation", group: "Snoozed", when: open, run: () => move(-1) },
      { id: "snoozed.down.arrow", keys: "ArrowDown", label: "Next snoozed conversation", group: "Snoozed", when: open, run: () => move(1) },
      { id: "snoozed.up.arrow", keys: "ArrowUp", label: "Previous snoozed conversation", group: "Snoozed", when: open, run: () => move(-1) },
      { id: "snoozed.open", keys: "Enter", label: "Open snoozed conversation", group: "Snoozed", when: open, run: () => items[active] && mail.openSnoozed(items[active]) },
      { id: "snoozed.retime", keys: "h", label: "Change snooze time", group: "Snoozed", when: open, run: () => items[active] && mail.startSnooze(items[active]) },
      { id: "snoozed.wake", keys: "u", label: "Back to inbox now", group: "Snoozed", when: open, run: () => items[active] && mail.unsnooze(items[active]) },
    ]);
  });
</script>

<div
  data-testid="snoozed"
  onclick={(e) => e.target === e.currentTarget && (mail.overlay = null)}
  role="presentation"
  class="fixed inset-x-0 top-9 bottom-0 z-30 flex justify-center bg-black/50 pt-[12vh]"
>
  <div class="flex h-fit max-h-[70vh] w-[640px] flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
    <div class="flex items-center gap-2 border-b border-ink-800 px-4 py-3 text-sm font-semibold text-ink-100">
      <AlarmClock size={16} class="text-accent" /> Snoozed
    </div>
    {#if items.length}
      <ul class="min-h-0 overflow-y-auto py-1">
        {#each items as s, i (s.accountId + s.conversationId)}
          <li>
            <button
              data-testid="snoozed-row"
              data-conversation-id={s.conversationId}
              onclick={() => mail.openSnoozed(s)}
              onmousemove={() => (active = i)}
              class={["flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm", i === active ? "bg-ink-800" : ""]}
            >
              <span data-testid="snoozed-until" class="w-40 shrink-0 text-accent">{formatSendAt(s.until)}</span>
              <span class="w-36 shrink-0 truncate text-ink-300">{senderName(s.fromName, s.fromAddress)}</span>
              <span class="min-w-0 flex-1 truncate text-ink-100">{s.subject || "(no subject)"}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p data-testid="snoozed-empty" class="px-4 py-6 text-sm text-ink-500">Nothing snoozed. Press <kbd>h</kbd> on a conversation to snooze it.</p>
    {/if}
    <div class="border-t border-ink-800 px-4 py-2 text-xs text-ink-500">
      <kbd>Enter</kbd> open · <kbd>h</kbd> change time · <kbd>u</kbd> back to inbox now · <kbd>Esc</kbd> close
    </div>
  </div>
</div>
