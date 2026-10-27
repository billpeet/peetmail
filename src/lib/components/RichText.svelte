<script lang="ts">
  // Rich-text editing (event descriptions) on Tiptap/ProseMirror: bold, italic, underline,
  // lists, links. Keys: Ctrl+B / I / U, Ctrl+Shift+8 / 7 (lists), Ctrl+K (link). `onchange`
  // fires only for your edits, not when the content is first loaded (Tiptap normalises
  // HTML, so "changed" can't be judged by comparing strings).
  import { onDestroy, onMount } from "svelte";
  import { Editor } from "@tiptap/core";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import { Bold, Italic, Link2, List, ListOrdered, Underline } from "@lucide/svelte";

  let {
    html = "",
    placeholder = "",
    disabled = false,
    onchange,
    onsubmit,
  }: { html?: string; placeholder?: string; disabled?: boolean; onchange?: (html: string) => void; onsubmit?: () => void } = $props();

  let host: HTMLDivElement | undefined = $state();
  let editor: Editor | null = $state(null);
  /** Bumped on every transaction so the toolbar's active states re-render. */
  let tick = $state(0);
  let linkOpen = $state(false);
  let linkUrl = $state("");
  let linkInput: HTMLInputElement | undefined = $state();

  onMount(() => {
    editor = new Editor({
      element: host!,
      extensions: [
        StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: "https" } }),
        Placeholder.configure({ placeholder }),
      ],
      content: html,
      editable: !disabled,
      editorProps: {
        attributes: { "data-testid": "rich-editor", class: "rich-content min-h-24 px-3 py-2 outline-none" },
        handleKeyDown: (_view, e) => {
          // Ctrl+Enter saves the form (Tiptap would insert a line break).
          if (e.ctrlKey && e.key === "Enter") {
            e.preventDefault();
            onsubmit?.();
            return true;
          }
          if (e.ctrlKey && e.key.toLowerCase() === "k") {
            e.preventDefault();
            openLink();
            return true;
          }
          return false;
        },
      },
      onTransaction: () => tick++,
      onUpdate: ({ editor }) => onchange?.(editor.isEmpty ? "" : editor.getHTML()),
    });
  });

  onDestroy(() => editor?.destroy());

  $effect(() => {
    // false: switching read-only isn't an edit (Tiptap would fire an update).
    editor?.setEditable(!disabled, false);
  });

  /** Reads `tick` so the toolbar re-renders after every transaction. */
  const active = (name: string) => tick >= 0 && (editor?.isActive(name) ?? false);

  function openLink() {
    if (!editor) return;
    linkUrl = editor.getAttributes("link").href ?? "";
    linkOpen = true;
    queueMicrotask(() => linkInput?.focus());
  }

  function applyLink(e?: Event) {
    e?.preventDefault();
    if (!editor) return;
    const url = linkUrl.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!url) chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` }).run();
    linkOpen = false;
  }

  const buttons = [
    { id: "bold", label: "Bold (Ctrl+B)", icon: Bold, run: () => editor?.chain().focus().toggleBold().run(), on: "bold" },
    { id: "italic", label: "Italic (Ctrl+I)", icon: Italic, run: () => editor?.chain().focus().toggleItalic().run(), on: "italic" },
    { id: "underline", label: "Underline (Ctrl+U)", icon: Underline, run: () => editor?.chain().focus().toggleUnderline().run(), on: "underline" },
    { id: "bullets", label: "Bulleted list (Ctrl+Shift+8)", icon: List, run: () => editor?.chain().focus().toggleBulletList().run(), on: "bulletList" },
    { id: "numbers", label: "Numbered list (Ctrl+Shift+7)", icon: ListOrdered, run: () => editor?.chain().focus().toggleOrderedList().run(), on: "orderedList" },
    { id: "link", label: "Link (Ctrl+K)", icon: Link2, run: openLink, on: "link" },
  ];
</script>

<div data-testid="rich-text" class={["rounded-md border border-ink-700 bg-ink-950 focus-within:border-accent", disabled && "opacity-60"]}>
  {#if !disabled}
    <!-- Out of the tab order: Tab goes straight into the text (Ctrl+B/I/U/K do the same). -->
    <div class="flex items-center gap-0.5 border-b border-ink-800 px-1 py-1">
      {#each buttons as b (b.id)}
        <button
          type="button"
          data-testid="rich-{b.id}"
          title={b.label}
          aria-label={b.label}
          aria-pressed={active(b.on)}
          tabindex="-1"
          onmousedown={(e) => e.preventDefault()}
          onclick={b.run}
          class={["icon-btn size-7", active(b.on) && "bg-ink-800 text-ink-100"]}
        >
          <b.icon size={14} />
        </button>
      {/each}
      {#if linkOpen}
        <form onsubmit={applyLink} class="ml-2 flex flex-1 items-center gap-1">
          <input
            data-testid="rich-link-input"
            bind:this={linkInput}
            bind:value={linkUrl}
            onkeydown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                linkOpen = false;
                editor?.commands.focus();
              }
            }}
            placeholder="https://… (empty removes the link)"
            class="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-0.5 text-xs text-ink-100 outline-none focus:border-accent"
          />
          <button data-testid="rich-link-apply" class="rounded border border-ink-700 px-2 py-0.5 text-xs text-ink-300 hover:text-ink-100">Set</button>
        </form>
      {/if}
    </div>
  {/if}
  <div bind:this={host} class="max-h-72 overflow-y-auto text-sm text-ink-100"></div>
</div>

<style>
  :global(.rich-content p) { margin: 0 0 0.5em; }
  :global(.rich-content ul) { list-style: disc; padding-left: 1.4em; margin: 0 0 0.5em; }
  :global(.rich-content ol) { list-style: decimal; padding-left: 1.4em; margin: 0 0 0.5em; }
  :global(.rich-content a) { color: var(--color-accent); text-decoration: underline; }
  :global(.rich-content p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    color: var(--color-ink-500);
    float: left;
    height: 0;
    pointer-events: none;
  }
</style>
