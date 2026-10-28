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
| `g e` / `g t` / `g a` / `g #` | Done / Sent / All mail / Trash (`e` in Done and `#` in Trash: back to the inbox) | ✓ |
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
| `e` / `#` | In an event's details: edit / delete (a recurring event asks: this occurrence `o` or the series `s`) | ✓ |
| `Tab` | In quick add: open the full event editor (guests, location, description) | ✓ |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | In quick add: next / previous calendar | ✓ |
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
- [x] Sent Items synced, so threads include your replies. Archive and Deleted Items synced too since the Folders work (below).
- [x] Load images (`i`): Rust fetches remote images (raster only, 5 MB cap) and inlines them as data URIs; the CSP stays strict.
- [x] Inline `cid:` images, attachment list, download to Downloads.

Deferred from Phase 1:
- Server search (`$search`) for mail outside the cache window.
- Syncing Drafts; a folder picker / move-to-folder.
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
- Gmail provider (in progress, branch `gmail`):
  - [x] Slice 1: Google sign-in (PKCE, loopback, optional client secret), Gmail sync (inbox + sent in the cache window, then the History API; a full resync when history has expired), labels mapped to folders (TRASH, our snooze label, INBOX, SENT, else archive; promotions/social/updates/forums are Other), bodies and attachments from the MIME tree (inline cid images, charsets), triage as label changes (archive, read, star, trash, snooze to a hidden `PeetMail/Snoozed` label, undo).
  - [x] Slice 2: send, reply, reply all, forward. PeetMail builds the RFC 2822 message (encoded headers, plain text + HTML, multipart/related for the quoted original's inline images, multipart/mixed for forwarded attachments); replies carry In-Reply-To/References and Gmail's threadId, forwards start a new thread; messages over 4 MB go through the upload endpoint. Undo send and scheduled send work as for Microsoft (same outbox).
  - [x] Slice 3: Google Calendar (primary calendar). Windowed first sync with singleEvents=true, then the nextSyncToken (410: full resync); recurring masters stored but not listed, instances shown. RSVP patches your attendee entry with sendUpdates=all; quick add creates events through the outbox; Gmail invitations get the RSVP card via the UID in their text/calendar part (looked up with iCalUID, cached per message in `message_invites`). Accounts that signed in before calendar access was requested get a "sign in again" message.

## Your own Entra or Google app

Release builds sign in with PeetMail's own apps. Registering your own (for local builds, which have none built in, or when an organisation blocks PeetMail's) is described for users in [docs/user/your-own-app.md](user/your-own-app.md), which the app also shows under Help.

## Risks and open questions

- **Delta and the date filter.** It's unverified whether Graph accepts a `receivedDateTime ge` filter on message delta for both M365 and Outlook.com accounts. If it returns 400, sync falls back to fetching everything and filtering locally, which is correct but slower on the first sync. Check the logs on first sync.
- **WebView2 memory.** Expect roughly 100 to 150 MB. Watch it as features land, and keep the DOM small (the virtual list, collapsed messages).
- **Single DB mutex.** Fine while queries take microseconds. If sync writes ever cause visible UI stalls, split into a writer connection and a read pool.
- **Calendar scope.** Outlook-style calendars get feature-heavy fast. Hold the line on minimal.

## Event details and editing (after Phase 3)

- [x] Details popup: description (sanitized, in a sandboxed frame that never scrolls itself), repeat pattern in words, a banner on occurrences, calendar, location, join link (also found in the location or description: Teams, Zoom, Meet, Webex...), show-as, reminder, private, categories, organiser and guests grouped by answer (collapsed past 5), RSVP with this-occurrence/series scope. Join buttons on calendar blocks.
- [x] Editor (create and edit): title, calendar, all day, start/end (length kept when the start moves), location, guests with suggestions, show-as, reminder, private, rich-text description (Tiptap). Only changed fields are sent (Graph PATCH / Google PATCH with sendUpdates=all). Recurring events: edit this occurrence or the whole series (the master), shown in a banner. Guests can change only their show-as and reminder. Delete: your own event, cancel a meeting you organise (guests told, optional message), or remove an invitation from your calendar; occurrence or series.
- [x] Rooms (Microsoft 365): the location suggests the tenant's rooms (beta `/me/findRooms`, which needs only User.Read; v1.0 Places needs admin-consented Place.Read.All and is only a fallback). Picking one sets the location (`locationType: conferenceRoom` + its mailbox) and invites the room as a `resource` guest, which books it; choosing another swaps it, and typing over the location or removing the room chip un-books it. Personal accounts and Google calendars get no suggestions. Cached per account for 6 hours. Some tenants refuse findRooms with plain User.Read (403 Access is denied): the editor then offers to grant User.ReadBasic.All (user-consentable) by reconnecting the account, and if that's still refused, Place.Read.All (admin approval) for the Places API. Each account stores the scopes it signed in with (`TokenSet.scopes`), because Entra re-asks for them on every refresh and fails on any never granted. A refused lookup logs the token's `scp` claim.
- [x] Reconnect (Settings > Accounts, and the room prompt): signs a known account in again in place (login_hint, same-account check), keeping its mail and settings; also the way back for a signed-out account.
- [x] Repeat editor: presets from the start date (daily, weekdays, weekly, monthly on the nth/last weekday or the date, yearly) that follow it when it moves, or custom (every N days/weeks/months/years, weekdays, monthly mode), ending never / on a date / after N times. Editable when creating, on your own single events (which become series) and on whole series (stopping one warns that the other occurrences go); read-only on one occurrence and as a guest. A series is sent in local wall-clock time with its IANA zone (`Times.local_start`), so it keeps its time across daylight saving; single events stay in UTC.


## Folders (after Phase 3)

Views of the well-known folders, unified across accounts like the inbox (and filtered by the footer account toggles). Custom Outlook folders and Gmail labels are out of scope for now; their mail is still in All mail and search.

| View | Keys | Holds |
|---|---|---|
| Inbox | `g i` | As now, with splits (splits only ever apply to the inbox) |
| Done | `g e` | Archive (Gmail: no INBOX/SENT/TRASH/SPAM label) |
| Sent | `g t` | Sent Items |
| Snoozed | `g h` | Snoozed, each row with its "back at" time |
| Scheduled | `g s` | Waiting sends (outbox rows, not cached messages); `Enter` edits in the composer, `#` cancels |
| All mail | `g a` | Every cached folder except Trash, Done included |
| Trash | `g #` | Deleted Items |

Slices:

1. [x] **Sync Archive and Deleted Items** in the mail window. Microsoft: add both to `SYNCED_FOLDERS` (one more delta request per folder per account per minute when idle). Gmail: an initial `-in:inbox -in:sent -in:trash -in:spam after:` listing plus `TRASH`, and drop `only_known_archive` so History label changes fill Done in. Prune by the window like the inbox. First syncs after the update take longer (a busy archive is thousands of messages); notifications stay inbox-only, so none fire. Archive is optional on Microsoft (a 404 skips it); `wk:` placeholder folders from earlier local moves get their real id in place. Gmail accounts synced before this list archive and trash once (`gmail_all_folders:<id>`).
2. [x] **Scope by role.** `db::Mailbox` (inbox, done, sent, snoozed, all, trash) maps to a `Scope`: `Role(role)` over signed-in accounts, `Done` (archived conversations with nothing in the inbox or snoozed, so a reply arriving in a done conversation moves it back), `AllMail` (signed-in accounts, excluding Trash; search uses it too). `list_threads` takes `mailbox`; `get_thread` takes `withTrash` for the Trash view's reader.
3. [x] **UI.** `mail.mailbox` beside `mail.view`; the Rail gains Inbox, Done, Sent, Snoozed, Scheduled, All mail, Trash (icons, tooltips with keys, unread dot on Inbox); split tabs only in the Inbox, a folder title elsewhere; `g` bindings in the keymap registry. Triage follows the folder: in Done `e` is "not done" (back to the inbox, undoable); in Trash `#` restores to the inbox; in Sent and All mail `e`/`#` act on the conversation's inbox messages as now.
4. **Snoozed and Scheduled become list views**, replacing their dialogs (`h` change time and `u` back now keep working in Snoozed).
5. Fake Graph/Gmail serve an archive and trash; E2E for each view and its triage; help page shortcut table; changelog.
