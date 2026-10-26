# PeetMail plan

A Superhuman-style mail and calendar client for Windows. Personal use, Microsoft 365 and Outlook.com first, Gmail later.

## Principles

1. **Fast.** No interaction waits on the network. Reads come from a local SQLite cache, writes are optimistic, and the next likely thread is already rendered.
2. **Minimal.** Every feature has to earn its place. When unsure, leave it out.
3. **Keyboard first.** Every action has a shortcut and shows up in the command palette. The mouse works but is never required.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Shell | Tauri 2 | Email bodies need a web engine anyway. Tauri gives WebView2 plus a Rust core, without the weight of Electron. |
| UI | SvelteKit SPA (adapter-static), Svelte 5 runes, Tailwind 4 | Fine-grained reactivity, small runtime, matches the usual stack. |
| Storage | SQLite via `rusqlite` in the Rust process | Sync, search and caching never cross IPC. Drizzle doesn't fit because the DB lives in Rust, not JS. |
| Providers | Microsoft Graph first, Gmail API second | M365 + Outlook.com are the daily drivers. |
| Auth | Entra public client, auth code + PKCE, loopback redirect | No client secret in the binary. Works for both work and personal accounts via the `common` authority. |
| Token storage | DPAPI-encrypted blob in SQLite | Credential Manager caps blobs at 2.5KB, and Microsoft refresh tokens can be bigger. |
| Message IDs | Graph immutable IDs (`Prefer: IdType="ImmutableId"`) | IDs survive folder moves, so archive and undo don't orphan cache rows. |
| Sync | Delta queries, polled every 60s | Graph push notifications need a public webhook. Delta polls cost one request per folder when nothing changed. |
| Platform | Windows only for now | Tauri keeps macOS open later at low cost. |
| IPC types | Hand-written TS types in `src/lib/api.ts` | Command count is small. Revisit `tauri-specta` once it passes ~25 commands. |

## Architecture

```
┌──────────────── Svelte UI (WebView2) ─────────────────┐
│ keymap registry · views · virtual list · body LRU     │
│ sandboxed iframe for message bodies                   │
└──────────── invoke() commands + emitted events ───────┘
┌──────────────────── Rust core ────────────────────────┐
│ auth.rs     PKCE sign-in, token refresh               │
│ graph.rs    Graph HTTP client, 429/503 backoff        │
│ mail.rs     delta sync, body fetch                    │
│ db.rs       SQLite schema, queries, cache eviction    │
│ sanitize.rs ammonia HTML cleaning                     │
│ secure.rs   DPAPI                                     │
│ state.rs    app state, settings, token cache          │
└───────────────────────────────────────────────────────┘
```

Events from Rust to UI:
- `mail-changed {accountId, folderId}` after each committed sync page. The UI debounces it and reloads what it has loaded.
- `sync-status {state, message}` drives the footer indicator.

### Data model

- `accounts` holds provider, email and the encrypted token blob.
- `folders` holds the Graph folder id, a role (inbox, sentitems, ...) and the delta link.
- `messages` holds metadata only. Threads are `conversation_id` groups.
- `messages_fts` is the FTS5 search index, kept in step by triggers; body text is added when a body is fetched.
- `outbox` holds queued Graph mutations (see `outbox.rs`).
- `message_bodies` holds sanitized HTML, with `size` and `accessed_at` for LRU eviction.
- `settings` is key/value.

Migrations are numbered SQL files in `src-tauri/migrations`, applied in order and tracked in `PRAGMA user_version`.

### Cache limits

Both are in settings (`Ctrl+,`):
- **Mail window** (default 90 days). The initial delta request filters on `receivedDateTime ge <cutoff>`. After each sync, messages older than the cutoff are pruned. Widening the window clears delta links and resyncs. If Graph rejects the filter, sync falls back to filtering locally.
- **Body cache** (default 500 MB). Bodies are fetched on demand and prefetched around the cursor. After each insert, the least recently read bodies are evicted until the total fits.

Metadata for 90 days of a busy inbox is a few MB, so it isn't capped separately.

### Rendering email safely

Three layers:
1. `ammonia` strips scripts, event handlers and `javascript:` URLs, and keeps layout markup and inline styles.
2. The body renders in an iframe with `sandbox="allow-same-origin"`, so no script inside it can run.
3. The srcdoc iframe inherits the app CSP. `img-src 'self' data:` blocks remote images and tracking pixels by default.

The parent page handles link clicks, opening them in the system browser, and forwards keydowns from the iframe so shortcuts keep working after you click into a message.

## Keyboard map

Implemented bindings are marked ✓; numbers are the phase that adds them. They follow Superhuman's defaults.

| Keys | Action | |
|---|---|---|
| `j` / `k`, `↓` / `↑` | Next / previous conversation | ✓ |
| `Enter` | Open conversation | ✓ |
| `Esc` | Back to list, close dialog | ✓ |
| `g g` / `G` | Top / bottom of list | ✓ |
| `g i` | Go to inbox | ✓ |
| `Ctrl+R` | Sync now | ✓ |
| `Ctrl+,` | Settings | ✓ |
| `?` | Shortcut overlay | ✓ |
| `Ctrl+K` | Command palette | ✓ |
| `e` | Archive (mark done) | ✓ |
| `#` | Delete | ✓ |
| `u` | Toggle read | ✓ |
| `s` | Flag | ✓ |
| `h` | Snooze: presets (later today, this evening, tomorrow, weekend, next week) or a typed time | ✓ |
| `g h` | Snoozed conversations (`Enter` read, `h` change time, `u` back now) | ✓ |
| `r` / `a` / `f` | Reply / reply all / forward | ✓ |
| `c` | Compose | ✓ |
| `/` | Search | ✓ |
| `Tab` / `Shift+Tab` | Next / previous split | ✓ |
| `z` | Undo last action (also takes back a send during its undo window) | ✓ |
| `Ctrl+Shift+Enter` | Send later, in the composer ("tomorrow 9am", "mon", "in 2 hours", or a preset) | ✓ |
| `;name`, `Ctrl+;` | Insert a snippet, in the composer | ✓ |
| `Ctrl+Q` | Quit (closing the window keeps PeetMail in the tray) | ✓ |
| `g s` | Scheduled messages (`Enter` edit, `#` cancel) | ✓ |
| `i` | Load remote images in the open conversation | ✓ |
| `\` | Show / hide the right pane (Recent Opens) | ✓ |
| `v` | Toggle the reading pane (list only, or list + preview) | ✓ |
| `g c` | Calendar (week view, first day set in Settings; ←/→ change week, `t` this week, Esc back) | ✓ |
| `1` / `2` | Mail / Calendar (also the left sidebar) | ✓ |
| `Shift+C` | New event (quick add: "lunch with Sam fri 1pm @ Café") | ✓ |
| `0` | Toggle calendar side panel | ✓ |

Every binding lives in one registry (`src/lib/keys.svelte.ts`) with an id, label, group and `when` condition. The shortcut overlay reads from it today, and the command palette will too.

## Phases

### Phase 0: skeleton (done)

- [x] Tauri 2 + SvelteKit + Tailwind 4 scaffold, CSP configured
- [x] Entra sign-in with PKCE over loopback, DPAPI token storage, silent refresh
- [x] SQLite schema and migrations
- [x] Inbox delta sync with date window, removal handling, 410 resync, throttling backoff
- [x] Background sync every 60s, `Ctrl+R` to sync now
- [x] Virtualized conversation list with keyset pagination
- [x] Thread reader with sanitized bodies in a sandboxed iframe
- [x] Body prefetch around the cursor, JS-side LRU over the SQLite body cache
- [x] Keymap registry with sequences (`g i`), shortcut overlay
- [x] Configurable cache limits
- [ ] First real sign-in and sync against your mailbox (needs your Entra app, see below)

### Phase 1: the core loop (done)

- [x] Outbox: archive, delete, read/unread and flag apply to SQLite first and queue a Graph op. Triage ops wait 2s before sending, so a quick undo never touches the server. Undo (`z`) cancels queued ops or queues the inverse. Retries with backoff; permanent failures show a toast and a "failed" count.
- [x] Sync leaves messages with queued ops alone, so a stale delta can't revert a local change.
- [x] Opening a conversation marks it read. Archive or delete in the reader moves on to the next conversation.
- [x] Compose, reply, reply all, forward (`c` `r` `a` `f`, `Ctrl+Enter` sends). Plain text in, HTML out. Replies and forwards go through Graph's `reply`/`replyAll`/`forward` so the original is quoted and threaded. Contact suggestions from people you've exchanged mail with.
- [x] One query language for search and splits: `from:` `to:` `subject:` `is:unread|read|flagged|focused|other|invite` `has:attachment`, `-` to negate, free words as prefixes, `"quoted phrases"`.
- [x] Search (`/`): SQLite FTS5 over subject, people, preview, and body text once a body has been fetched. Covers all cached folders except Deleted Items.
- [x] Split inboxes: named queries, `Tab`/`Shift+Tab` to cycle, unread counts on tabs, editable in Settings. A built-in Inbox tab comes first and holds whatever no split claims; each message lands in exactly one tab (first matching split wins). Default split: Other (`is:other`).
- [x] Command palette (`Ctrl+K`) over the keymap registry.
- [x] Sent Items synced, so threads include your replies. Archive and Deleted Items are local move targets only.
- [x] Load images (`i`): Rust fetches remote images (raster only, 5 MB cap) and inlines them as data URIs; the CSP stays strict.
- [x] Inline `cid:` images, attachment list, download to Downloads.

Deferred from Phase 1:
- Server search (`$search`) for mail outside the cache window.
- Syncing Archive and Drafts; a folder picker / move-to-folder.
- Markdown shortcuts in the composer.

### Phase 2: calendar

- Calendar sync via `/me/calendarView/delta`
- Day view side panel next to the inbox, plus a full calendar view (`g c`)
- RSVP to invites inline in the message
- Quick add in natural language ("lunch with Sam fri 1pm")

### Phase 3: polish

- [x] Snooze (`h`). The conversation moves to a hidden "PeetMail Snoozed" server folder (visible if the mailbox refuses hidden folders), so other clients stop showing it too. PeetMail wakes it on time (a 1s local check; on next start if it was closed): back to the inbox, newest message unread, sorted on top by its wake time (`messages.sort_at`) with a Reminder badge. Undoable. Not done: "remind me if nobody replies".
- [x] Undo send (delay window, 10s by default, set in Settings), scheduled send. Both wait in the local outbox, so a scheduled message only goes out while PeetMail is running (or as soon as it next starts). Server-side deferred delivery (`PR_DEFERRED_SEND_TIME`) would send with the PC off, but needs the draft-then-send flow; revisit if that matters.
- [x] Snippets: made in Settings (name + text); in the composer type `;name` or press `Ctrl+;`, pick with ↑/↓, Enter inserts. Placeholders `{first_name}` `{name}` (first recipient; guessed from the address when there's no name) and `{my_first_name}` `{my_name}`. Stored in settings as JSON.
- [x] Multiple accounts in one unified view. Settings > Accounts adds (the browser sign-in asks which account) and signs out accounts. The inbox, split tabs and counts span every signed-in account's inbox (`Scope::Inboxes`); search spans all mail. With two or more accounts each row gets an account-coloured dot, the composer a From picker (replies and forwards go from the account the mail came to), and `account:` (alias `in:`) filters by account in search and splits. Conversations never merge across accounts. Calendar already showed every account's events.
- [x] Windows notifications, start with Windows, tray icon. Toasts for new unread inbox mail (focused only by default; all or off in Settings), only while PeetMail isn't the active window; more than three at once become one summary; snoozes coming back raise a reminder. A per-account watermark on the local row id means the first sync, a backlog and mail older than a day never notify. Tray icon (click opens; menu: Open, Sync now, Quit); closing the window hides to the tray (setting); `Ctrl+Q` quits. Start with Windows (HKCU Run key via tauri-plugin-autostart) launches hidden with `--minimized`. Single instance outside tests: a second launch shows the running window. Clicking a toast doesn't open the conversation (the notification plugin has no click callback on Windows).
- Gmail provider behind the same provider interface

## Entra app registration

Because PeetMail is for personal use, you register your own Entra app. It takes about five minutes.

1. Open the [Entra admin center](https://entra.microsoft.com) and go to **App registrations → New registration**.
   - Name: `PeetMail`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   - Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`. On an existing app, this is **Authentication → Add a platform → Mobile and desktop applications → Custom redirect URIs**. Use exactly `http://localhost`, with no port or path, and don't also register it under Web or SPA.
2. Under **API permissions**, add these Microsoft Graph delegated permissions: `offline_access`, `openid`, `profile`, `email`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`. PeetMail requests them all at first sign-in, so later phases don't prompt again.
3. Copy the **Application (client) ID** from the Overview page and paste it into PeetMail's setup screen. You can also bake it in at build time with the env var `PEETMAIL_MS_CLIENT_ID`. To change it later, press `c` on the sign-in screen or open Settings (`Ctrl+,`). Changing it signs you out, because refresh tokens only work with the client ID that issued them. Cached mail is kept.

Things that can trip you up:
- If you sign in to Entra with only an outlook.com account, it may ask you to create a tenant first. A free tenant works.
- If your M365 tenant blocks user consent for third-party apps, an admin has to approve the app once.
- Entra accepts any port on a registered `http://localhost` redirect for desktop apps. PeetMail picks a random free port each time.
- `AADSTS7000218` (asks for a client secret) means the redirect is registered under Web. `AADSTS9002327` means it's registered under SPA. Move it to Mobile and desktop applications.
- If the client ID is wrong, the browser shows an error and never redirects back. Press `Esc` in PeetMail to cancel, then `c` to fix the ID.

## Risks and open questions

- **Delta and the date filter.** It's unverified whether Graph accepts a `receivedDateTime ge` filter on message delta for both M365 and Outlook.com accounts. If it returns 400, sync falls back to fetching everything and filtering locally, which is correct but slower on the first sync. Check the logs on first sync.
- **WebView2 memory.** Expect roughly 100 to 150 MB. Watch it as features land, and keep the DOM small (the virtual list, collapsed messages).
- **Single DB mutex.** Fine while queries take microseconds. If sync writes ever cause visible UI stalls, split into a writer connection and a read pool.
- **Calendar scope.** Outlook-style calendars get feature-heavy fast. Hold the line on minimal.
