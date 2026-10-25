import {
  api,
  type Action,
  type Bootstrap,
  type DraftKind,
  type Folder,
  type MessageRow,
  type OutboxStatus,
  type SplitInfo,
  type SyncStatus,
  type ThreadRow,
} from "./api";
import { prefetchBody } from "./bodies";

const PAGE = 200;
/** Load the next page when the selection gets this close to the end. */
const LOAD_AHEAD = 50;
const REFRESH_DEBOUNCE_MS = 150;
const PREFETCH_DELAY_MS = 120;
const TOAST_MS = 5000;

export type View = "list" | "reader";
export type Overlay = null | "help" | "settings" | "palette";

export type ComposerState = {
  kind: DraftKind;
  /** Message replied to or forwarded. */
  referenceMessageId: number | null;
  to: string;
  cc: string;
  subject: string;
  body: string;
};

export type Toast = { text: string; undo?: boolean; error?: boolean };

class MailStore {
  boot = $state<Bootstrap | null>(null);
  account = $derived(this.boot?.accounts.find((a) => a.signedIn) ?? null);
  folder = $state<Folder | null>(null);

  splits = $state.raw<SplitInfo[]>([]);
  splitIndex = $state(0);
  /**
   * Indexes of the tabs to show. With "hide empty splits" on, empty splits are left out,
   * but Inbox and the tab you're on always stay, so the view never jumps from under you.
   */
  visibleSplits = $derived(
    this.splits
      .map((_, i) => i)
      .filter((i) => {
        const s = this.splits[i];
        return !this.boot?.preferences.hideEmptySplits || s.builtin || s.count > 0 || i === this.splitIndex;
      }),
  );
  /** Active search text; when non-null the list shows search results across all mail. */
  search = $state<string | null>(null);

  threads = $state.raw<ThreadRow[]>([]);
  selected = $state(0);
  current = $derived(this.threads[this.selected] ?? null);

  view = $state<View>("list");
  overlay = $state<Overlay>(null);
  thread = $state.raw<MessageRow[]>([]);
  /** Conversation that `thread` belongs to; lags `current` while a thread loads. */
  threadFor = $state<string | null>(null);
  /** Remote images allowed for the open conversation. */
  imagesFor = $state<string | null>(null);

  composer = $state<ComposerState | null>(null);
  toast = $state<Toast | null>(null);
  outbox = $state<OutboxStatus>({ pending: 0, failed: 0, lastError: null });
  sync = $state<SyncStatus>({ state: "idle", message: null });
  error = $state<string | null>(null);

  /**
   * Bumped by every list reload. Responses that come back after a newer reload started are
   * dropped, so fast Tab presses can't leave one split's mail showing under another's tab.
   */
  #listSeq = 0;
  #exhausted = false;
  #loadingMore = false;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Query and scope behind the current list. */
  get listQuery(): { folderId: number | null; query: string; split: number | null } {
    if (this.search !== null) return { folderId: null, query: this.search, split: null };
    return { folderId: this.folder?.id ?? null, query: "", split: this.splitIndex };
  }

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
      this.splits = [];
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

  async setHideEmptySplits(hide: boolean) {
    if (!this.boot) return;
    const preferences = { ...this.boot.preferences, hideEmptySplits: hide };
    await api.setPreferences(preferences);
    this.boot = { ...this.boot, preferences };
  }

  /** Reloads everything currently loaded, keeping the selection on the same conversation. */
  async refresh() {
    if (!this.folder) return;
    const seq = ++this.#listSeq;
    const folderForSplits = this.folder.id;
    const { folderId, query, split } = this.listQuery;
    const keep = this.current?.conversationId;
    const count = Math.max(PAGE, this.threads.length);
    const [splits, rows] = await Promise.all([
      api.listSplits(folderForSplits),
      api.listThreads(folderId, query, split, null, count),
    ]);
    if (seq !== this.#listSeq) return;
    this.splits = splits;
    if (this.splitIndex >= splits.length) this.splitIndex = 0;
    this.threads = rows;
    this.#exhausted = rows.length < count;
    const idx = keep ? rows.findIndex((t) => t.conversationId === keep) : -1;
    this.selected = idx >= 0 ? idx : Math.min(this.selected, Math.max(0, rows.length - 1));
    this.#schedulePrefetch();
    const cur = this.current;
    if (this.view === "reader") {
      if (!cur) {
        this.view = "list";
      } else {
        const thread = await api.getThread(cur.accountId, cur.conversationId);
        if (seq !== this.#listSeq) return;
        this.thread = thread;
        this.threadFor = cur.conversationId;
      }
    }
  }

  async loadMore() {
    if (!this.folder || this.#exhausted || this.#loadingMore) return;
    const last = this.threads.at(-1);
    if (!last) return;
    this.#loadingMore = true;
    const seq = this.#listSeq;
    try {
      const { folderId, query, split } = this.listQuery;
      const rows = await api.listThreads(folderId, query, split, { receivedAt: last.receivedAt, messageId: last.messageId }, PAGE);
      if (seq !== this.#listSeq) return; // the list was reloaded meanwhile
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
    // Load the thread first (a local query) so the reader never flashes empty or stale.
    const rows = await api.getThread(t.accountId, t.conversationId);
    if (this.current?.conversationId !== t.conversationId) return;
    this.thread = rows;
    this.threadFor = t.conversationId;
    this.view = "reader";
    // Opening a conversation reads it, like every mail client; not worth an undo entry.
    if (t.unreadCount > 0) this.act("markRead", { undoable: false, quiet: true });
  }

  back() {
    this.view = "list";
  }

  // ---------- splits and search ----------

  async switchSplit(index: number) {
    if (!this.splits.length) return;
    this.search = null;
    this.splitIndex = (index + this.splits.length) % this.splits.length;
    this.selected = 0;
    this.view = "list";
    await this.refresh();
  }

  /** Next/previous visible tab (Tab / Shift+Tab). */
  async cycleSplit(step: 1 | -1) {
    const vis = this.visibleSplits;
    if (!vis.length) return;
    const pos = vis.indexOf(this.splitIndex);
    const next = vis[(pos + step + vis.length) % vis.length];
    await this.switchSplit(next);
  }


  startSearch() {
    this.search = this.search ?? "";
    this.view = "list";
  }

  setSearch(text: string) {
    this.search = text;
    clearTimeout(this.#searchTimer);
    this.#searchTimer = setTimeout(() => {
      this.selected = 0;
      this.refresh();
    }, 120);
  }

  async endSearch() {
    if (this.search === null) return;
    this.search = null;
    this.selected = 0;
    await this.refresh();
  }

  // ---------- triage ----------

  async act(action: Action, { undoable = true, quiet = false } = {}) {
    const t = this.current;
    if (!t) return;
    try {
      const out = await api.threadAction(t.accountId, t.conversationId, action, undoable);
      if (out.label && !quiet) this.showToast({ text: out.label, undo: undoable });
      // mail-changed triggers the refresh; do it now too so the list never lags a keypress.
      await this.refresh();
      // In the reader, archive/delete moves straight on to the next conversation.
      if ((action === "archive" || action === "trash") && this.view === "reader" && this.current) await this.open();
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  async toggleRead() {
    const t = this.current;
    if (t) await this.act(t.unreadCount > 0 ? "markRead" : "markUnread");
  }

  async toggleFlag() {
    const t = this.current;
    if (t) await this.act(t.isFlagged ? "unflag" : "flag");
  }

  async undo() {
    try {
      const label = await api.undo();
      this.showToast({ text: label ? `Undid: ${label.toLowerCase()}` : "Nothing to undo" });
      await this.refresh();
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  showToast(t: Toast) {
    this.toast = t;
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => (this.toast = null), TOAST_MS);
  }

  // ---------- compose ----------

  compose() {
    this.composer = { kind: "new", referenceMessageId: null, to: "", cc: "", subject: "", body: "" };
  }

  /** Reply, reply all or forward the newest message of the current conversation. */
  async respond(kind: Exclude<DraftKind, "new">) {
    const t = this.current;
    if (!t || !this.account) return;
    const msgs = this.threadFor === t.conversationId ? this.thread : await api.getThread(t.accountId, t.conversationId);
    // Reply to the newest message someone else sent, if there is one.
    const me = this.account.email.toLowerCase();
    const ref = [...msgs].reverse().find((m) => m.fromAddress?.toLowerCase() !== me) ?? msgs.at(-1);
    if (!ref) return;
    const notMe = (a: string | null | undefined): a is string => !!a && a.toLowerCase() !== me;
    const fromIsMe = !notMe(ref.fromAddress);
    let to: string[] = [];
    let cc: string[] = [];
    if (kind === "reply") to = fromIsMe ? ref.to.map((r) => r.address).filter(notMe) : [ref.fromAddress!];
    if (kind === "replyAll") {
      to = [...new Set([ref.fromAddress, ...ref.to.map((r) => r.address)].filter(notMe))];
      cc = ref.cc.map((r) => r.address).filter(notMe);
    }
    const bare = ref.subject.replace(/^((re|fw|fwd):\s*)+/i, "");
    this.composer = {
      kind,
      referenceMessageId: ref.id,
      to: to.join(", "),
      cc: cc.join(", "),
      subject: (kind === "forward" ? "FW: " : "RE: ") + bare,
      body: "",
    };
  }

  async send() {
    const c = this.composer;
    if (!c || !this.account) return;
    const split = (s: string) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    try {
      await api.sendMessage({
        accountId: this.account.id,
        kind: c.kind,
        referenceMessageId: c.referenceMessageId,
        to: split(c.to),
        cc: split(c.cc),
        subject: c.subject,
        body: c.body,
      });
      this.composer = null;
      this.showToast({ text: "Sending…" });
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  // ---------- misc ----------

  /**
   * Pull the bodies around the cursor into the in-memory cache so opening (or j/k in the
   * reader) skips even the IPC round trip. Rust's background prefetch has usually put them
   * in SQLite already; this covers older mail and anything it hasn't reached yet.
   */
  #schedulePrefetch() {
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = setTimeout(() => {
      const s = this.selected;
      for (const i of [s, s + 1, s + 2, s + 3, s - 1]) {
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
