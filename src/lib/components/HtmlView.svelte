<script lang="ts">
  // Sanitized HTML (an event description) in a sandboxed iframe: no scripts, no remote
  // loads (the page CSP), links open in the browser, keys keep working inside it.
  // Sized to its content.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { keymap } from "$lib/keys.svelte";

  let { html, testid = "html-view" }: { html: string; testid?: string } = $props();

  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(0);

  const STYLE = `
    html { color-scheme: light; }
    body { margin: 0; padding: 12px 14px; font: 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
           color: #1a1a1f; background: #fff; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    p { margin: 0 0 .6em; }
    a { color: #3b4fd8; }`;
  // Remote images stay out (the CSP blocks them anyway): park their URL, keep the layout.
  const srcdoc = $derived(
    `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${html.replace(/(<img\b[^>]*?)\ssrc="(https?:[^"]*)"/gi, '$1 data-remote-src="$2"')}</body></html>`,
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

<iframe
  bind:this={frame}
  title="Description"
  data-testid={testid}
  sandbox="allow-same-origin"
  {srcdoc}
  {onload}
  style:height="{height}px"
  class="block w-full rounded border-0 bg-white"
></iframe>
