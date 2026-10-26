<script lang="ts">
  // Messages scheduled to send later (g s). Enter reopens one to edit (it stops being
  // scheduled until you send or schedule it again); # cancels it.
  import { onMount } from "svelte";
  import { Clock } from "@lucide/svelte";
  import { keymap } from "$lib/keys.svelte";
  import { formatSendAt, mail } from "$lib/mail.svelte";

  let active = $state(0);
  const items = $derived(mail.scheduled);
  $effect(() => {
    if (active >= items.length) active = Math.max(0, items.length - 1);
  });

  const open = () => mail.overlay === "scheduled";

  async function edit(i = active) {
    const q = items[i];
    if (!q) return;
    mail.overlay = null;
    if (!(await mail.unsend(q.id))) mail.showToast({ text: "That message has already been sent", error: true });
  }

  function cancel(i = active) {
    const q = items[i];
    if (q) mail.cancelScheduled(q.id);
  }

  onMount(() => {
    mail.refreshScheduled();
    return keymap.register([
      { id: "scheduled.down", keys: "j", label: "Next scheduled message", group: "Scheduled", when: open, run: () => (active = Math.min(active + 1, items.length - 1)) },
      { id: "scheduled.up", keys: "k", label: "Previous scheduled message", group: "Scheduled", when: open, run: () => (active = Math.max(active - 1, 0)) },
      { id: "scheduled.down.arrow", keys: "ArrowDown", label: "Next scheduled message", group: "Scheduled", when: open, run: () => (active = Math.min(active + 1, items.length - 1)) },
      { id: "scheduled.up.arrow", keys: "ArrowUp", label: "Previous scheduled message", group: "Scheduled", when: open, run: () => (active = Math.max(active - 1, 0)) },
      { id: "scheduled.edit", keys: "Enter", label: "Edit scheduled message", group: "Scheduled", when: open, run: () => edit() },
      { id: "scheduled.cancel", keys: "#", label: "Cancel scheduled message", group: "Scheduled", when: open, run: () => cancel() },
      { id: "scheduled.cancel.delete", keys: "Delete", label: "Cancel scheduled message", group: "Scheduled", when: open, run: () => cancel() },
    ]);
  });
</script>

<div
  data-testid="scheduled"
  onclick={(e) => e.target === e.currentTarget && (mail.overlay = null)}
  role="presentation"
  class="fixed inset-x-0 top-9 bottom-0 z-30 flex justify-center bg-black/50 pt-[12vh]"
>
  <div class="flex h-fit max-h-[70vh] w-[600px] flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
    <div class="flex items-center gap-2 border-b border-ink-800 px-4 py-3 text-sm font-semibold text-ink-100">
      <Clock size={16} class="text-accent" /> Scheduled
    </div>
    {#if items.length}
      <ul class="min-h-0 overflow-y-auto py-1">
        {#each items as q, i (q.id)}
          <li>
            <button
              data-testid="scheduled-row"
              data-id={q.id}
              onclick={() => edit(i)}
              onmousemove={() => (active = i)}
              class={["flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm", i === active ? "bg-ink-800" : ""]}
            >
              <span data-testid="scheduled-when" class="w-40 shrink-0 text-accent">{formatSendAt(q.sendAt)}</span>
              <span class="min-w-0 flex-1 truncate">
                <span class="text-ink-100">{q.draft.subject || "(no subject)"}</span>
                <span class="text-ink-500"> · {q.draft.to.join(", ") || "reply"}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p data-testid="scheduled-empty" class="px-4 py-6 text-sm text-ink-500">Nothing scheduled. In the composer, <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> sends later.</p>
    {/if}
    <div class="border-t border-ink-800 px-4 py-2 text-xs text-ink-500">
      <kbd>Enter</kbd> edit · <kbd>#</kbd> cancel · <kbd>Esc</kbd> close · Sends while PeetMail is running; if it's closed, it sends when you next open it.
    </div>
  </div>
</div>
