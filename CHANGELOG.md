# What's new in PeetMail

Changes you can see, newest first. PeetMail shows the lines you haven't seen after it updates, and the whole list under Help.

<!--
For whoever changes the app: every change a user can notice adds one line under
"## Unreleased" in the same commit. Write what changed for them, not how ("Ctrl+Enter
sends even while address suggestions show", not "fix keydown handler"). One line per
change; Markdown is fine (`code`, **bold**, links). `pnpm version:set <version>` turns
Unreleased into that version's section when cutting a stable release.
-->

## Unreleased

- Double-click an attachment to open it in its app. A single click still saves it to Downloads. Files that can run programs (`.exe`, `.js` and the like) aren't opened this way.
- Attach files to new messages, replies and forwards: **Ctrl+Shift+A** or the paperclip picks them, or drag them onto the message, or paste them (screenshots too). Forwards list the original's attachments, and you can remove any you don't want to send on.
- Changes to a recurring meeting and to one of its occurrences (accept the series, then decline one day) reach the server in the order you made them, even when the connection drops in between.
- Deleting an event you've only just created, while it's still being saved, now deletes it, instead of it coming back a moment later.
- In the event editor, room and guest suggestions no longer close under you when you click back into the field straight after removing a room or guest.
- A message whose send hits a brief network hiccup goes out a second later, instead of waiting up to a minute. Quick changes to one message (flag, then unflag) still reach the server in the order you made them when a connection drops.
- Snoozed (**g h**) and Scheduled (**g s**) open as lists in the main window instead of pop-ups. In Snoozed, **e** and **#** archive and delete too.
- The left sidebar lists your mailboxes: Inbox, Done, Sent, Snoozed, Scheduled, All mail and Trash, across all your accounts. **g e**, **g t**, **g a** and **g #** open Done, Sent, All mail and Trash. In Done, **e** puts a conversation back in the inbox; in Trash, **#** restores it.
- Search no longer shows mail from accounts you've signed out of.
- Mail you archive or delete anywhere (Outlook, Gmail, your phone) is now kept in PeetMail too, within your mail window: search finds archived mail and conversations show it. The first sync after updating takes a little longer while it fetches.
- Replies and forwards open under the conversation you're reading, like Outlook, so the earlier messages stay in view while you write. New messages still open on their own.
- PeetMail warns you, with what to do, when your disk is nearly full, your PC's clock is wrong, it can't save to its folder, WebView2 is out of date, or its mail cache looks damaged after an update.
- **Help → Report a problem**: send feedback to the developers from PeetMail (with diagnostics if you like), write an email instead, or save a diagnostics file with no personal details in it.
- **Help** (**F1**): getting started, updates, privacy, troubleshooting and every keyboard shortcut, built into PeetMail.
- Keyboard shortcut lists show arrow keys as arrows (← →) and Page Up/Down as PgUp/PgDn.
- Settings is organised into pages (Accounts, Mail, Calendar, Notifications, Storage, Updates, Privacy) with a sidebar. **Ctrl+PageUp** and **Ctrl+PageDown** move between them, and **Ctrl+,** opens the one you used last.
- After an update, **What's new** shows what changed since you last looked. The full list is in the command palette (What's new) and under Settings → Updates.
- PeetMail has its own icon: a **P** whose bowl is a key with an envelope on it, in the taskbar, Start menu, tray and title bar.
- Sign in with **Microsoft** or **Google** straight away, with no app registration to set up. Using your own sign-in app is still possible under Settings → Advanced.
- PeetMail updates itself. A new version downloads in the background; **Ctrl+Shift+U** (or the footer) restarts into it. Choose Stable or Canary under Settings → Updates.
- Crash reports and usage data help find and fix problems. Mail, addresses, names and search words are never included; turn either off under Settings → Privacy.
- **Ctrl+Enter** sends even while address suggestions are showing.
- Events can repeat: set a schedule when creating an event, and edit or end a series.
- Create and edit events in full (attendees, location, description, online meeting), and delete or cancel them.
- Room suggestions when choosing a location for a Microsoft 365 event.
- Join links are found in an event's location or description too, with a **Join** button on the calendar.
- Quick add and the event editor work from the keyboard: Tab moves through the fields without stopping on the formatting buttons.
