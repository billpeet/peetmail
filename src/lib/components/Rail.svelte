<script lang="ts">
  // Slim left sidebar, like Superhuman's: switch between Mail (1) and Calendar (2).
  import { CalendarDays, Mail } from "@lucide/svelte";
  import { mail } from "$lib/mail.svelte";

  const items = [
    { id: "mail", label: "Mail", key: "1", Icon: Mail, go: () => mail.showMail() },
    { id: "calendar", label: "Calendar", key: "2", Icon: CalendarDays, go: () => (mail.view = "calendar") },
  ] as const;

  const active = $derived(mail.view === "calendar" ? "calendar" : "mail");
</script>

<nav data-testid="rail" aria-label="Sections" class="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-ink-800 bg-chrome py-3">
  {#each items as it (it.id)}
    {@const on = active === it.id}
    <button
      data-testid="rail-{it.id}"
      data-active={on}
      aria-current={on ? "page" : undefined}
      title="{it.label} ({it.key})"
      aria-label={it.label}
      onclick={it.go}
      class={[
        "relative grid size-9 place-items-center rounded-lg transition-colors",
        on ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:bg-ink-900 hover:text-ink-100",
      ]}
    >
      {#if on}<span class="absolute top-2 bottom-2 -left-1.5 w-0.5 rounded-full bg-accent"></span>{/if}
      <it.Icon size={18} />
    </button>
  {/each}
</nav>
