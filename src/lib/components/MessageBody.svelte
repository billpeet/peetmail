<script lang="ts" module>
  import { api } from "#lib/api.js";

  /** Last measured content height per message, so reopening reserves the right space at once. */
  const measured = new Map<number, number>();

  /**
   * Bodies with remote images inlined, by message (in-flight requests included). A re-render
   * (the thread refreshing after it's marked read, a sync) reuses them instead of fetching
   * every image again. Small: these carry whole images.
   */
  const withImages = new Map<number, Promise<string>>();
  function bodyWithImages(id: number): Promise<string> {
    let p = withImages.get(id);
    if (!p) {
      p = api.getMessageBodyWithImages(id);
      p.catch(() => withImages.delete(id));
      withImages.set(id, p);
      if (withImages.size > 10) withImages.delete(withImages.keys().next().value!);
    }
    return p;
  }
</script>

<script lang="ts">
  // Renders sanitized HTML in a sandboxed iframe: no scripts (sandbox), no remote
  // loads (CSP inherited by srcdoc), no IPC access. The parent still handles link
  // clicks and forwards keystrokes so shortcuts keep working after clicking into mail.
  import { untrack } from "svelte";
  import { getBody, peekBody } from "#lib/bodies.js";
  import { keymap } from "#lib/keys.svelte.js";
  import { mail } from "#lib/mail.svelte.js";

  // `images`: fetch remote images through Rust and inline them (press i in the reader).
  let { messageId, images = false }: { messageId: number; images?: boolean } = $props();

  // The iframe stays invisible until its content has been measured, then appears at full
  // height in one step. Cached bodies are read synchronously, so they skip the placeholder.
  let html = $state<string | null>(untrack(() => peekBody(messageId) ?? null));
  let error = $state<string | null>(null);
  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(untrack(() => measured.get(messageId) ?? 0));
  let ready = $state(false);
  let shownFor: number | null = null;

  $effect(() => {
    const id = messageId;
    const withImages = images;
    error = null;
    if (shownFor !== id) {
      // A different message: drop the old content. Toggling images on the same message keeps
      // showing it until the version with images arrives, so nothing collapses.
      html = withImages ? null : (peekBody(id) ?? null);
      height = measured.get(id) ?? 0;
      ready = false;
    }
    (withImages ? bodyWithImages(id) : getBody(id)).then(
      (h) => {
        if (id !== messageId || withImages !== images || h === html) return;
        html = h;
      },
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

  // Remote images are blocked by the CSP anyway, but each blocked <img> still costs a
  // request attempt, a CSP violation and an error event: ~120ms for a 300-image newsletter.
  // Parking the URL in another attribute keeps the layout (width/height stay) for free.
  const neutralize = (h: string) => h.replace(/(<img\b[^>]*?)\ssrc="(https?:[^"]*)"/gi, '$1 data-remote-src="$2"');

  const srcdoc = $derived(
    html === null
      ? ""
      : `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_STYLE}</style></head><body>${images ? html : neutralize(html)}</body></html>`,
  );

  function onload() {
    const doc = frame?.contentDocument;
    if (!doc?.body) return;
    const id = messageId;
    const fit = () => {
      height = doc.documentElement.scrollHeight;
      measured.set(id, height);
    };
    fit();
    ready = true;
    shownFor = id;
    new ResizeObserver(fit).observe(doc.body);

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

{#if error}
  <p data-testid="message-body-error" class="px-6 py-4 text-sm text-red-300 select-text">Couldn't load this message: {error}</p>
{:else if html === null}
  <div data-testid="message-body-loading" style:height="{height || 64}px" class="animate-pulse rounded bg-white/90"></div>
{:else}
  {#if !images && /src="https?:/i.test(html)}
    <p data-testid="images-blocked" class="mb-1 px-1 text-xs text-ink-500">
      Remote images hidden.
      <button data-testid="load-images" onclick={() => (mail.imagesFor = mail.threadFor)} class="text-accent hover:underline">Load images</button>
      or press <kbd>i</kbd>.
    </p>
  {/if}
  <iframe
    bind:this={frame}
    title="Message body"
    data-testid="message-body"
    sandbox="allow-same-origin"
    {srcdoc}
    {onload}
    style:height="{height}px"
    style:visibility={ready ? "visible" : "hidden"}
    data-ready={ready}
    class="block w-full rounded border-0 bg-white"
  ></iframe>
{/if}
