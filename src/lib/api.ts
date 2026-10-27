// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Keep these in sync by hand for now (tauri-specta codegen is a candidate for later).
import type { Recurrence } from "./recurrence";
import type { Snippet } from "./snippets";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Account = {
  id: number;
  provider: string;
  email: string;
  displayName: string | null;
  /** False after the client ID changes; the cached mail is kept until the same mailbox signs in again. */
  signedIn: boolean;
};

export type Folder = {
  id: number;
  accountId: number;
  remoteId: string;
  role: string | null;
  name: string;
  deltaLink: string | null;
  lastSyncedAt: string | null;
};

export type ThreadRow = {
  /** Newest message in the conversation. */
  messageId: number;
  accountId: number;
  conversationId: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string;
  preview: string;
  messageCount: number;
  unreadCount: number;
  isFlagged: boolean;
  hasAttachments: boolean;
  /** What the list sorts by: receivedAt, or when a snooze brought it back. */
  sortAt: string;
  /** Back from a snooze. */
  reminder: boolean;
};

/** A snoozed conversation and when it comes back (UTC). */
export type SnoozedThread = ThreadRow & { until: string };

export type Recipient = { name: string | null; address: string | null };

export type MessageRow = {
  id: number;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  to: Recipient[];
  cc: Recipient[];
  receivedAt: string;
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  isFlagged: boolean;
  /** Folder holding this copy: inbox, sentitems, archive, ... */
  folderRole: string;
  /** "message", or "eventMessage" for meeting invites and responses. */
  messageType: string;
  /** meetingRequest | meetingCancelled | meetingAccepted | meetingTenativelyAccepted (Graph's spelling) | meetingDeclined */
  meetingMessageType: string | null;
};

export type Action = "archive" | "trash" | "markRead" | "markUnread" | "flag" | "unflag";
export type ActionOutcome = { label: string | null; changed: number };
export type DraftKind = "new" | "reply" | "replyAll" | "forward";
export type SendInput = {
  accountId: number;
  kind: DraftKind;
  referenceMessageId: number | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** Send later (UTC ISO). Omitted: after the undo delay. */
  sendAt?: string;
};
export type SendOutcome = { id: number; sendAt: string; scheduled: boolean };
export type Draft = {
  kind: DraftKind;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  sendAt?: string;
  referenceMessageId?: number;
};
/** A send that hasn't gone out yet. */
export type QueuedSend = { id: number; accountId: number; sendAt: string; draft: Draft };
export type Contact = { name: string | null; address: string };
export type Split = { name: string; query: string };
/** A tab of the split inbox. The first is the built-in Inbox (`builtin`): mail no split claims. */
export type SplitInfo = Split & { builtin: boolean; count: number; unread: number };
export type Attachment = { id: string; name: string; contentType: string; size: number };
export type OutboxStatus = { pending: number; failed: number; lastError: string | null };

export type CacheLimits = { cacheDays: number; bodyCacheMb: number };

export type Layout = "list" | "preview";
export type Preferences = {
  hideEmptySplits: boolean;
  showRightPane: boolean;
  rightPaneWidth: number;
  /** "list": Enter opens a conversation. "preview": list with a reading pane beside it. */
  layout: Layout;
  listWidth: number;
  /** What the right pane shows. */
  rightPaneTab: "recent" | "calendar";
  /** First day of the week: 0 = Sunday, 1 = Monday ... 6 = Saturday. */
  weekStartsOn: number;
  /** Seconds a sent message waits so it can be undone (0: at once). */
  undoSendSecs: number;
  /** New-mail notifications. */
  notify: "off" | "focused" | "all";
  /** Closing the window keeps PeetMail running in the tray. */
  closeToTray: boolean;
};

export type Attendee = { name: string | null; address: string | null; response: string | null; type: string | null };

export type CalendarEvent = {
  id: number;
  accountId: number;
  remoteId: string;
  subject: string;
  /** UTC ISO instant, or YYYY-MM-DD for all-day events. */
  startAt: string;
  /** Exclusive: UTC ISO instant, or YYYY-MM-DD for all-day events. */
  endAt: string;
  isAllDay: boolean;
  location: string | null;
  organizerName: string | null;
  organizerAddress: string | null;
  attendees: Attendee[];
  /** none | organizer | accepted | tentativelyAccepted | declined | notResponded */
  response: string | null;
  isOrganizer: boolean;
  isCancelled: boolean;
  showAs: string | null;
  joinUrl: string | null;
  webLink: string | null;
  preview: string;
  /** "Microsoft Teams", "Zoom", "Google Meet", "Webex" or "Online meeting" (with joinUrl). */
  joinProvider: string | null;
  /** singleInstance | occurrence | exception */
  eventType: string;
  /** The series an occurrence belongs to. */
  seriesMasterId: string | null;
};

/** What the event popup shows beyond the cached row; fetched when it opens. */
export type EventDetail = {
  bodyHtml: string;
  recurrence: Recurrence | null;
  seriesMasterId: string | null;
  isOccurrence: boolean;
  isException: boolean;
  /** null: no reminder (unless reminderDefault). */
  reminderMinutes: number | null;
  reminderDefault: boolean;
  sensitivity: string;
  categories: string[];
  importance: string;
  /** A join link found in the description (when the event has none). */
  joinUrl: string | null;
  joinProvider: string | null;
};

export type Bootstrap = {
  clientId: string | null;
  /** Google OAuth client ID, if configured. */
  googleClientId: string | null;
  accounts: Account[];
  cacheLimits: CacheLimits;
  preferences: Preferences;
};
export type Provider = "microsoft" | "google";

/** A conversation from the Recent Opens pane: its newest message, plus when it was opened. */
export type RecentOpen = ThreadRow & { openedAt: string };

export type Cursor = { sortAt: string; messageId: number };

export type SyncStatus = { state: "syncing" | "idle" | "error"; message: string | null };

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  setClientId: (clientId: string) => invoke<void>("set_client_id", { clientId }),
  signIn: (provider: Provider = "microsoft") => invoke<Account>("sign_in", { provider }),
  setGoogleClient: (clientId: string, clientSecret: string | null) => invoke<void>("set_google_client", { clientId, clientSecret }),
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  signOut: (accountId: number) => invoke<void>("sign_out", { accountId }),
  listFolders: (accountId: number) => invoke<Folder[]>("list_folders", { accountId }),
  /**
   * `folderId` null searches all mail. `split` picks a split-inbox tab (0 = Inbox) and wins over
   * `query`, which uses the query language (src-tauri/src/query.rs).
   */
  /** `hidden`: accounts toggled off in the footer legend. */
  listThreads: (folderId: number | null, query: string, split: number | null, cursor: Cursor | null, limit: number, hidden: number[] = []) =>
    invoke<ThreadRow[]>("list_threads", { folderId, query, split, cursor, limit, hidden }),
  getThread: (accountId: number, conversationId: string) =>
    invoke<MessageRow[]>("get_thread", { accountId, conversationId }),
  getMessageBody: (messageId: number) => invoke<string>("get_message_body", { messageId }),
  syncNow: () => invoke<void>("sync_now"),
  setCacheLimits: (limits: CacheLimits) => invoke<void>("set_cache_limits", { limits }),
  setPreferences: (preferences: Preferences) => invoke<void>("set_preferences", { preferences }),
  recordOpen: (accountId: number, conversationId: string) => invoke<void>("record_open", { accountId, conversationId }),
  recentOpens: (limit = 50) => invoke<RecentOpen[]>("recent_opens", { limit }),
  /** Timed events by UTC instants [from, to); all-day events by local dates [fromDate, toDate). */
  listEvents: (from: string, to: string, fromDate: string, toDate: string) =>
    invoke<CalendarEvent[]>("list_events", { from, to, fromDate, toDate }),
  inviteEvent: (messageId: number) => invoke<Invite | null>("invite_event", { messageId }),
  listRooms: (accountId: number) => invoke<RoomList>("list_rooms", { accountId }),
  /** Sign a known account in again in place (new tokens, optionally extra permissions); keeps its mail. */
  reconnectAccount: (accountId: number, addScopes?: string[]) => invoke<Account>("reconnect_account", { accountId, addScopes: addScopes ?? null }),
  createEvent: (accountId: number, event: NewEvent) => invoke<CalendarEvent>("create_event", { accountId, event }),
  eventDetail: (accountId: number, remoteId: string) => invoke<EventDetail>("event_detail", { accountId, remoteId }),
  eventForEdit: (accountId: number, remoteId: string, series: boolean) =>
    invoke<EditableEvent>("event_for_edit", { accountId, remoteId, series, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  updateEvent: (accountId: number, remoteId: string, changes: EventChanges) => invoke<void>("update_event", { accountId, remoteId, changes }),
  deleteCalendarEvent: (accountId: number, remoteId: string, cancel: boolean, comment: string | null) =>
    invoke<void>("delete_calendar_event", { accountId, remoteId, cancel, comment }),
  respondToEvent: (accountId: number, eventRemoteId: string, response: Rsvp, series = false) =>
    invoke<void>("respond_to_event", { accountId, eventRemoteId, response, series }),
  snoozeThread: (accountId: number, conversationId: string, until: string) =>
    invoke<ActionOutcome>("snooze_thread", { accountId, conversationId, until }),
  unsnoozeThread: (accountId: number, conversationId: string) => invoke<void>("unsnooze_thread", { accountId, conversationId }),
  listSnoozed: () => invoke<SnoozedThread[]>("list_snoozed"),
  listSnippets: () => invoke<Snippet[]>("list_snippets"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  quitApp: () => invoke<void>("quit_app"),
  /** Opens a link in the browser / mail app (recorded instead in tests). */
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  setSnippets: (snippets: Snippet[]) => invoke<Snippet[]>("set_snippets", { snippets }),
  threadAction: (accountId: number, conversationId: string, action: Action, undoable = true) =>
    invoke<ActionOutcome>("thread_action", { accountId, conversationId, action, undoable }),
  undo: () => invoke<string | null>("undo"),
  outboxStatus: () => invoke<OutboxStatus>("outbox_status"),
  sendMessage: (input: SendInput) => invoke<SendOutcome>("send_message", { input }),
  cancelSend: (id: number) => invoke<QueuedSend | null>("cancel_send", { id }),
  scheduledSends: () => invoke<QueuedSend[]>("scheduled_sends"),
  suggestContacts: (prefix: string) => invoke<Contact[]>("suggest_contacts", { prefix }),
  /** `folderId` null: the unified inbox (every signed-in account). */
  listSplits: (folderId: number | null, hidden: number[] = []) => invoke<SplitInfo[]>("list_splits", { folderId, hidden }),
  setSplits: (splits: Split[]) => invoke<void>("set_splits", { splits }),
  getMessageBodyWithImages: (messageId: number) => invoke<string>("get_message_body_with_images", { messageId }),
  listAttachments: (messageId: number) => invoke<Attachment[]>("list_attachments", { messageId }),
  downloadAttachment: (messageId: number, attachmentId: string, name: string) =>
    invoke<string>("download_attachment", { messageId, attachmentId, name }),
};

export const onMailChanged = (cb: (p: { accountId: number; folderId: number }) => void): Promise<UnlistenFn> =>
  listen<{ accountId: number; folderId: number }>("mail-changed", (e) => cb(e.payload));

export const onOutbox = (cb: (s: OutboxStatus) => void): Promise<UnlistenFn> =>
  listen<OutboxStatus>("outbox-changed", (e) => cb(e.payload));

export type Rsvp = "accept" | "tentative" | "decline";
/** A new event: timed ones as UTC ISO instants, all-day ones as YYYY-MM-DD (end exclusive). */
export type NewEvent = {
  subject: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  /** IANA zone the all-day dates belong to. */
  timeZone: string;
  /** A full event's other fields (the editor). */
  details?: EventChanges;
};

export type EventTimes = {
  /** Timed: UTC ISO instants. All-day: YYYY-MM-DD (end exclusive). */
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
};
export type EditAttendee = { name: string | null; address: string; optional: boolean; response?: string | null; /** A room being booked. */ resource?: boolean };
/** A meeting room of a Microsoft 365 tenant. */
export type Room = { name: string; address: string; capacity: number | null; building: string | null };
/** Rooms, or (when there are none) the permission that would list them. */
export type RoomList = { rooms: Room[]; needs: { scope: string; admin: boolean } | null };
/** What an edit changes; missing fields stay as they are. */
export type EventChanges = {
  subject?: string;
  times?: EventTimes;
  /** "" clears it. */
  location?: string;
  /** The room's mailbox when the location is a room. */
  locationEmail?: string;
  descriptionHtml?: string;
  attendees?: EditAttendee[];
  showAs?: string;
  reminder?: { minutes: number | null };
  sensitivity?: "normal" | "private";
  /** null stops it repeating. */
  recurrence?: Recurrence | null;
};
/** The event the editor works on (fresh from the server). */
export type EditableEvent = {
  remoteId: string;
  subject: string;
  times: EventTimes;
  location: string;
  locationEmail: string | null;
  descriptionHtml: string;
  attendees: EditAttendee[];
  showAs: string;
  reminderMinutes: number | null;
  reminderDefault: boolean;
  sensitivity: "normal" | "private";
  recurrence: Recurrence | null;
  isOrganizer: boolean;
  series: boolean;
};
/** The calendar event behind a meeting-invite message. */
export type Invite = {
  meetingMessageType: string | null;
  /** newMeetingRequest | fullUpdate | informationalUpdate | silentUpdate | outdated | ... */
  meetingRequestType: string | null;
  /** Where an updated meeting used to be (UTC instants / text). */
  previousStart: string | null;
  previousEnd: string | null;
  previousLocation: string | null;
  event: CalendarEvent;
};

export const onScheduledChanged = (cb: () => void): Promise<UnlistenFn> => listen("scheduled-changed", () => cb());

export const onCalendarChanged = (cb: () => void): Promise<UnlistenFn> => listen("calendar-changed", () => cb());

export const onSyncStatus = (cb: (s: SyncStatus) => void): Promise<UnlistenFn> =>
  listen<SyncStatus>("sync-status", (e) => cb(e.payload));
