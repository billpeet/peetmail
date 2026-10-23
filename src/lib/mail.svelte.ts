import { api, type Bootstrap, type Folder, type MessageRow, type SyncStatus, type ThreadRow } from "./api";
import { prefetchBody } from "./bodies";

const PAGE = 200;
/** Load the next page when the selection gets this close to the end. */
const LOAD_AHEAD = 50;
const REFRESH_DEBOUNCE_MS = 150;
const PREFETCH_DELAY_MS = 120;

export type View = "list" | "reader";
export type Overlay = null | "help" | "settings";

class MailStore {
  boot = $state<Bootstrap | null>(null);
  account = $derived(this.boot?.accounts.find((a) => a.signedIn) ?? null);
  folder = $state<Folder | null>(null);

  threads = $state.raw<ThreadRow[]>([]);
  selected = $state(0);
  current = $derived(this.threads[this.selected] ?? null);

  view = $state<View>("list");
  overlay = $state<Overlay>(null);
  thread = $state.raw<MessageRow[]>([]);

  sync = $state<SyncStatus>({ state: "idle", message: null });
  error = $state<string | null>(null);

  #exhausted = false;
  #loadingMore = false;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #prefetchTimer: ReturnType<typeof setTimeout> | undefined;

  async init() {
    try {
      this.boot = await api.bootstrap();
      await this.loadFolder();
    } catch (e) {
      this.error = String(e);
    }
  }

  async loadFolder() {
    if (!this.account) {
      this.folder = null;
      this.threads = [];
      this.view = "list";
      return;
    }
    const folders = await api.listFolders(this.account.id);
    this.folder = folders.find((f) => f.role === "inbox") ?? null;
    if (this.folder) await this.refresh();
  }

  /** Called on every `mail-changed` event; coalesces bursts during initial sync. */
  scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      if (this.folder) this.refresh();
      else this.loadFolder();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Reloads everything currently loaded, keeping the selection on the same conversation. */
  async refresh() {
    if (!this.folder) return;
    const keep = this.current?.conversationId;
    const count = Math.max(PAGE, this.threads.length);
    const rows = await api.listThreads(this.folder.id, null, count);
    this.threads = rows;
    this.#exhausted = rows.length < count;
    const idx = keep ? rows.findIndex((t) => t.conversationId === keep) : -1;
    this.selected = idx >= 0 ? idx : Math.min(this.selected, Math.max(0, rows.length - 1));
    if (this.view === "reader" && this.current) {
      this.thread = await api.getThread(this.current.accountId, this.current.conversationId);
    }
  }

  async loadMore() {
    if (!this.folder || this.#exhausted || this.#loadingMore) return;
    const last = this.threads.at(-1);
    if (!last) return;
    this.#loadingMore = true;
    try {
      const rows = await api.listThreads(this.folder.id, { receivedAt: last.receivedAt, messageId: last.messageId }, PAGE);
      this.threads = [...this.threads, ...rows];
      this.#exhausted = rows.length < PAGE;
    } finally {
      this.#loadingMore = false;
    }
  }

  select(index: number) {
    if (!this.threads.length) return;
    this.selected = Math.max(0, Math.min(index, this.threads.length - 1));
    if (this.selected >= this.threads.length - LOAD_AHEAD) this.loadMore();
    this.#schedulePrefetch();
    if (this.view === "reader") this.open();
  }

  move(delta: number) {
    this.select(this.selected + delta);
  }

  async open() {
    const t = this.current;
    if (!t) return;
    this.view = "reader";
    const rows = await api.getThread(t.accountId, t.conversationId);
    if (this.current?.conversationId === t.conversationId) this.thread = rows;
  }

  back() {
    this.view = "list";
  }

  /** Warm the bodies around the cursor so opening (or j/k in the reader) is instant. */
  #schedulePrefetch() {
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = setTimeout(() => {
      for (const i of [this.selected, this.selected + 1, this.selected - 1]) {
        const t = this.threads[i];
        if (t) prefetchBody(t.messageId);
      }
    }, PREFETCH_DELAY_MS);
  }

  async syncNow() {
    try {
      await api.syncNow();
    } catch (e) {
      this.error = String(e);
    }
  }
}

export const mail = new MailStore();
