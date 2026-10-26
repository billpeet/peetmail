import {
  api,
  type Action,
  type Bootstrap,
  type DraftKind,
  type Folder,
  type MessageRow,
  type OutboxStatus,
  type Preferences,
  type RecentOpen,
  type Invite,
  type Rsvp,
  type SplitInfo,
  type SyncStatus,
  type ThreadRow,
} from "./api";
import { prefetchBody } from "./bodies";
import { calendar } from "./calendar.svelte";

const PAGE = 200;
/** Load the next page when the selection gets this close to the end. */
const LOAD_AHEAD = 50;
const REFRESH_DEBOUNCE_MS = 150;
const PREFETCH_DELAY_MS = 120;
const TOAST_MS = 5000;
/** In the preview layout, a conversation counts as read once it's been shown this long. */
const PREVIEW_DWELL_MS = 1500;

export type View = "list" | "reader" | "calendar";
export type Overlay = null | "help" | "settings" | "palette" | "event";

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
  /**
   * A conversation opened from outside the list (Recent Opens: archived, another split,
   * older than the cache window). While set, it's what the reader shows and acts on.
   */
  pinned = $state.raw<ThreadRow | null>(null);
  current = $derived(this.pinned ?? this.threads[this.selected] ?? null);
  recent = $state.raw<RecentOpen[]>([]);

  view = $state<View>("list");
  overlay = $state<Overlay>(null);
  thread = $state.raw<MessageRow[]>([]);
  /** Conversation that `thread` belongs to; lags `current` while a thread loads. */
  threadFor = $state<string | null>(null);
  /** The meeting invite in the open conversation, if any (for the RSVP card and y/m/n). */
  invite = $state.raw<Invite | null>(null);
  #inviteSeq = 0;
  /** Remote images allowed for the open conversation. */
  imagesFor = $state<string | null>(null);

  composer = $state<ComposerState | null>(null);
  toast = $state<Toast | null>(null);
  outbox = $state<OutboxStatus>({ pending: 0, failed: 0, lastError: null });
  /** True once changes have been waiting a while (slow or offline); routine 2s sends stay quiet. */
  outboxSlow = $state(false);
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
  #slowTimer: ReturnType<typeof setTimeout> | undefined;
  #dwellTimer: ReturnType<typeof setTimeout> | undefined;

  /** Preview layout: list on the left, the selected conversation beside it. */
  get previewing(): boolean {
    return this.boot?.preferences.layout === "preview";
  }

  setOutbox(s: OutboxStatus) {
    this.outbox = s;
    if (s.pending === 0) {
      clearTimeout(this.#slowTimer);
      this.#slowTimer = undefined;
      this.outboxSlow = false;
    } else if (this.#slowTimer === undefined && !this.outboxSlow) {
      this.#slowTimer = setTimeout(() => {
        this.#slowTimer = undefined;
        this.outboxSlow = this.outbox.pending > 0;
      }, 4000);
    }
  }

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

  async setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (!this.boot) return;
    const preferences = { ...this.boot.preferences, [key]: value };
    this.boot = { ...this.boot, preferences };
    await api.setPreferences(preferences);
  }

  async setHideEmptySplits(hide: boolean) {
    await this.setPreference("hideEmptySplits", hide);
  }

  toggleRightPane() {
    this.setPreference("showRightPane", !(this.boot?.preferences.showRightPane ?? true));
  }

  /** `0`: show the calendar in the right pane, or go back to Recent Opens if it's showing. */
  async toggleCalendarPane() {
    const p = this.boot?.preferences;
    if (!p) return;
    if (!p.showRightPane || p.rightPaneTab !== "calendar") {
      await this.setPreference("showRightPane", true);
      await this.setPreference("rightPaneTab", "calendar");
    } else {
      await this.setPreference("rightPaneTab", "recent");
    }
  }

  /** Reloads everything currently loaded, keeping the selection on the same conversation. */
  async refresh() {
    if (!this.folder) return;
    const seq = ++this.#listSeq;
    const folderForSplits = this.folder.id;
    const { folderId, query, split } = this.listQuery;
    const keep = this.current?.conversationId;
    const count = Math.max(PAGE, this.threads.length);
    const [splits, rows, recent] = await Promise.all([
      api.listSplits(folderForSplits),
      api.listThreads(folderId, query, split, null, count),
      api.recentOpens(),
    ]);
    if (seq !== this.#listSeq) return;
    this.recent = recent;
    this.splits = splits;
    if (this.splitIndex >= splits.length) this.splitIndex = 0;
    this.threads = rows;
    this.#exhausted = rows.length < count;
    const idx = keep ? rows.findIndex((t) => t.conversationId === keep) : -1;
    this.selected = idx >= 0 ? idx : Math.min(this.selected, Math.max(0, rows.length - 1));
    this.#schedulePrefetch();
    const cur = this.current;
    if (this.view === "reader" || this.previewing) {
      if (!cur) {
        this.view = "list";
        this.thread = [];
        this.threadFor = null;
        this.invite = null;
      } else {
        const thread = await api.getThread(cur.accountId, cur.conversationId);
        if (seq !== this.#listSeq) return;
        this.thread = thread;
        this.threadFor = cur.conversationId;
        this.#loadInvite();
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
    this.pinned = null;
    if (!this.threads.length) return;
    this.selected = Math.max(0, Math.min(index, this.threads.length - 1));
    if (this.selected >= this.threads.length - LOAD_AHEAD) this.loadMore();
    this.#schedulePrefetch();
    if (this.view === "reader") this.open();
    else if (this.previewing) this.preview();
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
    this.#loadInvite();
    this.view = "reader";
    api.recordOpen(t.accountId, t.conversationId).then(async () => (this.recent = await api.recentOpens()));
    // Opening a conversation reads it, like every mail client; not worth an undo entry.
    if (t.unreadCount > 0) this.act("markRead", { undoable: false, quiet: true });
  }

  /** Mouse: click a row to open it (in the preview layout, to preview it). */
  async openAt(index: number) {
    this.pinned = null;
    this.selected = Math.max(0, Math.min(index, this.threads.length - 1));
    if (this.previewing && this.view === "list") await this.preview();
    else await this.open();
  }

  /**
   * Shows the selected conversation in the reading pane. It's only marked read (and added
   * to Recent Opens) after PREVIEW_DWELL_MS, so skimming past with j doesn't read everything.
   */
  async preview() {
    clearTimeout(this.#dwellTimer);
    const t = this.current;
    if (!t) {
      this.thread = [];
      this.threadFor = null;
      this.invite = null;
      return;
    }
    const rows = await api.getThread(t.accountId, t.conversationId);
    if (this.current?.conversationId !== t.conversationId) return;
    this.thread = rows;
    this.threadFor = t.conversationId;
    this.#loadInvite();
    this.#dwellTimer = setTimeout(() => {
      if (this.current?.conversationId !== t.conversationId || !this.previewing) return;
      api.recordOpen(t.accountId, t.conversationId).then(async () => (this.recent = await api.recentOpens()));
      if (t.unreadCount > 0) this.act("markRead", { undoable: false, quiet: true });
    }, PREVIEW_DWELL_MS);
  }

  async toggleLayout() {
    const next = this.previewing ? "list" : "preview";
    await this.setPreference("layout", next);
    this.view = "list";
    this.pinned = null;
    if (next === "preview") await this.preview();
    else clearTimeout(this.#dwellTimer);
  }

  /** Opens a Recent Opens entry: selects it in the list if it's there, else pins it. */
  async openRecent(r: RecentOpen) {
    this.search = null;
    const index = this.threads.findIndex((t) => t.conversationId === r.conversationId && t.accountId === r.accountId);
    if (index >= 0) return this.openAt(index);
    this.pinned = r;
    await this.open();
  }

  /** `1` / the rail: back to mail from wherever you are (the calendar, the reader stays). */
  showMail() {
    if (this.view === "calendar") this.view = "list";
  }

  back() {
    this.view = "list";
    this.pinned = null;
    // In the list layout the invite is no longer on screen.
    if (!this.previewing) {
      this.invite = null;
      calendar.clearContext();
    }
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
      // In the reader, archive/delete moves straight on to the next conversation; a pinned
      // conversation (opened from Recent Opens) returns to the list instead.
      if ((action === "archive" || action === "trash") && this.view === "reader") {
        if (this.pinned) this.back();
        else if (this.current) await this.open();
      } else if ((action === "archive" || action === "trash") && this.previewing) {
        await this.preview(); // the next conversation slid into place; restart its dwell timer
      }
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  /** Mouse: run an action on a row without opening it (hover buttons). */
  async actAt(index: number, action: Action) {
    this.selected = index;
    await this.act(action);
  }

  /** Finds the newest invite in the loaded thread and fetches its event. */
  async #loadInvite() {
    const seq = ++this.#inviteSeq;
    // The newest actual request (invite or update); responses and cancellations don't get
    // RSVP buttons. Fall back to any meeting message if its kind isn't known yet.
    const newestFirst = [...this.thread].reverse();
    const msg =
      newestFirst.find((m) => m.meetingMessageType === "meetingRequest") ??
      newestFirst.find((m) => m.messageType === "eventMessage" && !m.meetingMessageType);
    if (!msg) {
      this.invite = null;
      calendar.clearContext();
      return;
    }
    try {
      const invite = await api.inviteEvent(msg.id);
      if (seq !== this.#inviteSeq) return;
      this.invite = invite;
      // Show the meeting in the calendar sidebar, among everything else that day.
      if (invite) calendar.showInContext(invite.event);
      else calendar.clearContext();
    } catch {
      if (seq === this.#inviteSeq) {
        this.invite = null;
        calendar.clearContext();
      }
    }
  }

  async rsvp(response: Rsvp) {
    const inv = this.invite;
    if (!inv) return;
    const status = { accept: "accepted", tentative: "tentativelyAccepted", decline: "declined" }[response];
    // An invite fetch still in flight (e.g. from the refresh after opening) would bring
    // back the server's old answer; it must not overwrite this one.
    this.#inviteSeq++;
    try {
      await api.respondToEvent(inv.event.accountId, inv.event.remoteId, response);
      this.invite = { ...inv, event: { ...inv.event, response: status } };
      calendar.focus = this.invite.event;
      this.showToast({ text: { accept: "Accepted", tentative: "Tentatively accepted", decline: "Declined" }[response] });
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
