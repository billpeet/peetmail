# Troubleshooting

## Signing in

- **"Need admin approval"** or an `AADSTS` error mentioning consent: your organisation only allows apps an administrator has approved. Ask your IT team to approve PeetMail, or [use your own sign-in app](your-own-app.md).
- **"Google hasn't verified this app"**: expected. Choose **Advanced → Go to PeetMail**.
- **"Access blocked"** from Google: your Google Workspace administrator blocks unapproved apps. Ask them, or use your own Google app.
- **The browser shows an error and never comes back to PeetMail**: press **Esc** in PeetMail to cancel and try again.
- **An account shows "signed out"** or keeps failing: **Settings → Accounts → Sign in again** (or **Reconnect**). It keeps the account's mail and settings.

## Mail and calendar

- **"Sync error"** in the bottom bar: hover over it for the reason. **Ctrl+R** syncs again. A lost connection fixes itself once you're back online; anything you did offline goes out then.
- **Older mail is missing**: PeetMail keeps a set number of days on your PC (90 to start with). Search covers that; widen it under **Settings → Storage**.
- **No notifications**: PeetMail only notifies while it isn't the window you're using, and Windows' Do not disturb hides them. Check **Settings → Notifications & startup**.
- **Pictures in a message don't show**: they're blocked until you press **i**.

## PeetMail itself

- **It says it can't start because its data is from a newer version**: you've gone back to an older PeetMail. Install the latest from the [releases page](https://github.com/billpeet/peetmail/releases).
- **"Windows protected your PC"** when installing: choose **More info → Run anyway**. The installer isn't signed yet.
- **An update won't install**: **Settings → Updates → Check now** shows what went wrong. Installing the latest from the releases page over the top always works and keeps your data.

## Reporting a problem

Open **Help → Report a problem** (or **Report a problem** in the command palette, **Ctrl+K**). Say what happened and what you expected, and press **Send**. It goes straight to the developers, with your version and install ID; add your email if you'd like a reply. Leave **Include diagnostics** ticked unless you'd rather not: it adds the file described below.

Prefer email? **Write an email** on the same page starts one, addressed to the developers, with your version and install ID filled in.

### Diagnostics

**Export** under Diagnostics saves `PeetMail-diagnostics-….zip` to your Downloads folder. It has PeetMail's and Windows' versions, your settings (not the text of splits or snippets, and no passwords or tokens), how big the database is and whether it's healthy, which kinds of account you use (not their addresses), what's waiting to be sent, and PeetMail's recent logs with addresses, names and IDs removed. It has no mail, subjects or contacts. Open it and look if you like; it's plain text.

PeetMail's own log is in `%LOCALAPPDATA%\com.peetsoftware.peetmail\logs`, if you're asked for it.
