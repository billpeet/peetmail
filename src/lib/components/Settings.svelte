<script lang="ts">
  import { api } from "$lib/api";
  import { mail } from "$lib/mail.svelte";
  import { updates, updateText } from "$lib/updates.svelte";
  import type { Privacy, UpdateChannel } from "$lib/api";
  import ClientIdForm from "./ClientIdForm.svelte";
  import SplitEditor from "./SplitEditor.svelte";
  import SnippetEditor from "./SnippetEditor.svelte";
  import AccountsSection from "./AccountsSection.svelte";
  import GoogleClientForm from "./GoogleClientForm.svelte";

  let cacheDays = $state(mail.boot?.cacheLimits.cacheDays ?? 90);
  let bodyCacheMb = $state(mail.boot?.cacheLimits.bodyCacheMb ?? 500);
  let error = $state<string | null>(null);
  let autostart = $state(false);
  api.getAutostart().then((v) => (autostart = v)).catch(() => {});
  let privacy = $state<Privacy | null>(null);
  api.privacy().then((p) => (privacy = p)).catch(() => {});
  let copied = $state(false);

  async function setCrashReports(on: boolean) {
    try {
      await api.setCrashReports(on);
      if (privacy) privacy.crashReports = on;
    } catch (err) {
      error = String(err);
    }
  }

  async function setUsageData(on: boolean) {
    try {
      await api.setUsageData(on);
      if (privacy) privacy.usageData = on;
    } catch (err) {
      error = String(err);
    }
  }

  async function copyInstallId() {
    if (!privacy) return;
    await navigator.clipboard.writeText(privacy.installId);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function setAutostart(on: boolean) {
    try {
      await api.setAutostart(on);
      autostart = on;
    } catch (err) {
      error = String(err);
    }
  }

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

</script>

<div data-testid="settings" onclick={(e) => e.target === e.currentTarget && (mail.overlay = null)} role="presentation" class="fixed inset-x-0 top-9 bottom-0 z-20 grid place-items-center bg-black/60">
    <div class="max-h-[85vh] w-[520px] space-y-6 overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 p-6 shadow-2xl">
    <h2 class="text-sm font-semibold text-ink-100">Settings</h2>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Accounts</h3>
      <AccountsSection />
    </section>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Microsoft app (client ID)</h3>
      <!-- A changed ID signs out, and the page falls back to the sign-in screen. -->
      <ClientIdForm onsaved={() => (mail.overlay = null)} />
    </section>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Google app (client ID)</h3>
      <GoogleClientForm />
    </section>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Split inboxes</h3>
      <SplitEditor />
    </section>

    <section class="space-y-2">
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Snippets</h3>
      <SnippetEditor />
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
      <h3 class="text-xs tracking-wide text-ink-500 uppercase">Desktop</h3>
      <label class="flex items-center justify-between text-sm text-ink-300">
        New mail notifications
        <select
          data-testid="notify-select"
          value={mail.boot?.preferences.notify ?? "focused"}
          onchange={(e) => mail.setPreference("notify", e.currentTarget.value as "off" | "focused" | "all")}
          class="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none focus:border-accent"
        >
          <option value="focused">Focused mail</option>
          <option value="all">All mail</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label class="flex items-center gap-2 text-sm text-ink-300">
        <input
          type="checkbox"
          data-testid="close-to-tray"
          checked={mail.boot?.preferences.closeToTray ?? true}
          onchange={(e) => mail.setPreference("closeToTray", e.currentTarget.checked)}
          class="accent-accent"
        />
        Keep running in the tray when the window is closed
      </label>
      <label class="flex items-center gap-2 text-sm text-ink-300">
        <input type="checkbox" data-testid="autostart" checked={autostart} onchange={(e) => setAutostart(e.currentTarget.checked)} class="accent-accent" />
        Start with Windows (in the tray)
      </label>
      <p class="text-xs text-ink-500">Notifications only show while PeetMail isn't the window you're using. <kbd>Ctrl</kbd> <kbd>Q</kbd> quits.</p>
    </section>

    {#if privacy}
      <section class="space-y-2">
        <h3 class="text-xs tracking-wide text-ink-500 uppercase">Privacy</h3>
        <label class="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" data-testid="crash-reports" checked={privacy.configured && privacy.crashReports} disabled={!privacy.configured} onchange={(e) => setCrashReports(e.currentTarget.checked)} class="accent-accent disabled:opacity-50" />
          Send crash reports
          {#if !privacy.configured}<span data-testid="crash-reports-off" class="text-xs text-ink-500">(this build doesn't send any)</span>{/if}
        </label>
        <label class="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" data-testid="usage-data" checked={privacy.usageConfigured && privacy.usageData} disabled={!privacy.usageConfigured} onchange={(e) => setUsageData(e.currentTarget.checked)} class="accent-accent disabled:opacity-50" />
          Send usage and performance data
          {#if !privacy.usageConfigured}<span data-testid="usage-data-off" class="text-xs text-ink-500">(this build doesn't send any)</span>{/if}
        </label>
        <p class="text-xs text-ink-500">
          Crash reports say what went wrong and where in the code. Usage data is timings and counts: how long syncs, searches
          and shortcuts take, and which fail. Mail, addresses, names, search words and sign-in details are never included.
          Turning usage data back on takes effect the next time PeetMail starts.
        </p>
        <div class="flex items-center justify-between gap-3 text-xs text-ink-500">
          <span>Install ID <span data-testid="install-id" class="font-mono text-ink-300 select-text">{privacy.installId}</span></span>
          <button data-testid="copy-install-id" type="button" onclick={copyInstallId} class="shrink-0 rounded-md border border-ink-700 px-2 py-1 text-ink-300 hover:text-ink-100">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </section>
    {/if}

    {#if updates.status}
      {@const u = updates.status}
      <section class="space-y-2">
        <h3 class="text-xs tracking-wide text-ink-500 uppercase">Updates</h3>
        <label class="flex items-center justify-between text-sm text-ink-300">
          <span>PeetMail <span data-testid="app-version" class="tabular-nums">{u.currentVersion}</span></span>
          <select
            data-testid="update-channel"
            value={u.channel}
            disabled={u.state === "disabled"}
            onchange={(e) => updates.setChannel(e.currentTarget.value as UpdateChannel)}
            class="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="stable">Stable releases</option>
            <option value="canary">Canary (every change)</option>
          </select>
        </label>
        <div class="flex items-center justify-between gap-3 text-sm">
          <span data-testid="update-status" data-state={u.state} class={["min-w-0 select-text", u.state === "error" ? "text-red-300" : "text-ink-500"]}>{updateText(u)}</span>
          {#if u.state === "ready"}
            <button data-testid="update-install" type="button" onclick={() => updates.install()} class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-ink-950">Restart to update</button>
          {:else}
            <button
              data-testid="update-check"
              type="button"
              disabled={u.state === "disabled" || updates.busy}
              onclick={() => updates.check()}
              class="shrink-0 rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100 disabled:opacity-50"
            >Check now</button>
          {/if}
        </div>
        <p class="text-xs text-ink-500">Canary gets every change as soon as it builds, so it can be rough. Moving back to Stable takes effect at the next stable release newer than the version you have.</p>
      </section>
    {/if}

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

    <div class="flex items-center justify-end pt-2">
      <button class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-ink-950">Save <kbd class="ml-1">Enter</kbd></button>
    </div>
  </form>
  </div>
</div>
