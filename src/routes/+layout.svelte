<script lang="ts">
  import "../app.css";
  import { keymap } from "$lib/keys.svelte";

  let { children } = $props();
</script>

<svelte:window onkeydown={keymap.handle} />

{@render children()}
