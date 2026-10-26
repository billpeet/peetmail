<script lang="ts">
  // Google OAuth client (a "Desktop app" client in Google Cloud), shared by Setup and Settings.
  import { api } from "$lib/api";
  import { mail } from "$lib/mail.svelte";

  let { onsaved }: { onsaved?: () => void } = $props();

  let clientId = $state(mail.boot?.googleClientId ?? "");
  let secret = $state("");
  let error = $state<string | null>(null);
  let saved = $state(false);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    try {
      await api.setGoogleClient(clientId, secret || null);
      await mail.init();
      saved = true;
      onsaved?.();
    } catch (err) {
      error = String(err);
    }
  }
</script>

<form data-testid="google-client-form" onsubmit={save} class="space-y-2">
  <input
    data-testid="google-client-id"
    bind:value={clientId}
    oninput={() => (saved = false)}
    placeholder="1234-abc.apps.googleusercontent.com"
    spellcheck="false"
    autocomplete="off"
    class="w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100 outline-none select-text focus:border-accent"
  />
  <div class="flex gap-2">
    <input
      data-testid="google-client-secret"
      type="password"
      bind:value={secret}
      oninput={() => (saved = false)}
      placeholder={mail.boot?.googleClientId ? "Client secret (leave blank to keep)" : "Client secret"}
      spellcheck="false"
      autocomplete="off"
      class="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100 outline-none select-text focus:border-accent"
    />
    <button data-testid="google-client-save" class="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-ink-300 hover:text-ink-100">Save</button>
  </div>
  {#if saved}<p class="text-xs text-ink-500">Saved.</p>{/if}
  {#if error}<p data-testid="google-client-error" class="text-xs text-red-300">{error}</p>{/if}
  <p class="text-xs text-ink-500">
    From a <b>Desktop app</b> OAuth client in Google Cloud with the Gmail API enabled. Google says a desktop client's secret isn't
    confidential; it's stored on this PC only. Setup steps: docs/PLAN.md, "Google Cloud setup".
  </p>
</form>
