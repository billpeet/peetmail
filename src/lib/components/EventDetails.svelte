<script lang="ts">
  // Event details (click an event in the day or week view). Esc or the backdrop closes it.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { Clock, ExternalLink, MapPin, Users, Video, X } from "@lucide/svelte";
  import { calendar, eventTimes } from "$lib/calendar.svelte";
  import { mail } from "$lib/mail.svelte";
  import { senderName } from "$lib/format";

  const e = $derived(calendar.selected);

  const when = $derived.by(() => {
    if (!e) return "";
    const { start, end } = eventTimes(e);
    const date = (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    if (e.isAllDay) {
      const last = new Date(end.getTime() - 86_400_000);
      return last.getTime() === start.getTime() ? `${date(start)} · all day` : `${date(start)} – ${date(last)} · all day`;
    }
    const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${date(start)} · ${t(start)} – ${t(end)}`;
  });

  const RESPONSE: Record<string, string> = {
    accepted: "Accepted",
    tentativelyAccepted: "Tentative",
    declined: "Declined",
    notResponded: "No response",
    none: "No response",
    organizer: "Organiser",
  };

  function close() {
    mail.overlay = null;
    calendar.selected = null;
  }
</script>

{#if e}
  <div
    data-testid="event-details"
    onclick={(ev) => ev.target === ev.currentTarget && close()}
    role="presentation"
    class="fixed inset-x-0 top-9 bottom-0 z-30 grid place-items-center bg-black/50"
  >
    <div class="w-[460px] rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl">
      <div class="flex items-start gap-3">
        <h2 data-testid="event-title" class="flex-1 text-lg font-semibold text-ink-100 select-text">{e.subject || "(no title)"}</h2>
        <button data-testid="event-close" title="Close (Esc)" aria-label="Close" onclick={close} class="icon-btn size-7"><X size={16} /></button>
      </div>

      <dl class="mt-3 space-y-2 text-sm text-ink-300">
        <div class="flex gap-3"><Clock size={16} class="mt-0.5 shrink-0 text-ink-500" /><span data-testid="event-when">{when}</span></div>
        {#if e.location}
          <div class="flex gap-3"><MapPin size={16} class="mt-0.5 shrink-0 text-ink-500" /><span data-testid="event-location" class="select-text">{e.location}</span></div>
        {/if}
        {#if e.attendees.length || e.organizerAddress}
          <div class="flex gap-3">
            <Users size={16} class="mt-0.5 shrink-0 text-ink-500" />
            <ul data-testid="event-attendees" class="min-w-0 flex-1 space-y-0.5">
              {#if e.organizerAddress}
                <li class="truncate">{senderName(e.organizerName, e.organizerAddress)} <span class="text-ink-500">· organiser</span></li>
              {/if}
              {#each e.attendees.filter((a) => a.address !== e.organizerAddress) as a (a.address)}
                <li class="truncate">{senderName(a.name, a.address)} <span class="text-ink-500">· {RESPONSE[a.response ?? "none"] ?? a.response}</span></li>
              {/each}
            </ul>
          </div>
        {/if}
      </dl>

      {#if e.response && e.response !== "organizer"}
        <p data-testid="event-response" class="mt-3 text-xs text-ink-500">Your response: {RESPONSE[e.response] ?? e.response}</p>
      {/if}

      <div class="mt-4 flex gap-2">
        {#if e.joinUrl}
          <button data-testid="event-join" onclick={() => openUrl(e.joinUrl!)} class="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-chrome">
            <Video size={15} /> Join
          </button>
        {/if}
        {#if e.webLink}
          <button data-testid="event-open" onclick={() => openUrl(e.webLink!)} class="flex items-center gap-2 rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100">
            <ExternalLink size={15} /> Open in Outlook
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
