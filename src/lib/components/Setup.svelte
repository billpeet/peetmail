<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import { keymap } from "$lib/keys.svelte";
  import { mail } from "$lib/mail.svelte";
  import ClientIdForm from "./ClientIdForm.svelte";

  let editing = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const clientId = $derived(mail.boot?.clientId ?? null);
  const showForm = $derived(editing || !clientId);
  /** Mailbox whose cache is waiting for a fresh sign-in (e.g. after a client ID change). */
  const returning = $derived(mail.boot?.accounts.find((a) => !a.signedIn) ?? null);

  async function signIn() {
    busy = true;
    error = null;
    try {
      await api.signIn();
      await mail.init();
    } catch (err) {
      const msg = String(err);
      if (!msg.endsWith("cancelled")) error = msg;
    } finally {
      busy = false;
    }
  }

  function edit() {
    if (busy) api.cancelSignIn();
    error = null;
    editing = true;
  }

  onMount(() =>
    keymap.register([
      { id: "setup.signin", keys: "Enter", label: "Sign in", group: "Setup", when: () => !showForm && !busy, run: signIn },
      { id: "setup.cancel", keys: "Escape", label: "Cancel sign-in", group: "Setup", when: () => !showForm && busy, run: () => api.cancelSignIn() },
      { id: "setup.clientid", keys: "c", label: "Change client ID", group: "Setup", when: () => !showForm, run: edit },
    ]),
  );
</script>

<div class="grid h-full place-items-center">
  <div class="w-[460px] space-y-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight text-ink-100">PeetMail</h1>
      <p class="mt-1 text-sm text-ink-500">Fast, keyboard-first mail for Microsoft 365 and Outlook.com.</p>
    </div>

    {#if showForm}
      <ClientIdForm
        autofocus
        oncancel={clientId ? () => (editing = false) : undefined}
        onsaved={() => (editing = false)}
      />
    {:else}
      <div class="space-y-3">
        {#if busy}
          <div class="flex w-full items-center justify-between rounded-md bg-ink-800 px-4 py-2.5 text-sm text-ink-300">
            <span>Waiting for the browser…</span>
            <button onclick={() => api.cancelSignIn()} class="flex items-center gap-1.5 text-ink-500 hover:text-ink-100">
              Cancel <kbd>Esc</kbd>
            </button>
          </div>
          <p class="text-xs text-ink-500">
            If the browser shows an error about the application, the client ID is probably wrong. Press <kbd>c</kbd> to change it.
          </p>
        {:else}
          <button
            onclick={signIn}
            class="flex w-full items-center justify-between rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-ink-950"
          >
            <span>{returning ? `Sign in again as ${returning.email}` : "Sign in with Microsoft"}</span>
            <kbd>Enter</kbd>
          </button>
        {/if}

        <div class="flex items-center justify-between text-xs text-ink-500">
          <span class="truncate">Client ID <span class="font-mono text-ink-300 select-text">{clientId}</span></span>
          <button onclick={edit} class="flex shrink-0 items-center gap-1.5 hover:text-ink-100">Change <kbd>c</kbd></button>
        </div>
      </div>
    {/if}

    {#if error}
      <p class="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300 select-text">{error}</p>
    {/if}
  </div>
</div>
