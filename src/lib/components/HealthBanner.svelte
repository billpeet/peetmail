<script lang="ts">
  // Problems outside PeetMail that make it misbehave (low disk, wrong clock...), found by
  // the startup health checks, each with what to do about it.
  import { CircleAlert, TriangleAlert, X } from "@lucide/svelte";
  import { health } from "$lib/health.svelte";
  import { mail } from "$lib/mail.svelte";
</script>

{#if health.visible.length}
  <div data-testid="health-banners" class="fixed top-12 left-1/2 z-30 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 space-y-2">
    {#each health.visible as issue (issue.id)}
      <div
        data-testid="health-banner"
        data-id={issue.id}
        data-severity={issue.severity}
        role={issue.severity === "error" ? "alert" : "status"}
        class={[
          "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-xl",
          issue.severity === "error" ? "border-red-900/70 bg-red-950 text-red-100" : "border-amber-900/70 bg-amber-950 text-amber-100",
        ]}
      >
        {#if issue.severity === "error"}<CircleAlert size={18} class="mt-0.5 shrink-0 text-red-300" />{:else}<TriangleAlert size={18} class="mt-0.5 shrink-0 text-amber-300" />{/if}
        <div class="min-w-0 flex-1">
          <div class="font-medium">{issue.title}</div>
          <div class="mt-0.5 text-xs leading-relaxed opacity-80 select-text">{issue.detail}</div>
        </div>
        <button data-testid="health-help" onclick={() => mail.openHelp("troubleshooting")} class="shrink-0 rounded-md px-2 py-0.5 text-xs opacity-80 hover:opacity-100">Help</button>
        <button data-testid="health-dismiss" title="Dismiss" aria-label="Dismiss" onclick={() => health.dismiss(issue.id)} class="shrink-0 opacity-70 hover:opacity-100"><X size={15} /></button>
      </div>
    {/each}
  </div>
{/if}
