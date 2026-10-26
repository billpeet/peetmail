<script lang="ts">
  // New message, reply, reply all, forward. Plain text in, HTML out (Rust converts).
  // Ctrl+Enter sends, Ctrl+Shift+Enter sends later, Esc closes (twice if there's text, so
  // nothing is lost by accident).
  import { onMount } from "svelte";
  import { api, type Contact } from "$lib/api";
  import { keymap } from "$lib/keys.svelte";
  import { mail } from "$lib/mail.svelte";
  import { X } from "@lucide/svelte";
  import { latestOnly, STALE } from "$lib/latest";
  import { narrow } from "$lib/contacts";
  import { parseSendTime } from "$lib/quickAdd";
  import { formatSendAt } from "$lib/mail.svelte";

  const c = mail.composer!;
  let to = $state(c.to);
  let cc = $state(c.cc);
  let subject = $state(c.subject);
  let body = $state(c.body);
  let showCc = $state(c.cc.length > 0);
  let armedDiscard = $state(false);

  // ----- send later -----
  /** Text of the send-later picker; null while it's closed. */
  let later = $state<string | null>(null);
  let laterInput: HTMLInputElement | undefined = $state();
  const laterParsed = $derived(later?.trim() ? parseSendTime(later) : null);

  function nextWeekday(day: number, hour: number): Date {
    const now = new Date();
    const diff = (day - now.getDay() + 7) % 7 || 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, hour);
  }
  const presets = $derived.by(() => {
    const now = new Date();
    const list: { label: string; at: Date }[] = [{ label: "In 1 hour", at: new Date(now.getTime() + 3_600_000) }];
    if (now.getHours() < 16) list.push({ label: "This evening", at: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18) });
    list.push({ label: "Tomorrow morning", at: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8) });
    list.push({ label: "Monday morning", at: nextWeekday(1, 8) });
    return list;
  });

  function openLater() {
    later = "";
    queueMicrotask(() => laterInput?.focus());
  }

  function closeLater() {
    later = null;
    bodyInput?.focus();
  }

  function laterKeys(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.ctrlKey) return;
    e.preventDefault();
    if (laterParsed?.ok) mail.send(laterParsed.at);
  }

  let toInput: HTMLInputElement | undefined = $state();
  let bodyInput: HTMLTextAreaElement | undefined = $state();

  const isReply = c.kind === "reply" || c.kind === "replyAll";
  const title = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward" }[c.kind];

  // Keep the store in sync so send() sees the latest text.
  $effect(() => {
    if (mail.composer) Object.assign(mail.composer, { to, cc, subject, body });
  });

  // ----- contact suggestions for the field being typed in -----
  let suggestions = $state<Contact[]>([]);
  let active = $state(0);
  let field = $state<"to" | "cc" | null>(null);

  // One lookup per keystroke; only the latest may update the list, or a slow reply for
  // "p" could replace the one for "priya" and Enter would pick the wrong person.
  const lookup = latestOnly(async (prefix: string) => (prefix ? api.suggestContacts(prefix) : []));

  async function suggest(which: "to" | "cc", value: string) {
    field = which;
    const text = value.split(/[,;]/).pop()?.trim() ?? "";
    // Instantly keep only what still matches; the fresh lookup replaces it when it lands.
    suggestions = text ? narrow(suggestions, text) : [];
    active = 0;
    const found = await lookup(text);
    if (found === STALE) return;
    suggestions = found;
    active = 0;
  }

  function accept(which: "to" | "cc", contact: Contact) {
    const parts = (which === "to" ? to : cc).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    parts.pop();
    const next = [...parts, contact.address].join(", ") + ", ";
    if (which === "to") to = next;
    else cc = next;
    lookup.cancel(); // a lookup still in flight mustn't reopen the list
    suggestions = [];
  }

  function fieldKeys(which: "to" | "cc", e: KeyboardEvent) {
    if (!suggestions.length || field !== which) return;
    if (e.key === "ArrowDown") active = (active + 1) % suggestions.length;
    else if (e.key === "ArrowUp") active = (active - 1 + suggestions.length) % suggestions.length;
    else if (e.key === "Enter" || e.key === "Tab") accept(which, suggestions[active]);
    else return;
    e.preventDefault();
  }

  function close() {
    if (body.trim() && !armedDiscard) {
      armedDiscard = true;
      return;
    }
    mail.composer = null;
  }

  onMount(() => {
    (isReply ? bodyInput : toInput)?.focus();
    return keymap.register([
      { id: "compose.send", keys: "ctrl+Enter", label: "Send", group: "Compose", when: () => !!mail.composer, run: () => mail.send() },
      { id: "compose.later", keys: "ctrl+shift+Enter", label: "Send later", group: "Compose", when: () => !!mail.composer, run: () => (later === null ? openLater() : closeLater()) },
      { id: "compose.later.close", keys: "Escape", label: "Close send later", group: "Compose", when: () => !!mail.composer && later !== null, run: closeLater },
      { id: "compose.close", keys: "Escape", label: "Close composer", group: "Compose", when: () => !!mail.composer && !suggestions.length && later === null, run: close },
      { id: "compose.cc", keys: "ctrl+shift+c", label: "Show Cc", group: "Compose", when: () => !!mail.composer, run: () => (showCc = true) },
    ]);
  });
</script>

{#snippet suggestionList(which: "to" | "cc")}
  {#if field === which && suggestions.length}
    <ul data-testid="contact-suggestions" class="absolute top-full left-0 z-10 mt-1 w-80 overflow-hidden rounded-md border border-ink-700 bg-ink-900 shadow-xl">
      {#each suggestions as s, i (s.address)}
        <li>
          <button
            type="button"
            onmousedown={(e) => { e.preventDefault(); accept(which, s); }}
            class={["block w-full px-3 py-1.5 text-left text-sm", i === active ? "bg-ink-800 text-ink-100" : "text-ink-300"]}
          >
            {s.name ?? s.address} <span class="text-ink-500">{s.name ? s.address : ""}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<div data-testid="composer" class="fixed inset-x-0 top-9 bottom-0 z-20 flex items-end justify-center bg-black/40 p-6">
  <div class="flex h-[70vh] w-full max-w-3xl flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
    <div class="flex items-center justify-between border-b border-ink-800 px-4 py-2.5 text-sm">
      <span class="font-semibold text-ink-100">{title}</span>
      <span class="flex items-center gap-2 text-xs text-ink-500">
        <kbd>Ctrl</kbd> <kbd>Enter</kbd> send · <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> later · <kbd>Esc</kbd> close
        <button data-testid="compose-close" title="Close (Esc)" aria-label="Close" onclick={close} class="icon-btn size-7"><X size={15} /></button>
      </span>
    </div>

    <div class="space-y-0 border-b border-ink-800 text-sm">
      <label class="relative flex items-center gap-3 px-4 py-2">
        <span class="w-14 shrink-0 text-ink-500">To</span>
        <input
          data-testid="compose-to"
          bind:this={toInput}
          bind:value={to}
          oninput={() => suggest("to", to)}
          onkeydown={(e) => fieldKeys("to", e)}
          onblur={() => (suggestions = [])}
          spellcheck="false"
          autocomplete="off"
          class="min-w-0 flex-1 bg-transparent text-ink-100 outline-none select-text"
        />
        {#if !showCc}
          <button type="button" onclick={() => (showCc = true)} class="text-xs text-ink-500 hover:text-ink-100">Cc</button>
        {/if}
        {@render suggestionList("to")}
      </label>
      {#if showCc}
        <label class="relative flex items-center gap-3 border-t border-ink-800 px-4 py-2">
          <span class="w-14 shrink-0 text-ink-500">Cc</span>
          <input
            data-testid="compose-cc"
            bind:value={cc}
            oninput={() => suggest("cc", cc)}
            onkeydown={(e) => fieldKeys("cc", e)}
            onblur={() => (suggestions = [])}
            spellcheck="false"
            autocomplete="off"
            class="min-w-0 flex-1 bg-transparent text-ink-100 outline-none select-text"
          />
          {@render suggestionList("cc")}
        </label>
      {/if}
      <label class="flex items-center gap-3 border-t border-ink-800 px-4 py-2">
        <span class="w-14 shrink-0 text-ink-500">Subject</span>
        <input
          data-testid="compose-subject"
          bind:value={subject}
          disabled={isReply}
          class="min-w-0 flex-1 bg-transparent text-ink-100 outline-none select-text disabled:text-ink-500"
        />
      </label>
    </div>

    <textarea
      data-testid="compose-body"
      bind:this={bodyInput}
      bind:value={body}
      oninput={() => (armedDiscard = false)}
      placeholder={isReply ? "Write your reply…" : ""}
      class="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-ink-100 outline-none select-text"
    ></textarea>

    {#if later !== null}
      <div data-testid="compose-later" class="space-y-2 border-t border-ink-800 px-4 py-3 text-sm">
        <div class="flex items-center gap-3">
          <span class="shrink-0 text-ink-500">Send</span>
          <input
            data-testid="compose-later-input"
            bind:this={laterInput}
            bind:value={later}
            onkeydown={laterKeys}
            placeholder="tomorrow 9am, mon, in 2 hours…"
            spellcheck="false"
            autocomplete="off"
            class="min-w-0 flex-1 bg-transparent text-ink-100 outline-none select-text"
          />
          {#if laterParsed?.ok}
            <span data-testid="compose-later-when" class="shrink-0 text-accent">{formatSendAt(laterParsed.at.toISOString())}</span>
          {:else if laterParsed}
            <span data-testid="compose-later-hint" class="shrink-0 text-ink-500">{laterParsed.reason}</span>
          {/if}
        </div>
        <div class="flex flex-wrap gap-2">
          {#each presets as p (p.label)}
            <button
              data-testid="compose-later-preset"
              type="button"
              onclick={() => mail.send(p.at)}
              class="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:border-accent hover:text-ink-100"
            >
              {p.label} <span class="text-ink-500">{formatSendAt(p.at.toISOString())}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="flex items-center justify-between border-t border-ink-800 px-4 py-2.5">
      <span data-testid="compose-hint" class="text-xs {armedDiscard ? 'text-amber-300' : 'text-ink-500'}">
        {armedDiscard ? "Press Esc again to discard" : isReply ? "The original message is quoted below your reply." : ""}
      </span>
      <span class="flex items-center gap-2">
        <button
          data-testid="compose-later-toggle"
          title="Send later (Ctrl+Shift+Enter)"
          onclick={() => (later === null ? openLater() : closeLater())}
          class="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100"
        >
          Send later
        </button>
        <button data-testid="compose-send" onclick={() => mail.send()} class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-ink-950">
          Send
        </button>
      </span>
    </div>
  </div>
</div>
