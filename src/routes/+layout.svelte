<script lang="ts">
  import "../app.css";
  import { keymap } from "#lib/keys.svelte.js";
  import TitleBar from "#lib/components/TitleBar.svelte";
  import { api } from "#lib/api.js";
  import { installErrorReporting } from "#lib/errors.js";
  import { observePage, UiTimings } from "#lib/perf.js";

  // As early as possible, so errors while the app starts are reported too.
  installErrorReporting((r) => api.reportError(r.name, r.message, r.stack, r.mechanism));

  // Usage timings (Rust drops them when usage data is off or not configured).
  const timings = new UiTimings((events) => api.uiEvents(events));
  observePage(timings);
  keymap.onAction = (id, ms) => timings.add({ kind: "action", binding: id, view: document.body.dataset.view, ms });

  let { children } = $props();
</script>

<svelte:window onkeydown={keymap.handle} />

<div class="flex h-full flex-col">
  <TitleBar />
  <div class="min-h-0 flex-1">{@render children()}</div>
</div>
