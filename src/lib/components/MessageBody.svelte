<script lang="ts">
  // Renders sanitized HTML in a sandboxed iframe: no scripts (sandbox), no remote
  // loads (CSP inherited by srcdoc), no IPC access. The parent still handles link
  // clicks and forwards keystrokes so shortcuts keep working after clicking into mail.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { getBody } from "$lib/bodies";
  import { keymap } from "$lib/keys.svelte";

  let { messageId }: { messageId: number } = $props();

  let html = $state<string | null>(null);
  let error = $state<string | null>(null);
  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(60);

  $effect(() => {
    const id = messageId;
    html = null;
    error = null;
    getBody(id).then(
      (h) => id === messageId && (html = h),
      (e) => id === messageId && (error = String(e)),
    );
  });

  const BASE_STYLE = `
    html { color-scheme: light; }
    body { margin: 0; padding: 20px 24px; font: 14px/1.55 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
           color: #1a1a1f; background: #fff; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    blockquote { margin: 0 0 0 0.5em; padding-left: 0.75em; border-left: 2px solid #d4d4dc; color: #555; }
    a { color: #3b4fd8; }`;

  const srcdoc = $derived(
    html === null ? "" : `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_STYLE}</style></head><body>${html}</body></html>`,
  );

  function onload() {
    const doc = frame?.contentDocument;
    if (!doc?.body) return;
    const fit = () => (height = doc.documentElement.scrollHeight);
    fit();
    new ResizeObserver(fit).observe(doc.body);

    doc.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) openUrl(href);
    });
    doc.addEventListener("keydown", keymap.handle);
  }
</script>

{#if error}
  <p class="px-6 py-4 text-sm text-red-300 select-text">Couldn't load this message: {error}</p>
{:else if html === null}
  <div class="h-16 animate-pulse rounded bg-white/90"></div>
{:else}
  <iframe
    bind:this={frame}
    title="Message body"
    sandbox="allow-same-origin"
    {srcdoc}
    {onload}
    style:height="{height}px"
    class="block w-full rounded border-0 bg-white"
  ></iframe>
{/if}
