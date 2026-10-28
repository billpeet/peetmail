<script lang="ts">
  // Snippets: reusable text for the composer. Type ;name there (or Ctrl+;) to insert one.
  import { api } from "#lib/api.js";
  import { mail } from "#lib/mail.svelte.js";
  import type { Snippet } from "#lib/snippets.js";

  let rows = $state<Snippet[]>(mail.snippets.map((s) => ({ ...s })));
  let saved = $state(false);
  let error = $state<string | null>(null);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    try {
      mail.snippets = await api.setSnippets(rows);
      rows = mail.snippets.map((s) => ({ ...s }));
      saved = true;
      error = null;
    } catch (err) {
      error = String(err);
    }
  }
</script>

<form data-testid="snippet-editor" onsubmit={save} class="space-y-3">
  {#each rows as row, i (i)}
    <div class="space-y-1 rounded-md border border-ink-800 p-2">
      <div class="flex items-center gap-2">
        <span class="text-sm text-ink-500">;</span>
        <input
          data-testid="snippet-name"
          bind:value={row.name}
          oninput={() => (saved = false)}
          placeholder="name"
          spellcheck="false"
          class="w-40 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100 outline-none select-text focus:border-accent"
        />
        <button type="button" onclick={() => rows.splice(i, 1)} title="Remove" class="ml-auto px-1 text-ink-500 hover:text-red-300">×</button>
      </div>
      <textarea
        data-testid="snippet-body"
        bind:value={row.body}
        oninput={() => (saved = false)}
        rows="3"
        placeholder={"Hi {first_name},\n\nThanks for…"}
        class="w-full resize-y rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none select-text focus:border-accent"
      ></textarea>
    </div>
  {/each}
  {#if error}<p data-testid="snippet-error" class="text-xs text-red-300">{error}</p>{/if}
  <div class="flex items-center justify-between">
    <button type="button" data-testid="snippet-add" onclick={() => rows.push({ name: "", body: "" })} class="text-xs text-ink-500 hover:text-ink-100">
      + Add snippet
    </button>
    <span class="flex items-center gap-3">
      {#if saved}<span class="text-xs text-ink-500">Saved</span>{/if}
      <button data-testid="snippet-save" class="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-ink-300 hover:text-ink-100">Save snippets</button>
    </span>
  </div>
  <p class="text-xs text-ink-500">
    In the composer, type <code>;name</code> or press <kbd>Ctrl</kbd> <kbd>;</kbd>. Placeholders: <code>{"{first_name}"}</code> <code>{"{name}"}</code>
    (first recipient), <code>{"{my_first_name}"}</code> <code>{"{my_name}"}</code>.
  </p>
</form>
