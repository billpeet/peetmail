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
  type QueuedSend,
  type SnoozedThread,
} from "./api";
import { prefetchBody } from "./bodies";
import type { Snippet } from "./snippets";
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
export type Overlay = null | "help" | "settings" | "palette" | "event" | "quickadd" | "scheduled" | "snooze" | "snoozed";

export type ComposerState = {
  /** The account it's sent from. */
  accountId: number;
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
  /** Signed-in accounts; their inboxes make up the unified inbox. */
  accounts = $derived(this.boot?.accounts.filter((a) => a.signedIn) ?? []);
  /** The first signed-in account: the default for new mail and events. */
  account = $derived(this.accounts[0] ?? null);

  accountOf(id: number) {
    return this.boot?.accounts.find((a) => a.id === id) ?? null;
  }

  /** True for any of your own addresses. */
  isMe(address: string | null | undefined): boolean {
    const a = address?.toLowerCase();
    return !!a && (this.boot?.accounts.some((x) => x.email.toLowerCase() === a) ?? false);
  }

  /** Dot colour that tells accounts apart (by sign-in order). */
  accountColor(id: number): string {
    const i = Math.max(0, this.boot?.accounts.findIndex((a) => a.id === id) ?? 0);
    return ["bg-sky-400", "bg-amber-400", "bg-emerald-400", "bg-rose-400", "bg-violet-400"][i % 5];
  }
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
  /** Composer snippets (;name). */
  snippets = $state.raw<Snippet[]>([]);
  /** Snoozed conversations, soonest back first. */
  snoozed = $state.raw<SnoozedThread[]>([]);
  /** The conversation the snooze picker acts on. */
  snoozeTarget = $state.raw<ThreadRow | null>(null);
  /** Messages scheduled to send later, soonest first. */
  scheduled = $state.raw<QueuedSend[]>([]);
  /** The send that `z` takes back while its toast is up. */
  #lastSend: { id: number; until: number } | null = null;
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
  #toastAt = 0;
  /** Bumped when you navigate back; an open() still loading then doesn't take you back in. */
  #navSeq = 0;
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
    // No folder: the unified inbox of every signed-in account.
    return { folderId: null, query: "", split: this.splitIndex };
  }

  async init() {
    try {
      this.boot = await api.bootstrap();
      api.listSnippets().then((s) => (this.snippets = s)).catch(() => {});
      calendar.setWeekStartsOn(this.boot.preferences.weekStartsOn);
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
    await this.refresh();
  }

  /** Called on every `mail-changed` event; coalesces bursts during initial sync. */
  scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      if (this.account) this.refresh();
      else this.loadFolder();
      this.refreshSnoozed();
    }, REFRESH_DEBOUNCE_MS);
  }

  async setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (!this.boot) return;
    const preferences = { ...this.boot.preferences, [key]: value };
    this.boot = { ...this.boot, preferences };
    if (key === "weekStartsOn") calendar.setWeekStartsOn(value as number);
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
    if (!this.account) return;
    const seq = ++this.#listSeq;
    const folderForSplits = null; // split tabs count the unified inbox
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
    if (!this.account || this.#exhausted || this.#loadingMore) return;
    const last = this.threads.at(-1);
    if (!last) return;
    this.#loadingMore = true;
    const seq = this.#listSeq;
    try {
      const { folderId, query, split } = this.listQuery;
      const rows = await api.listThreads(folderId, query, split, { sortAt: last.sortAt, messageId: last.messageId }, PAGE);
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
    const nav = this.#navSeq;
    // Load the thread first (a local query) so the reader never flashes empty or stale.
    const rows = await api.getThread(t.accountId, t.conversationId);
    if (this.current?.conversationId !== t.conversationId) return;
    // Esc (back to the list) while it loaded wins: don't reopen the reader behind it.
    if (nav !== this.#navSeq) return;
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
    this.#navSeq++;
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
      if (action === "archive" || action === "trash") await this.#afterRemoval();
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  /**
   * The current conversation just left the list (archived, deleted, snoozed). In the
   * reader, move straight on to the next one; a pinned conversation (opened from Recent
   * Opens or Snoozed) returns to the list instead.
   */
  async #afterRemoval() {
    if (this.view === "reader") {
      if (this.pinned) this.back();
      else if (this.current) await this.open();
    } else if (this.previewing) {
      await this.preview(); // the next conversation slid into place; restart its dwell timer
    }
  }

  // ---------- snooze ----------

  /** Opens the snooze picker for `t` (default: the current conversation). */
  startSnooze(t: ThreadRow | null = this.current) {
    if (!t) return;
    this.snoozeTarget = t;
    this.overlay = "snooze";
  }

  async snooze(until: Date) {
    const t = this.snoozeTarget;
    if (!t) return;
    const wasCurrent = this.current?.conversationId === t.conversationId && this.current?.accountId === t.accountId;
    // Close at once, so keys typed straight after (g h, j) aren't swallowed by the dialog.
    if (this.overlay === "snooze") this.overlay = null;
    this.snoozeTarget = null;
    try {
      const out = await api.snoozeThread(t.accountId, t.conversationId, until.toISOString());
      if (out.label) this.showToast({ text: `Snoozed until ${formatSendAt(until.toISOString())}`, undo: true });
      await this.refresh();
      this.refreshSnoozed();
      if (wasCurrent) await this.#afterRemoval();
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  async unsnooze(s: SnoozedThread) {
    try {
      await api.unsnoozeThread(s.accountId, s.conversationId);
      this.showToast({ text: "Back in your inbox" });
      await this.refresh();
      this.refreshSnoozed();
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  /** Opens a snoozed conversation without waking it. */
  async openSnoozed(s: SnoozedThread) {
    this.overlay = null;
    this.search = null;
    this.pinned = s;
    await this.open();
  }

  async refreshSnoozed() {
    try {
      this.snoozed = await api.listSnoozed();
    } catch {}
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
    const s = this.#lastSend;
    if (s && Date.now() < s.until) {
      this.#lastSend = null;
      const ok = await this.unsend(s.id).catch(() => false);
      this.showToast(ok ? { text: "Send undone" } : { text: "Too late: it's already been sent", error: true });
      return;
    }
    try {
      const label = await api.undo();
      this.showToast({ text: label ? `Undid: ${label.toLowerCase()}` : "Nothing to undo" });
      await this.refresh();
      this.refreshSnoozed();
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  showToast(t: Toast) {
    // A routine toast ("Created") mustn't wipe an error that has only just appeared.
    if (!t.error && this.toast?.error && Date.now() - this.#toastAt < 2000) return;
    this.toast = t;
    this.#toastAt = Date.now();
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => (this.toast = null), TOAST_MS);
  }

  // ---------- compose ----------

  compose() {
    if (!this.account) return;
    this.composer = { accountId: this.account.id, kind: "new", referenceMessageId: null, to: "", cc: "", subject: "", body: "" };
  }

  /** Reply, reply all or forward the newest message of the current conversation. */
  async respond(kind: Exclude<DraftKind, "new">) {
    const t = this.current;
    // Reply from the account the conversation belongs to.
    const account = this.accountOf(t?.accountId ?? -1);
    if (!t || !account) return;
    const msgs = this.threadFor === t.conversationId ? this.thread : await api.getThread(t.accountId, t.conversationId);
    // Reply to the newest message someone else sent, if there is one.
    const me = account.email.toLowerCase();
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
      accountId: account.id,
      kind,
      referenceMessageId: ref.id,
      to: to.join(", "),
      cc: cc.join(", "),
      subject: (kind === "forward" ? "FW: " : "RE: ") + bare,
      body: "",
    };
  }

  /** Sends the composer's message after the undo delay, or at `sendAt` when scheduling. */
  async send(sendAt?: Date) {
    const c = this.composer;
    if (!c) return;
    const split = (s: string) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    try {
      const out = await api.sendMessage({
        accountId: c.accountId,
        kind: c.kind,
        referenceMessageId: c.referenceMessageId,
        to: split(c.to),
        cc: split(c.cc),
        subject: c.subject,
        body: c.body,
        sendAt: sendAt?.toISOString(),
      });
      this.composer = null;
      const delayMs = new Date(out.sendAt).getTime() - Date.now();
      // Undo works while the toast is up, and never after the message has gone.
      this.#lastSend = { id: out.id, until: Date.now() + (out.scheduled ? TOAST_MS : Math.max(0, delayMs)) };
      const undo = out.scheduled || delayMs > 0;
      this.showToast({ text: out.scheduled ? `Scheduled for ${formatSendAt(out.sendAt)}` : "Sending…", undo });
      this.refreshScheduled();
    } catch (e) {
      this.showToast({ text: String(e), error: true });
    }
  }

  /** Takes back a send that hasn't gone and reopens it in the composer. */
  async unsend(id: number): Promise<boolean> {
    const q = await api.cancelSend(id);
    this.refreshScheduled();
    if (!q) return false;
    const d = q.draft;
    this.composer = {
      accountId: q.accountId,
      kind: d.kind,
      referenceMessageId: d.referenceMessageId ?? null,
      to: d.to.join(", "),
      cc: d.cc.join(", "),
      subject: d.subject,
      body: d.body,
    };
    return true;
  }

  /** Cancels a scheduled message without reopening it. */
  async cancelScheduled(id: number) {
    const q = await api.cancelSend(id);
    this.refreshScheduled();
    this.showToast(q ? { text: "Scheduled message cancelled" } : { text: "That message has already been sent", error: true });
  }

  async refreshScheduled() {
    try {
      this.scheduled = await api.scheduledSends();
    } catch {}
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

/** "Tue 27 Oct, 8:00 am" (today's sends drop the date). */
export function formatSendAt(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `today, ${time}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}
