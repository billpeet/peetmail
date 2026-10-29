<script lang="ts">
  // Signatures: one per account, added under new messages and, if chosen, replies and
  // forwards. An account whose organisation adds signatures on its mail server (CodeTwo,
  // Exclaimer...) is marked so, and PeetMail adds none: recipients would get two.
  import { api, type Signature } from "#lib/api.js";
  import { mail } from "#lib/mail.svelte.js";
  import RichText from "./RichText.svelte";

  const blank = (address: string): Signature => ({ address, html: "", replies: false, managed: false });
  let rows = $state<Signature[]>(load());
  let saved = $state(false);
  let error = $state<string | null>(null);

  function load(): Signature[] {
    return mail.accounts.map((a) => {
      const address = a.email.toLowerCase();
      return { ...(mail.signatures.find((s) => s.address === address) ?? blank(address)) };
    });
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    try {
      // Signed-out accounts aren't listed; keep theirs for when they're back.
      const others = mail.signatures.filter((s) => !rows.some((r) => r.address === s.address));
      mail.signatures = await api.setSignatures([...others, ...$state.snapshot(rows)]);
      saved = true;
      error = null;
    } catch (err) {
      error = String(err);
    }
  }
</script>

<form data-testid="signature-editor" onsubmit={save} class="space-y-4">
  {#each rows as row (row.address)}
    <div data-testid="signature-row" data-address={row.address} class="space-y-2">
      {#if rows.length > 1}<p class="text-sm text-ink-300">{row.address}</p>{/if}
      {#if !row.managed}
        <RichText
          html={row.html}
          placeholder="Your name, role, phone…"
          onchange={(h) => {
            row.html = h;
            saved = false;
          }}
        />
        <label class="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" data-testid="signature-replies" bind:checked={row.replies} onchange={() => (saved = false)} class="size-4 accent-accent" />
          Add to replies and forwards too
        </label>
      {/if}
      <label class="flex items-center gap-2 text-sm text-ink-300">
        <input type="checkbox" data-testid="signature-managed" bind:checked={row.managed} onchange={() => (saved = false)} class="size-4 accent-accent" />
        My organisation adds my signature (for example CodeTwo or Exclaimer)
      </label>
    </div>
  {:else}
    <p class="text-sm text-ink-500">Add an account first.</p>
  {/each}
  {#if error}<p data-testid="signature-error" class="text-xs text-red-300">{error}</p>{/if}
  <div class="flex items-center justify-end gap-3">
    {#if saved}<span class="text-xs text-ink-500">Saved</span>{/if}
    <button data-testid="signature-save" class="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-ink-300 hover:text-ink-100">Save signatures</button>
  </div>
  <p class="text-xs text-ink-500">
    Change or remove it for one message in the composer (<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>S</kbd>).
  </p>
</form>
