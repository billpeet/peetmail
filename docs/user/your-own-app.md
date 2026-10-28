# Your own sign-in app

PeetMail signs in with its own Microsoft and Google apps, so most people never need this. It's for when your organisation blocks PeetMail's app, or for a PeetMail you've built yourself (which has none built in).

You register an app with Microsoft or Google, give PeetMail its ID, and add your accounts with it: on the sign-in screen ("Use your own app") or under **Settings → Advanced** ("Sign-in apps" in builds without built-in apps). Accounts keep the app they signed in with, so you can have some accounts on PeetMail's app and some on yours. Changing your app's ID later signs out only the accounts that use it; their mail is kept.

## Microsoft (Entra)

About five minutes.

1. Open the [Entra admin center](https://entra.microsoft.com) and go to **App registrations → New registration**.
   - Name: `PeetMail`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (or only your organisation, if that's all you need)
   - Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`. On an existing app this is **Authentication → Add a platform → Mobile and desktop applications → Custom redirect URIs**. Use exactly `http://localhost`, with no port or path, and don't also register it under Web or SPA.
2. Under **API permissions**, add these Microsoft Graph delegated permissions: `offline_access`, `openid`, `profile`, `email`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`. Optionally `User.ReadBasic.All` (room suggestions in some organisations).
3. Copy the **Application (client) ID** from the Overview page into PeetMail.

Things that can trip you up:

- If you only have an Outlook.com account, Entra may ask you to create a tenant first. A free one works.
- If your organisation blocks user consent, an administrator has to approve the app once (**Grant admin consent**).
- `AADSTS7000218` (asks for a client secret) means the redirect is registered under Web; `AADSTS9002327` means under SPA. Move it to Mobile and desktop applications.
- If the ID is wrong, the browser shows an error and never comes back. Press **Esc** in PeetMail to cancel, then fix the ID.

## Google

1. In the [Google Cloud console](https://console.cloud.google.com), create a project (for example `PeetMail`).
2. **APIs & Services → Library**: enable the **Gmail API** and the **Google Calendar API**.
3. **Google Auth Platform** (the consent screen): give it a name and your email under Branding; under Audience choose **External** (or **Internal** for Google Workspace accounts only); under Data Access add the scopes `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/calendar.events`.
4. **Publish the app** (Audience → Publish app → In production). Leave it unverified. While an app is in Testing, Google ends its sign-ins after 7 days and only lets listed test users in.
5. **Clients → Create client → Desktop app**. Copy the Client ID and Client secret into PeetMail. A desktop app's secret isn't confidential (Google says so); it stays on your PC.

When you sign in, Google shows "Google hasn't verified this app": choose **Advanced → Go to PeetMail**. If sign-in starts failing with `invalid_grant` after about a week, the app is still in Testing.
