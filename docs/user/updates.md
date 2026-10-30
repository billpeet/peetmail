# Updates

PeetMail checks for a new version a minute after it starts and every few hours after that. When there is one, it downloads it in the background and checks that it really comes from PeetMail.

When it's ready, the bottom bar says **"… is ready · restart to update"**. Click it, or press **Ctrl+Shift+U**, and PeetMail closes, installs the update without asking anything, and opens again. On Linux the new version replaces your AppImage file where it is, so keep the file somewhere you can write to (your home folder is fine). Your mail and sign-ins stay as they are. It won't restart while you have a message open in the composer or one is still sending.

After an update, **What's new** shows what changed since you last looked. The whole list is in the command palette (**Ctrl+K** → What's new) and under **Settings → Updates**.

## Stable and Canary

Under **Settings → Updates** you choose which versions you get:

- **Stable**: releases that have been tried on Canary first.
- **Canary**: every change as soon as it's built, often several a day. You see new things first, and you may also see new problems first.

Moving from Canary back to Stable happens at the next Stable release (PeetMail never goes back to an older version).

**Check now** looks for an update straight away.

## On Linux

PeetMail updates itself when you run it as the AppImage from the releases page. A copy built from source, or packaged by someone else, says **"PeetMail updates itself only when run as an AppImage"** under **Settings → Updates**; update that copy the way you installed it.
