<script lang="ts">
  // Entra Application (client) ID editor, shared by the setup screen and Settings.
  import { api } from "$lib/api";
  import { mail } from "$lib/mail.svelte";

  let {
    autofocus = false,
    oncancel,
    onsaved,
  }: { autofocus?: boolean; oncancel?: () => void; onsaved?: () => void } = $props();

  const current = mail.boot?.clientId ?? "";
  let value = $state(current);
  let error = $state<string | null>(null);
  let input: HTMLInputElement | undefined = $state();

  const changed = $derived(value.trim().toLowerCase() !== current);
  // Only accounts that signed in with this (the user's own) app are affected.
  const signsOut = $derived(changed && !!current && !!mail.boot?.accounts.some((a) => a.signedIn && a.provider === "microsoft" && a.oauthApp === "custom"));

  $effect(() => {
    if (autofocus && input) {
      input.focus();
      input.select();
    }
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    if (!changed) return onsaved?.();
    try {
      await api.setClientId(value);
      await mail.init();
      onsaved?.();
    } catch (err) {
      error = String(err);
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && oncancel) {
      e.preventDefault();
      e.stopPropagation();
      oncancel();
    }
  }
</script>

<form class="space-y-2" onsubmit={save}>
  <label class="block text-sm text-ink-300" for="client-id">Application (client) ID of your Entra app registration</label>
  <div class="flex gap-2">
    <input
      id="client-id"
      data-testid="client-id-input"
      bind:this={input}
      bind:value
      {onkeydown}
      placeholder="00000000-0000-0000-0000-000000000000"
      spellcheck="false"
      autocomplete="off"
      class="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-1.5 font-mono text-sm text-ink-100 outline-none select-text focus:border-accent"
    />
    <button class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-ink-950">Save</button>
  </div>
  {#if signsOut}
    <p class="text-xs text-amber-300">Changing the client ID signs you out. Cached mail is kept and comes back when you sign in again.</p>
  {:else}
    <p class="text-xs text-ink-500">
      Overview page of the app in Entra. Setup steps are in docs/PLAN.md under "Entra app registration".
      {#if oncancel}<kbd>Esc</kbd> to cancel.{/if}
    </p>
  {/if}
  {#if error}<p data-testid="client-id-error" class="text-sm text-red-300 select-text">{error}</p>{/if}
</form>
