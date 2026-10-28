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

Tell the person who gave you PeetMail what happened and when, and quote your **install ID** (**Settings → Privacy → Copy**). With crash reports on, the developers can then find what PeetMail recorded at the time.

PeetMail's own log is in `%LOCALAPPDATA%\com.peetsoftware.peetmail\logs`, if you're asked for it.
