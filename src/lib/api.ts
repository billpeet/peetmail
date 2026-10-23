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
};

export type CacheLimits = { cacheDays: number; bodyCacheMb: number };

export type Bootstrap = { clientId: string | null; accounts: Account[]; cacheLimits: CacheLimits };

export type Cursor = { receivedAt: string; messageId: number };

export type SyncStatus = { state: "syncing" | "idle" | "error"; message: string | null };

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  setClientId: (clientId: string) => invoke<void>("set_client_id", { clientId }),
  signIn: () => invoke<Account>("sign_in"),
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  signOut: (accountId: number) => invoke<void>("sign_out", { accountId }),
  listFolders: (accountId: number) => invoke<Folder[]>("list_folders", { accountId }),
  listThreads: (folderId: number, cursor: Cursor | null, limit: number) =>
    invoke<ThreadRow[]>("list_threads", { folderId, cursor, limit }),
  getThread: (accountId: number, conversationId: string) =>
    invoke<MessageRow[]>("get_thread", { accountId, conversationId }),
  getMessageBody: (messageId: number) => invoke<string>("get_message_body", { messageId }),
  syncNow: () => invoke<void>("sync_now"),
  setCacheLimits: (limits: CacheLimits) => invoke<void>("set_cache_limits", { limits }),
};

export const onMailChanged = (cb: (p: { accountId: number; folderId: number }) => void): Promise<UnlistenFn> =>
  listen<{ accountId: number; folderId: number }>("mail-changed", (e) => cb(e.payload));

export const onSyncStatus = (cb: (s: SyncStatus) => void): Promise<UnlistenFn> =>
  listen<SyncStatus>("sync-status", (e) => cb(e.payload));
