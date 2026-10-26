<script lang="ts">
  import { api } from "$lib/api";
  import { mail } from "$lib/mail.svelte";
  import ClientIdForm from "./ClientIdForm.svelte";
  import SplitEditor from "./SplitEditor.svelte";

  let cacheDays = $state(mail.boot?.cacheLimits.cacheDays ?? 90);
  let bodyCacheMb = $state(mail.boot?.cacheLimits.bodyCacheMb ?? 500);
  let error = $state<string | null>(null);

  let first: HTMLInputElement | undefined = $state();
  $effect(() => first?.focus());

  async function save(e: SubmitEvent) {
    e.preventDefault();
    try {
      await api.setCacheLimits({ cacheDays, bodyCacheMb });
      await mail.init();
      mail.overlay = null;
    } catch (err) {
      error = String(err);
    }
  }

  async function signOut() {
    if (!mail.account) return;
    await api.signOut(mail.account.id);
    mail.overlay = null;
    mail.threads = [];
    mail.folder = null;
    await mail.init();
  }
</script>

<div data-testid="settings" onclick={(e) => e.target === e.currentTarget && (mail.overlay = null)} role="presentation" class="fixed inset-x-0 top-9 bottom-0 z-20 grid place-items-center bg-black/60">
    <div class="max-h-[85vh] w-[520px] space-y-6 overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 p-6 shadow-2xl">
    <h2 class="text-sm font-semibold text-ink-100">Settings</h2>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Microsoft account</h3>
      <!-- A changed ID signs out, and the page falls back to the sign-in screen. -->
      <ClientIdForm onsaved={() => (mail.overlay = null)} />
    </section>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Split inboxes</h3>
      <SplitEditor />
    </section>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Sending</h3>
      <label class="flex items-center justify-between text-sm text-ink-300">
        Undo send window
        <select
          data-testid="undo-send-select"
          value={mail.boot?.preferences.undoSendSecs ?? 10}
          onchange={(e) => mail.setPreference("undoSendSecs", Number(e.currentTarget.value))}
          class="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none focus:border-accent"
        >
          {#each [0, 5, 10, 20, 30] as s (s)}
            <option value={s}>{s ? `${s} seconds` : "Off"}</option>
          {/each}
        </select>
      </label>
    </section>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Calendar</h3>
      <label class="flex items-center justify-between text-sm text-ink-300">
        Week starts on
        <select
          data-testid="week-start-select"
          value={mail.boot?.preferences.weekStartsOn ?? 1}
          onchange={(e) => mail.setPreference("weekStartsOn", Number(e.currentTarget.value))}
          class="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none focus:border-accent"
        >
          {#each [1, 0, 6, 2, 3, 4, 5] as d (d)}
            <option value={d}>{new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: "long" })}</option>
          {/each}
        </select>
      </label>
    </section>

    <form onsubmit={save} class="space-y-5">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Offline cache</h3>

      <label class="block space-y-1">
        <span class="text-sm text-ink-300">Keep mail from the last</span>
        <span class="flex items-center gap-2">
          <input bind:this={first} type="number" min="7" max="3650" bind:value={cacheDays}
            class="w-24 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none focus:border-accent" />
          <span class="text-sm text-ink-500">days</span>
        </span>
        <span class="block text-xs text-ink-500">Older mail stays on the server. Widening the window triggers a full resync.</span>
      </label>

      <label class="block space-y-1">
        <span class="text-sm text-ink-300">Message body cache</span>
        <span class="flex items-center gap-2">
          <input type="number" min="50" max="20000" step="50" bind:value={bodyCacheMb}
            class="w-24 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none focus:border-accent" />
          <span class="text-sm text-ink-500">MB</span>
        </span>
        <span class="block text-xs text-ink-500">Least recently read bodies are evicted first.</span>
      </label>

    {#if error}<p class="text-sm text-red-300">{error}</p>{/if}

    <div class="flex items-center justify-between pt-2">
      <button type="button" onclick={signOut} class="text-sm text-ink-500 hover:text-red-300">
        Sign out {mail.account?.email}
      </button>
      <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-ink-950">Save <kbd class="ml-1">Enter</kbd></button>
    </div>
  </form>
  </div>
</div>
