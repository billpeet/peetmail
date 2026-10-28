# Releasing PeetMail

PeetMail ships on two update channels, both built by `.github/workflows/release.yml` after the full CI passes:

| Channel | Built from | Version | Published |
|---|---|---|---|
| **Canary** | every push to `master` | `<next patch>-canary.<run>`, e.g. `0.2.1-canary.57` | at once, as pre-release `canary-v<version>` |
| **Stable** | a tag `v<version>` | the version in `package.json` | as a draft; you publish it |

Installed apps check their channel every few hours (and a minute after starting), download a newer build in the background, verify its signature, and offer "restart to update" in the footer (`Ctrl+Shift+U`). Users pick the channel in Settings → Updates. A build starts on the channel it was built for, so someone who installs a canary build stays on canary.

Canary versions sort between stable releases: after `0.2.0` comes `0.2.1-canary.N`, and those are older than `0.2.1`. Moving from Canary to Stable therefore takes effect at the next stable release; nobody is downgraded.

## One-time setup

1. Push the repo to GitHub (public, MIT). Under **Settings → Actions → General → Workflow permissions**, the default (read) is fine: the release job asks for `contents: write` itself.
2. Add these under **Settings → Secrets and variables → Actions**:

| Secret | What | Required |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater private key file (see below) | Yes. Every build signs its installer |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password | Yes |
| `PEETMAIL_MS_CLIENT_ID` | Application (client) ID of the built-in Entra app (`04e0699b-…`, the `PeetMail` registration in `metroid.net.au`) | No. Without it the app asks for a client ID |
| `PEETMAIL_GOOGLE_CLIENT_ID` | Client ID of the built-in Google "Desktop app" OAuth client | No |
| `PEETMAIL_GOOGLE_CLIENT_SECRET` | Its client secret (not confidential for desktop clients, but keep it out of the repo) | No |

| `SENTRY_AUTH_TOKEN` | Sentry org auth token with release and project write access, for uploading symbols and source maps | No. Without it uploads are skipped with a warning, and stack traces in Sentry stay unreadable for that build |

And these **variables** (Settings → Secrets and variables → Actions → Variables), which aren't secret:

| Variable | What |
|---|---|
| `PEETMAIL_SENTRY_DSN` | The Sentry project's DSN, compiled into release builds. Unset: no crash reports |
| `PEETMAIL_FEEDBACK_EMAIL` | Where Help → Report a problem's "Write an email" goes. Unset: the option is hidden |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Where uploads go. Default `metroid` / `peetmail` |
| `PEETMAIL_OTLP_ENDPOINT` | The OTLP/HTTP gateway's base URL (the app adds `/v1/traces` etc.). Unset: no usage telemetry |

And for telemetry, one more secret: `PEETMAIL_OTLP_HEADERS`, the gateway's auth header(s) as `key=value,key=value` (e.g. `Authorization=Basic …`). It's compiled into the app, so use a write-only token that's PeetMail's own.

The gateway is `https://otlp.biap.cc`: Traefik basic auth in front of Alloy's OTLP receiver, in the `futura-observability` compose app in Dokploy on futura. PeetMail's user is `peetmail`, appended to the `traefik.http.middlewares.futura-otlp-auth.basicauth.users` label after the env-provided `polycode` user (the env is encrypted by Dokploy; the compose is not). To rotate: generate a new password, `htpasswd -nBi -C 12 peetmail` on futura, replace the `peetmail:` entry in that label in Dokploy's compose (dollars doubled), redeploy, and `gh secret set PEETMAIL_OTLP_HEADERS` with `Authorization=Basic <base64 of peetmail:password>`. Installed copies keep the credential they were built with, so add the new entry (e.g. user `peetmail2`) alongside the old one, release, and remove the old entry once installs have updated; removing it straight away cuts their telemetry off. If the credential leaks, remove it at once regardless.

### The updater signing key

The public half is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); every installed copy only accepts updates signed by the private half. The private key and its password live in the GitHub secrets and in the password manager, nowhere else. If both were lost, no installed copy could update again. Rotation, and every other credential: [docs/SECRETS.md](SECRETS.md).

## Canary

Merge or push to `master`. When the **Release** workflow finishes:

- a pre-release `canary-v0.2.1-canary.57` holds the installer, its `.sig`, the symbols zip, `latest.json` and `SHA256SUMS.txt`;
- the fixed pre-release `canary` has its `latest.json` replaced to point at that build. That file is what the Canary channel reads;
- canary builds beyond the newest 10 are deleted with their tags.

Nothing is committed: the canary version only exists in the build.

## Stable

### Is the canary ready?

A stable release is a canary build that has proved itself. Promote the commit when all of these hold:

- [ ] **Soaked**: it (or a canary with the same changes) has been on the Canary channel for **at least two days**, used daily by you and at least one other tester. A schema migration or a sign-in or sync change wants a week.
- [ ] **No new crashes**: Sentry (`metroid/peetmail`) has no unresolved issues first seen on canary in that time: search `is:unresolved environment:canary age:-7d`. Anything there is fixed, or understood and judged harmless and resolved with a note.
- [ ] **No unanswered feedback**: Sentry's **User Feedback** has nothing from canary testers still waiting on a fix meant for this release.
- [ ] **Telemetry looks normal** in Grafana against the last stable week (metric names as sent; Prometheus shows dots as underscores and adds `_total` to counters):
  - `http.request.duration` by `http.response.status_code`: no new run of 4xx/5xx for any `url.template`.
  - `peetmail.update.checks` with `peetmail.outcome="error"`: near zero; and canary installs moved to the new build (the release's `service.version` shows up in fresh data).
  - `peetmail.health.issues` by `peetmail.health.check`: no new `db_integrity`, and nothing out of line for the rest.
  - `app.startup.duration`: no step up.
- [ ] **Updates work**: at least one canary install updated itself to this build ("Restart to update" in the footer) and came back signed in with its mail.
- [ ] **Migrations** (if `src-tauri/migrations/` changed since the last tag, `git diff --stat v<last>.. -- src-tauri/migrations`): install the last stable release in Windows Sandbox, sign in and sync, then install this build over it. No "mail cache may be damaged" warning, and `peetmail.db.v<n>.bak` sits next to the database.
- [ ] **Changelog**: every line under `## Unreleased` is true of this build, written for users, and nothing a user would notice is missing. Compare against `git log --oneline v<last>..`.
- [ ] **Help**: `docs/user/` still describes what the app does (open Help in the canary and skim anything the changelog touches).

Then:

1. Check `CHANGELOG.md`: everything users will notice is under `## Unreleased`, worded for them. Then set the version everywhere:
   ```sh
   pnpm version:set 0.2.0
   git commit -am "Release 0.2.0"
   git push
   ```
   For a release (not a canary), this also turns the Unreleased lines into `## 0.2.0 — <date>`. That section becomes the GitHub release notes; a tag without one fails.
   This push also builds a canary (`0.2.1-canary.N`), which is expected.
2. Tag and push the tag:
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
   The workflow fails early if the tag doesn't match `package.json`.
3. When it finishes, the summary links a **draft** release with the installer, `.sig`, symbols, `latest.json` and checksums. Its notes are the version's changelog section, followed by GitHub's list of commits since the last tag.
4. Smoke-test the installer (below), edit the notes if you like, and click **Publish release**. Publishing makes it the repo's latest release, which is where the Stable channel reads `releases/latest/download/latest.json`. Within a few hours every stable install offers it.

A tag with a pre-release suffix (`v0.3.0-beta.1`) is drafted as a GitHub pre-release. It's never "latest", so the Stable channel ignores it; share its installer link directly.

If the build fails, fix it, then re-run the workflow, or move the tag to the fixed commit (`git tag -f v0.2.0 && git push -f origin v0.2.0`). A re-run against an existing draft replaces its assets. A published release is never rebuilt: bump the version.

### Pulling a bad release

- **Stable:** edit the previous release and tick "Set as the latest release" (or delete the bad one). The feed then serves the previous release again. Copies that already updated stay on the bad version until a newer release ships, so fix forward with a patch release.
- **Canary:** push a fix (or a revert). The next canary replaces it within one CI run.

## Smoke test

Windows Sandbox (built into Windows 11 Pro: *Turn Windows features on or off → Windows Sandbox*) gives a clean machine in seconds.

- [ ] The installer runs without admin rights. The build is unsigned, so SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**.
- [ ] PeetMail starts. Sign in with a Microsoft account and with a Google account, and the first sync completes.
- [ ] Open, archive and undo a conversation; send a message to yourself.
- [ ] Settings → Updates shows the right version and channel.
- [ ] Update from the previous release: install the previous version, check for updates, restart to update. PeetMail closes, the installer runs without asking, the new version starts, and mail and sign-ins are intact.
- [ ] No warning banners at the top of the window on a healthy machine.
- [ ] Help (**F1**) opens; What's new lists this version's changes.
- [ ] Help → Report a problem: **Send** reaches Sentry's User Feedback with the diagnostics attached, **Write an email** is addressed to the feedback address, and **Export** saves a zip with no addresses or subjects in it.
- [ ] Close to tray, reopen from the tray, quit with `Ctrl+Q`.
- [ ] Uninstall from *Settings → Apps*. Data in `%APPDATA%\com.peetsoftware.peetmail` stays unless you tick the option to delete app data.
