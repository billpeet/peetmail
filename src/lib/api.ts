// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Keep these in sync by hand for now (tauri-specta codegen is a candidate for later).
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
};

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
};
export type Contact = { name: string | null; address: string };
export type Split = { name: string; query: string };
/** A tab of the split inbox. The first is the built-in Inbox (`builtin`): mail no split claims. */
export type SplitInfo = Split & { builtin: boolean; count: number; unread: number };
export type Attachment = { id: string; name: string; contentType: string; size: number };
export type OutboxStatus = { pending: number; failed: number; lastError: string | null };

export type CacheLimits = { cacheDays: number; bodyCacheMb: number };

export type Preferences = { hideEmptySplits: boolean };

export type Bootstrap = { clientId: string | null; accounts: Account[]; cacheLimits: CacheLimits; preferences: Preferences };

export type Cursor = { receivedAt: string; messageId: number };

export type SyncStatus = { state: "syncing" | "idle" | "error"; message: string | null };

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  setClientId: (clientId: string) => invoke<void>("set_client_id", { clientId }),
  signIn: () => invoke<Account>("sign_in"),
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  signOut: (accountId: number) => invoke<void>("sign_out", { accountId }),
  listFolders: (accountId: number) => invoke<Folder[]>("list_folders", { accountId }),
  /**
   * `folderId` null searches all mail. `split` picks a split-inbox tab (0 = Inbox) and wins over
   * `query`, which uses the query language (src-tauri/src/query.rs).
   */
  listThreads: (folderId: number | null, query: string, split: number | null, cursor: Cursor | null, limit: number) =>
    invoke<ThreadRow[]>("list_threads", { folderId, query, split, cursor, limit }),
  getThread: (accountId: number, conversationId: string) =>
    invoke<MessageRow[]>("get_thread", { accountId, conversationId }),
  getMessageBody: (messageId: number) => invoke<string>("get_message_body", { messageId }),
  syncNow: () => invoke<void>("sync_now"),
  setCacheLimits: (limits: CacheLimits) => invoke<void>("set_cache_limits", { limits }),
  setPreferences: (preferences: Preferences) => invoke<void>("set_preferences", { preferences }),
  threadAction: (accountId: number, conversationId: string, action: Action, undoable = true) =>
    invoke<ActionOutcome>("thread_action", { accountId, conversationId, action, undoable }),
  undo: () => invoke<string | null>("undo"),
  outboxStatus: () => invoke<OutboxStatus>("outbox_status"),
  sendMessage: (input: SendInput) => invoke<void>("send_message", { input }),
  suggestContacts: (prefix: string) => invoke<Contact[]>("suggest_contacts", { prefix }),
  listSplits: (folderId: number) => invoke<SplitInfo[]>("list_splits", { folderId }),
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

export const onSyncStatus = (cb: (s: SyncStatus) => void): Promise<UnlistenFn> =>
  listen<SyncStatus>("sync-status", (e) => cb(e.payload));
