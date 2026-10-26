<script lang="ts">
  // Quick add (Shift+C): type an event in plain words, see how it's understood, Enter creates it.
  import { onMount } from "svelte";
  import { CalendarPlus } from "@lucide/svelte";
  import { api } from "$lib/api";
  import { calendar, localDate } from "$lib/calendar.svelte";
  import { mail } from "$lib/mail.svelte";
  import { parseQuickEvent } from "$lib/quickAdd";

  let text = $state("");
  let busy = $state(false);
  let input: HTMLInputElement | undefined = $state();

  const parsed = $derived(text.trim() ? parseQuickEvent(text) : null);

  const preview = $derived.by(() => {
    if (!parsed?.ok) return null;
    const e = parsed.event;
    const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    let when: string;
    if (e.allDay) {
      const last = new Date(e.end.getFullYear(), e.end.getMonth(), e.end.getDate() - 1);
      when = last.getTime() === e.start.getTime() ? `${day(e.start)} · all day` : `${day(e.start)} – ${day(last)} · all day`;
    } else {
      when = `${day(e.start)} · ${t(e.start)} – ${t(e.end)}`;
    }
    return { title: e.title, when, location: e.location };
  });

  async function create() {
    if (!parsed?.ok || !mail.account || busy) return;
    const e = parsed.event;
    busy = true;
    try {
      await api.createEvent(mail.account.id, {
        subject: e.title,
        start: e.allDay ? localDate(e.start) : e.start.toISOString().replace(/\.\d{3}Z$/, "Z"),
        end: e.allDay ? localDate(e.end) : e.end.toISOString().replace(/\.\d{3}Z$/, "Z"),
        allDay: e.allDay,
        location: e.location,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      mail.overlay = null;
      mail.showToast({ text: `Created “${e.title}”` });
      // Show where it landed.
      await calendar.goToDay(e.start);
      if (mail.view === "calendar") await calendar.showWeekOf(e.start);
    } catch (err) {
      mail.showToast({ text: String(err), error: true });
    } finally {
      busy = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      create();
    }
  }

  onMount(() => input?.focus());
</script>

<div
  data-testid="quick-add"
  onclick={(e) => e.target === e.currentTarget && (mail.overlay = null)}
  role="presentation"
  class="fixed inset-x-0 top-9 bottom-0 z-30 flex justify-center bg-black/50 pt-[15vh]"
>
  <div class="h-fit w-[560px] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
    <div class="flex items-center gap-3 border-b border-ink-800 px-4">
      <CalendarPlus size={18} class="shrink-0 text-accent" />
      <input
        data-testid="quick-add-input"
        bind:this={input}
        bind:value={text}
        {onkeydown}
        placeholder="Lunch with Sam fri 1pm @ Café Beetroot"
        spellcheck="false"
        autocomplete="off"
        class="w-full bg-transparent py-3 text-sm text-ink-100 outline-none select-text"
      />
    </div>
    <div data-testid="quick-add-preview" class="min-h-14 px-4 py-3 text-sm">
      {#if preview}
        <p data-testid="quick-add-title" class="font-semibold text-ink-100">{preview.title}</p>
        <p data-testid="quick-add-when" class="mt-0.5 text-ink-300">{preview.when}{preview.location ? ` · ${preview.location}` : ""}</p>
      {:else if parsed && !parsed.ok}
        <p data-testid="quick-add-hint" class="text-ink-500">{parsed.reason}</p>
      {:else}
        <p class="text-ink-500">Try “standup tomorrow 9:30 15m”, “dentist 3 nov 2pm”, “offsite fri all day”.</p>
      {/if}
    </div>
    <div class="flex items-center justify-between border-t border-ink-800 px-4 py-2 text-xs text-ink-500">
      <span><kbd>Enter</kbd> create · <kbd>Esc</kbd> cancel</span>
      <span>Adds to your calendar; no invitations are sent.</span>
    </div>
  </div>
</div>
