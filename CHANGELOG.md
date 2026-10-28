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
