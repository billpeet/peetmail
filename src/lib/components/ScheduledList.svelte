<script lang="ts">
  // Messages scheduled to send later (g s), in the main area like a mailbox. Enter reopens
  // one to edit (it stops being scheduled until you send or schedule it again); # cancels it.
  import { onMount } from "svelte";
  import { keymap } from "#lib/keys.svelte.js";
  import { formatSendAt, mail } from "#lib/mail.svelte.js";

  let active = $state(0);
  const items = $derived(mail.scheduled);
  $effect(() => {
    if (active >= items.length) active = Math.max(0, items.length - 1);
  });

  // Showing, with nothing in front of it (dialogs, the composer, a search).
  const shown = () => mail.mailbox === "scheduled" && mail.search === null && mail.view === "list" && mail.overlay === null && !mail.composer;

  async function edit(i = active) {
    const q = items[i];
    if (!q) return;
    if (!(await mail.unsend(q.id))) mail.showToast({ text: "That message has already been sent", error: true });
  }

  function cancel(i = active) {
    const q = items[i];
    if (q) mail.cancelScheduled(q.id);
  }

  const move = (d: number) => (active = Math.min(Math.max(active + d, 0), items.length - 1));

  onMount(() => {
    mail.refreshScheduled();
    return keymap.register([
      { id: "scheduled.down", keys: "j", label: "Next scheduled message", group: "Scheduled", when: shown, run: () => move(1) },
      { id: "scheduled.up", keys: "k", label: "Previous scheduled message", group: "Scheduled", when: shown, run: () => move(-1) },
      { id: "scheduled.down.arrow", keys: "ArrowDown", label: "Next scheduled message", group: "Scheduled", when: shown, run: () => move(1) },
      { id: "scheduled.up.arrow", keys: "ArrowUp", label: "Previous scheduled message", group: "Scheduled", when: shown, run: () => move(-1) },
      { id: "scheduled.edit", keys: "Enter", label: "Edit scheduled message", group: "Scheduled", when: shown, run: () => edit() },
      { id: "scheduled.cancel", keys: "#", label: "Cancel scheduled message", group: "Scheduled", when: shown, run: () => cancel() },
      { id: "scheduled.cancel.delete", keys: "Delete", label: "Cancel scheduled message", group: "Scheduled", when: shown, run: () => cancel() },
    ]);
  });
</script>

<div data-testid="scheduled" class="flex h-full flex-col">
  {#if items.length}
    <ul class="min-h-0 flex-1 overflow-y-auto">
      {#each items as q, i (q.id)}
        <li>
          <button
            data-testid="scheduled-row"
            data-id={q.id}
            data-active={i === active}
            onclick={() => edit(i)}
            onmousemove={() => (active = i)}
            class={[
              "flex h-10 w-full items-center gap-4 border-l-2 px-5 text-left text-sm",
              i === active ? "border-accent bg-ink-800" : "border-transparent hover:bg-ink-900",
            ]}
          >
            {#if mail.accounts.length > 1}<span class={["size-2 shrink-0 rounded-full", mail.accountColor(q.accountId)]}></span>{/if}
            <span data-testid="scheduled-when" class="w-44 shrink-0 text-accent">{formatSendAt(q.sendAt)}</span>
            <span class="w-56 shrink-0 truncate text-ink-300">{q.draft.to.join(", ") || "Reply"}</span>
            <span class="min-w-0 flex-1 truncate">
              <span class="text-ink-100">{q.draft.subject || "(no subject)"}</span>
              <span class="ml-2 text-ink-500">{q.draft.body.split("\n").find((l) => l.trim()) ?? ""}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <div data-testid="scheduled-empty" class="grid flex-1 place-items-center text-sm text-ink-500">
      <p>Nothing scheduled. In the composer, <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> sends later.</p>
    </div>
  {/if}
  <p class="shrink-0 border-t border-ink-800 px-5 py-2 text-xs text-ink-500">
    <kbd>Enter</kbd> edit · <kbd>#</kbd> cancel · Sends while PeetMail is running; if it's closed, it sends when you next open it.
  </p>
</div>
