# Privacy

## On your PC

PeetMail keeps a copy of your recent mail and calendar on your PC, so it's fast and works offline: message details, the bodies of messages you've opened or are likely to open, and your calendar. How much is under **Settings → Storage**. It's in `%APPDATA%\com.peetsoftware.peetmail`.

Your sign-ins are stored encrypted with Windows (DPAPI), so only your Windows account on this PC can use them. PeetMail never sees your password: you sign in on Microsoft's or Google's own page.

Uninstalling keeps your data unless you tick **Delete the application data** in the uninstaller.

## What it asks Microsoft and Google for

- **Microsoft**: read and change your mail, send mail as you, read and change your calendar, and your name and address. Room suggestions may ask to see your organisation's directory; your administrator can allow the room list.
- **Google**: read, label and send Gmail (it can't delete mail permanently), read and change calendar events, and your name and address.

PeetMail talks to Microsoft and Google directly. Your mail never passes through anyone else's servers.

## What it sends to help fix problems

Both are on unless you turn them off under **Settings → Privacy**.

- **Crash reports** go to the developers when PeetMail crashes or hits an error: what went wrong, where in PeetMail's code, the version, and the last few lines of PeetMail's own log.
- **Usage and performance data**: how long things take and how often they fail. For example how long a sync, a search or a keyboard shortcut took, whether a request to Microsoft failed, and how much memory PeetMail uses.

What's **never** included: your mail, its subjects, the people you write to or hear from, your name and address, what you search for, and your passwords or sign-in tokens. PeetMail removes anything like an address, name or token from error messages before sending, and searches are reported only as "two words and one filter".

Reports carry an **install ID**: a random number made when PeetMail was installed, which says which install a report came from but not who you are. It's under **Settings → Privacy**; quote it if you report a problem, so the developers can find your reports.

Turning crash reports off stops them straight away. Turning usage data off stops it straight away; turning it back on takes effect the next time PeetMail starts.
