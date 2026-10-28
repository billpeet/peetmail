<script lang="ts">
  import { api } from "#lib/api.js";
  // Sanitized HTML (an event description) in a sandboxed iframe: no scripts, no remote
  // loads (the page CSP), links open in the browser, keys keep working inside it.
  // Sized to its content and never scrolls itself, so the page around it has the only
  // scrollbar: fixed-width tables and blocks (Outlook signatures, Teams footers) are fitted
  // to the frame, and anything that still can't shrink scrolls sideways inside its own box.
  import { keymap } from "#lib/keys.svelte.js";

  let { html, testid = "html-view" }: { html: string; testid?: string } = $props();

  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(0);

  const STYLE = `
    html { color-scheme: light; overflow: hidden; }
    body { margin: 0; padding: 12px 14px; font: 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
           color: #1a1a1f; background: #fff; overflow-wrap: anywhere; }
    /* Fixed widths from the sender (width="1100", style="width:1000px") give way to the frame. */
    body * { max-width: 100% !important; box-sizing: border-box; }
    table { width: auto !important; table-layout: auto !important; }
    td, th { width: auto !important; }
    img { height: auto; }
    pre { white-space: pre-wrap; }
    /* Whatever still can't shrink scrolls inside its own box, not the frame. */
    .pm-wide { overflow-x: auto; }
    p { margin: 0 0 .6em; }
    a { color: #3b4fd8; }`;
  // Remote images stay out (the CSP blocks them anyway): park their URL, keep the layout.
  const srcdoc = $derived(
    `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${html.replace(/(<img\b[^>]*?)\ssrc="(https?:[^"]*)"/gi, '$1 data-remote-src="$2"')}</body></html>`,
  );

  function onload() {
    const doc = frame?.contentDocument;
    if (!doc?.body) return;
    // Anything still wider than the frame gets its own sideways scroll.
    for (const el of Array.from(doc.body.children) as HTMLElement[]) {
      if (el.scrollWidth > doc.body.clientWidth + 1) el.classList.add("pm-wide");
    }
    const fit = () => (height = Math.ceil(doc.documentElement.scrollHeight));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(doc.body);
    ro.observe(doc.documentElement);
    // Late images change the height.
    for (const img of Array.from(doc.images)) img.addEventListener("load", fit);
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) api.openExternal(href);
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
