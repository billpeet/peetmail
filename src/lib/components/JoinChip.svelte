<script lang="ts">
  // Join control on a calendar event block: a video icon, or a "Join" pill while the
  // meeting is on (or starts within 10 minutes). Opens the meeting without opening the
  // event. A span with a button role: the block it sits in is a button itself.
  import { Video } from "@lucide/svelte";
  import { api, type CalendarEvent } from "$lib/api";
  import { eventTimes } from "$lib/calendar.svelte";

  let { e, now, testid = "event-join-chip", compact = false }: { e: CalendarEvent; now: Date; testid?: string; compact?: boolean } = $props();

  const live = $derived.by(() => {
    const { start, end } = eventTimes(e);
    return now.getTime() >= start.getTime() - 10 * 60_000 && now.getTime() < end.getTime();
  });

  function join(ev: Event) {
    ev.stopPropagation();
    ev.preventDefault();
    if (e.joinUrl) api.openExternal(e.joinUrl);
  }
</script>

{#if e.joinUrl}
  <span
    role="button"
    tabindex="-1"
    data-testid={testid}
    data-live={live}
    title="Join {e.joinProvider ?? 'online meeting'}"
    onclick={join}
    onkeydown={(ev) => ev.key === "Enter" && join(ev)}
    class={[
      "absolute top-0.5 right-0.5 z-10 flex cursor-pointer items-center gap-1 rounded",
      live && !compact ? "bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-chrome" : "bg-ink-950/60 p-0.5 text-ink-100 hover:bg-accent hover:text-chrome",
    ]}
  >
    <Video size={compact ? 10 : 12} />{#if live && !compact}Join{/if}
  </span>
{/if}
