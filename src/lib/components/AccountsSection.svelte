<script lang="ts">
  // Settings > Accounts: every mailbox in the unified inbox, add another, sign one out.
  import { api, type Provider } from "$lib/api";
  import { mail } from "$lib/mail.svelte";

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function add(provider: Provider) {
    busy = true;
    error = null;
    try {
      await api.signIn(provider);
      await mail.init();
    } catch (err) {
      const msg = String(err);
      if (!msg.endsWith("cancelled")) error = msg;
    } finally {
      busy = false;
    }
  }

  let reconnecting = $state<number | null>(null);
  /** Sign in again in place: fixes an expired sign-in without removing the account or its mail. */
  async function reconnect(id: number) {
    reconnecting = id;
    error = null;
    try {
      await api.reconnectAccount(id);
      await mail.init();
    } catch (err) {
      const msg = String(err);
      if (!msg.endsWith("cancelled")) error = msg;
    } finally {
      reconnecting = null;
    }
  }

  async function signOut(id: number) {
    try {
      await api.signOut(id);
      await mail.init();
      if (!mail.account) mail.overlay = null;
    } catch (err) {
      error = String(err);
    }
  }
</script>

<div data-testid="accounts" class="space-y-2">
  <ul class="space-y-1">
    {#each mail.boot?.accounts ?? [] as a (a.id)}
      <li data-testid="account-row" data-email={a.email} class="flex items-center gap-2 text-sm">
        <span class={["size-2 shrink-0 rounded-full", mail.accountColor(a.id)]}></span>
        <span class="w-14 shrink-0 text-xs text-ink-500">{a.provider === "google" ? "Gmail" : "Microsoft"}</span>
        <span class="min-w-0 flex-1 truncate text-ink-100">
          {a.email}
          {#if a.oauthApp === "custom" && mail.boot?.builtin[a.provider as "microsoft" | "google"]}<span data-testid="account-own-app" class="text-ink-500"> · your app</span>{/if}
          {#if a.displayName}<span class="text-ink-500"> · {a.displayName}</span>{/if}
          {#if !a.signedIn}<span class="text-amber-300"> · signed out</span>{/if}
        </span>
        {#if reconnecting === a.id}
          <span data-testid="account-reconnecting" class="text-xs text-ink-300">Finish in your browser…</span>
          <button onclick={() => api.cancelSignIn()} class="text-xs text-ink-500 hover:text-ink-100">Cancel</button>
        {:else}
          <button
            data-testid="account-reconnect"
            onclick={() => reconnect(a.id)}
            disabled={reconnecting !== null || busy}
            title="Sign in to this account again, keeping its mail"
            class={["text-xs disabled:opacity-40", a.signedIn ? "text-ink-500 hover:text-ink-100" : "text-amber-300 hover:text-amber-200"]}
          >
            {a.signedIn ? "Reconnect" : "Sign in again"}
          </button>
          {#if a.signedIn}
            <button data-testid="account-signout" onclick={() => signOut(a.id)} class="text-xs text-ink-500 hover:text-red-300">Sign out</button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
  {#if error}<p data-testid="account-error" class="text-xs text-red-300">{error}</p>{/if}
  <div class="flex items-center gap-3">
    {#if busy}
      <span data-testid="account-adding" class="text-xs text-ink-300">Finish signing in in your browser…</span>
      <button onclick={() => api.cancelSignIn()} class="text-xs text-ink-500 hover:text-ink-100">Cancel</button>
    {:else}
      <button data-testid="account-add" onclick={() => add("microsoft")} class="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-ink-300 hover:text-ink-100">
        + Add Microsoft account
      </button>
      <button
        data-testid="account-add-google"
        onclick={() => add("google")}
        disabled={!mail.boot?.builtin.google && !mail.boot?.googleClientId}
        title={mail.boot?.builtin.google || mail.boot?.googleClientId ? "" : "Set up a Google app under Advanced first"}
        class="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-ink-300 hover:text-ink-100 disabled:opacity-40"
      >
        + Add Google account
      </button>
    {/if}
  </div>
  <p class="text-xs text-ink-500">
    All accounts share one inbox. Reconnect signs in again without losing anything (for an expired sign-in or a new permission). Signing out removes that account's cached mail from this PC. Use <code>account:work</code> in search or a split to
    see one account.
  </p>
</div>
