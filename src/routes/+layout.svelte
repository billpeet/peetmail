<script lang="ts">
  import "../app.css";
  import { keymap } from "$lib/keys.svelte";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import { api } from "$lib/api";
  import { installErrorReporting } from "$lib/errors";

  // As early as possible, so errors while the app starts are reported too.
  installErrorReporting((r) => api.reportError(r.name, r.message, r.stack, r.mechanism));

  let { children } = $props();
</script>

<svelte:window onkeydown={keymap.handle} />

<div class="flex h-full flex-col">
  <TitleBar />
  <div class="min-h-0 flex-1">{@render children()}</div>
</div>
