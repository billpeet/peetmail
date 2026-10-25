<script lang="ts">
  import "../app.css";
  import { keymap } from "$lib/keys.svelte";
  import TitleBar from "$lib/components/TitleBar.svelte";

  let { children } = $props();
</script>

<svelte:window onkeydown={keymap.handle} />

<div class="flex h-full flex-col">
  <TitleBar />
  <div class="min-h-0 flex-1">{@render children()}</div>
</div>
