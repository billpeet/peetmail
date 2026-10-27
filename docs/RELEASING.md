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
| `PEETMAIL_MS_CLIENT_ID` | Application (client) ID of the built-in Entra app | No. Without it the app asks for a client ID |
| `PEETMAIL_GOOGLE_CLIENT_ID` | Client ID of the built-in Google "Desktop app" OAuth client | No |
| `PEETMAIL_GOOGLE_CLIENT_SECRET` | Its client secret (not confidential for desktop clients, but keep it out of the repo) | No |

| `SENTRY_AUTH_TOKEN` | Sentry org auth token with release and project write access, for uploading symbols and source maps | No. Without it uploads are skipped with a warning, and stack traces in Sentry stay unreadable for that build |

And these **variables** (Settings → Secrets and variables → Actions → Variables), which aren't secret:

| Variable | What |
|---|---|
| `PEETMAIL_SENTRY_DSN` | The Sentry project's DSN, compiled into release builds. Unset: no crash reports |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Where uploads go. Default `metroid` / `peetmail` |
| `PEETMAIL_OTLP_ENDPOINT` | The OTLP/HTTP gateway's base URL (the app adds `/v1/traces` etc.). Unset: no usage telemetry |

And for telemetry, one more secret: `PEETMAIL_OTLP_HEADERS`, the gateway's auth header(s) as `key=value,key=value` (e.g. `Authorization=Basic …`). It's compiled into the app, so use a write-only token that's PeetMail's own.

### The updater signing key

The public half is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); every installed copy only accepts updates signed by the private half. The key was generated with:

```sh
pnpm tauri signer generate -w %USERPROFILE%\.peetmail-release\updater.key -p <password>
```

**Keep the private key and password in a password manager as well as in GitHub.** GitHub secrets can't be read back. If the key is lost, no installed copy can ever update again; everyone would have to reinstall by hand. If it leaks, someone could sign an update, so rotate it: generate a new pair, ship one release signed with the old key that carries the new public key, then switch the secret.

## Canary

Merge or push to `master`. When the **Release** workflow finishes:

- a pre-release `canary-v0.2.1-canary.57` holds the installer, its `.sig`, the symbols zip, `latest.json` and `SHA256SUMS.txt`;
- the fixed pre-release `canary` has its `latest.json` replaced to point at that build. That file is what the Canary channel reads;
- canary builds beyond the newest 10 are deleted with their tags.

Nothing is committed: the canary version only exists in the build.

## Stable

1. Pick the version (semver) and set it everywhere:
   ```sh
   pnpm version:set 0.2.0
   git commit -am "Release 0.2.0"
   git push
   ```
   This push also builds a canary (`0.2.1-canary.N`), which is expected.
2. Tag and push the tag:
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
   The workflow fails early if the tag doesn't match `package.json`.
3. When it finishes, the summary links a **draft** release with the installer, `.sig`, symbols, `latest.json` and checksums, and notes generated from the commits since the last tag.
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
- [ ] Close to tray, reopen from the tray, quit with `Ctrl+Q`.
- [ ] Uninstall from *Settings → Apps*. Data in `%APPDATA%\com.peetsoftware.peetmail` stays unless you tick the option to delete app data.
