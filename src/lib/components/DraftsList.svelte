<script lang="ts">
  // Drafts (g d): messages you started and closed (or that were open when PeetMail closed),
  // and your drafts from Outlook and Gmail, most recently edited first. Enter reopens one in
  // the composer; # discards it.
  import { onMount } from "svelte";
  import { keymap } from "#lib/keys.svelte.js";
  import { mail } from "#lib/mail.svelte.js";
  import { listDate } from "#lib/format.js";
  import type { SavedDraft } from "#lib/api.js";
  import { Paperclip } from "@lucide/svelte";

  let active = $state(0);
  const items = $derived(mail.drafts);
  $effect(() => {
    if (active >= items.length) active = Math.max(0, items.length - 1);
  });

  // Showing, with nothing in front of it (dialogs, the composer, a search).
  const shown = () => mail.mailbox === "drafts" && mail.search === null && mail.view === "list" && mail.overlay === null && !mail.composer;

  const open = (i = active) => items[i] && mail.openDraft(items[i]);
  const discard = (i = active) => items[i] && mail.deleteDraft(items[i].id);
  const move = (d: number) => (active = Math.min(Math.max(active + d, 0), items.length - 1));

  const KIND = { new: "", reply: "Reply", replyAll: "Reply all", forward: "Forward" } as const;
  const who = (d: SavedDraft) => d.draft.to.replace(/[,;\s]+$/, "") || d.draft.bcc.replace(/[,;\s]+$/, "") || "(no recipients)";

  onMount(() => {
    mail.refreshDrafts();
    return keymap.register([
      { id: "drafts.down", keys: "j", label: "Next draft", group: "Drafts", when: shown, run: () => move(1) },
      { id: "drafts.up", keys: "k", label: "Previous draft", group: "Drafts", when: shown, run: () => move(-1) },
      { id: "drafts.down.arrow", keys: "ArrowDown", label: "Next draft", group: "Drafts", when: shown, run: () => move(1) },
      { id: "drafts.up.arrow", keys: "ArrowUp", label: "Previous draft", group: "Drafts", when: shown, run: () => move(-1) },
      { id: "drafts.open", keys: "Enter", label: "Open draft", group: "Drafts", when: shown, run: () => open() },
      { id: "drafts.discard", keys: "#", label: "Discard draft", group: "Drafts", when: shown, run: () => discard() },
      { id: "drafts.discard.delete", keys: "Delete", label: "Discard draft", group: "Drafts", when: shown, run: () => discard() },
    ]);
  });
</script>

<div data-testid="drafts" class="flex h-full flex-col">
  {#if items.length}
    <ul class="min-h-0 flex-1 overflow-y-auto">
      {#each items as d, i (d.id)}
        <li>
          <button
            data-testid="draft-row"
            data-id={d.id}
            data-active={i === active}
            onclick={() => open(i)}
            onmousemove={() => (active = i)}
            class={[
              "flex h-10 w-full items-center gap-4 border-l-2 px-5 text-left text-sm",
              i === active ? "border-accent bg-ink-800" : "border-transparent hover:bg-ink-900",
            ]}
          >
            {#if mail.accounts.length > 1}<span class={["size-2 shrink-0 rounded-full", mail.accountColor(d.accountId)]}></span>{/if}
            <span class="w-56 shrink-0 truncate text-ink-300">
              {#if KIND[d.draft.kind]}<span class="mr-1.5 text-amber-300">{KIND[d.draft.kind]}</span>{/if}{who(d)}
            </span>
            <span class="min-w-0 flex-1 truncate">
              <span class="text-ink-100">{d.draft.subject || "(no subject)"}</span>
              <span class="ml-2 text-ink-500">{d.draft.body.split("\n").find((l) => l.trim()) ?? ""}</span>
            </span>
            {#if d.draft.attachments.length}<Paperclip size={13} class="shrink-0 text-ink-500" aria-label="Has attachments" />{/if}
            <span data-testid="draft-when" class="w-24 shrink-0 text-right text-xs text-ink-500">{listDate(d.updatedAt)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <div data-testid="drafts-empty" class="grid flex-1 place-items-center text-sm text-ink-500">
      <p>No drafts. A message you close without sending waits here.</p>
    </div>
  {/if}
  <p class="shrink-0 border-t border-ink-800 px-5 py-2 text-xs text-ink-500">
    <kbd>Enter</kbd> open · <kbd>#</kbd> discard · Drafts are the same as in Outlook and Gmail; the last change wins.
  </p>
</div>
