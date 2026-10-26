<script lang="ts">
  // RSVP card shown above a conversation containing a meeting invite. y / m / n answer it.
  import { CalendarClock, Check, HelpCircle, MapPin, X } from "@lucide/svelte";
  import { calendar, eventTimes, startOfWeek } from "$lib/calendar.svelte";
  import { mail } from "$lib/mail.svelte";
  import type { Invite, Rsvp } from "$lib/api";

  let { invite }: { invite: Invite } = $props();

  const e = $derived(invite.event);
  const cancelled = $derived(invite.meetingMessageType === "meetingCancelled" || e.isCancelled);
  const answerable = $derived(!cancelled && !e.isOrganizer && invite.meetingMessageType !== "meetingAccepted");

  const when = $derived.by(() => {
    const { start, end } = eventTimes(e);
    const date = start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    if (e.isAllDay) return `${date} · all day`;
    const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${date} · ${t(start)} – ${t(end)}`;
  });

  const STATUS: Record<string, string> = {
    accepted: "You're going",
    tentativelyAccepted: "You said maybe",
    declined: "You declined",
    organizer: "You're the organiser",
  };

  const buttons: { r: Rsvp; status: string; label: string; key: string; Icon: typeof Check }[] = [
    { r: "accept", status: "accepted", label: "Accept", key: "Y", Icon: Check },
    { r: "tentative", status: "tentativelyAccepted", label: "Maybe", key: "M", Icon: HelpCircle },
    { r: "decline", status: "declined", label: "Decline", key: "N", Icon: X },
  ];

  function showInCalendar() {
    calendar.weekStart = startOfWeek(eventTimes(e).start);
    calendar.loadWeek();
    mail.view = "calendar";
    calendar.selected = e;
    mail.overlay = "event";
  }
</script>

<section data-testid="invite-card" data-response={e.response ?? "none"} class="mb-4 rounded-lg border border-accent/40 bg-accent/10 p-4">
  <div class="flex items-start gap-3">
    <CalendarClock size={20} class="mt-0.5 shrink-0 text-accent" />
    <div class="min-w-0 flex-1">
      <p class={["font-semibold text-ink-100", cancelled && "line-through"]}>{e.subject || "(no title)"}</p>
      <p class="mt-0.5 text-sm text-ink-300">{when}</p>
      {#if e.location}<p class="mt-0.5 flex items-center gap-1 text-sm text-ink-500"><MapPin size={13} />{e.location}</p>{/if}
      <p data-testid="invite-status" class="mt-1 text-xs text-ink-500">
        {cancelled ? "This meeting was cancelled" : (STATUS[e.response ?? ""] ?? "You haven't responded yet")}
      </p>
    </div>
    <button data-testid="invite-show" onclick={showInCalendar} class="shrink-0 text-xs text-accent hover:underline">Show in calendar</button>
  </div>
  {#if answerable}
    <div class="mt-3 flex gap-2">
      {#each buttons as b (b.r)}
        {@const active = e.response === b.status}
        <button
          data-testid="rsvp-{b.r}"
          aria-pressed={active}
          title="{b.label} ({b.key})"
          onclick={() => mail.rsvp(b.r)}
          class={[
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm",
            active ? "bg-accent font-medium text-chrome" : "border border-ink-700 text-ink-300 hover:border-ink-500 hover:text-ink-100",
          ]}
        >
          <b.Icon size={14} />{b.label}
          <kbd class="ml-1">{b.key.toLowerCase()}</kbd>
        </button>
      {/each}
    </div>
  {/if}
</section>
