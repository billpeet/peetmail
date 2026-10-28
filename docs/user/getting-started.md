# Getting started

PeetMail is a fast, keyboard-first mail and calendar app for Windows. It works with Microsoft 365, Outlook.com and Gmail, and puts all your accounts in one inbox.

## Install

1. Download `PeetMail_<version>_x64-setup.exe` from the [releases page](https://github.com/billpeet/peetmail/releases).
2. Run it. It installs for you only, without needing an administrator.
3. Windows may say **"Windows protected your PC"**, because the installer isn't signed yet. Choose **More info → Run anyway**.

PeetMail keeps itself up to date after that; see [Updates](updates.md).

## Sign in

Press **Enter** (or click **Sign in with Microsoft**) and finish signing in in your browser. Work, school and personal Microsoft accounts all work. For Gmail, choose **Sign in with Google**.

Google shows **"Google hasn't verified this app"**, because PeetMail is for a small group and hasn't been through Google's review: choose **Advanced → Go to PeetMail**. If your organisation blocks PeetMail's sign-in, see [Your own sign-in app](your-own-app.md).

Add more accounts under **Settings → Accounts** (**Ctrl+,**). They share one inbox; a coloured dot shows which account each message belongs to, and `account:work` in a search shows one account.

## Find your way around

Everything has a keyboard shortcut. The ones to start with:

| Keys | |
|---|---|
| **j** / **k** | Next / previous conversation |
| **Enter** / **Esc** | Open / back to the list |
| **e** | Archive (mark done) |
| **#** | Delete |
| **g i** / **g e** / **g t** | Inbox / Done / Sent |
| **g h** / **g s** | Snoozed / Scheduled |
| **g a** / **g #** | All mail / Trash |
| **r** / **a** / **f** | Reply / reply all / forward |
| **c** | Write a new message (**Ctrl+Enter** sends) |
| **z** | Undo, including a send for a few seconds |
| **/** | Search |
| **h** | Snooze until later |
| **2** / **1** | Calendar / mail |
| **Ctrl+K** | Every command, searchable |
| **?** | All keyboard shortcuts |

The mouse works too, everywhere.

The icons down the left side are your mailboxes: Inbox, Done (what you've archived), Sent, Snoozed, Scheduled, All mail and Trash, each covering all your accounts. In Done, **e** puts a conversation back in the inbox; in Trash, **#** restores it. Snoozed lists conversations by when they come back (**h** changes the time, **u** brings one back now), and Scheduled lists messages waiting to send (**Enter** edits one, **#** cancels it). Mail is kept for your mail window (**Settings → Storage**), so older mail isn't in these lists.

A reply or forward opens under the conversation you're reading, so the messages you're answering stay in view above it. The original message is quoted under your reply when it's sent. **Esc** puts the reply away (press it twice once you've typed something or attached a file).

Format as you write: **Ctrl+B**, **Ctrl+I** and **Ctrl+U** for bold, italic and underline, **Ctrl+K** to make a link, or the buttons at the bottom of the message. Markdown works as you type, too: `**bold**`, `*italic*`, a line starting with `- ` or `1. ` for a list, `> ` for a quote. Formatting pasted from documents and web pages is kept (pictures in it are left out; paste a picture on its own to attach it).

**Ctrl+Shift+C** and **Ctrl+Shift+B** add Cc and Bcc. People in Bcc get the message, but no one else sees their addresses.

To attach files, press **Ctrl+Shift+A** (or the paperclip) to pick them, drag them from Explorer onto the message, or paste them, a screenshot included. A message can carry up to 25 MB of attachments. A forward lists the original's attachments; remove any you don't want to pass on with its **×**.

## Your mail on this PC

PeetMail keeps recent mail on your PC, so it opens instantly and you can read it offline. How much it keeps is under **Settings → Storage**. Pictures in messages are blocked until you press **i**, so senders can't tell when you've read their mail. A message's attachments are listed under it: click one to save it to your Downloads folder, or double-click it to open it. PeetMail won't open files that can run programs (such as `.exe` or `.js`) with a double-click; save them instead, and only open them if you trust the sender.

Closing the window keeps PeetMail running in the tray, so you still get new-mail notifications. **Ctrl+Q** quits. **Settings → Notifications & startup** changes both, and can start PeetMail with Windows.
