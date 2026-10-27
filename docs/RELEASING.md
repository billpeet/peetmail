# Releasing PeetMail

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a version tag is pushed. The workflow runs the full CI first, builds the NSIS installer, and creates a **draft** GitHub release. Nothing reaches users until you publish the draft.

## One-time setup

1. Push the repo to GitHub (public, MIT).
2. Under **Settings → Secrets and variables → Actions**, add the secrets below. All are optional for a first test release. Without the client IDs, the installed app asks for a client ID on first run, the same as a dev build.

| Secret | What | Used from |
|---|---|---|
| `PEETMAIL_MS_CLIENT_ID` | Application (client) ID of the built-in Entra app | Stage 1 |
| `PEETMAIL_GOOGLE_CLIENT_ID` | Client ID of the built-in Google "Desktop app" OAuth client | Stage 1 |
| `PEETMAIL_GOOGLE_CLIENT_SECRET` | Its client secret (not confidential for desktop clients, but keep it out of the repo) | Stage 1 |

Later stages add the updater signing key, the Sentry DSN and auth token, and the OTLP endpoint and headers; see `docs/DISTRIBUTION.md`.

## Cut a release

1. Pick the version (semver; `-beta.N` for a pre-release) and set it everywhere:
   ```sh
   pnpm version:set 0.2.0
   git commit -am "Release 0.2.0"
   git push
   ```
2. Wait for CI on `master` to go green.
3. Tag and push the tag:
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
   The workflow fails early if the tag doesn't match the version in `package.json`.
4. When the **Release** workflow finishes, its summary links the draft. It has:
   - `PeetMail_0.2.0_x64-setup.exe`, the installer
   - `PeetMail_0.2.0_x64-symbols.zip`, `peetmail.pdb` for symbolicating crash stacks (not installed)
   - `SHA256SUMS.txt`
   - release notes generated from the commits since the last tag
5. Smoke-test the installer (below), edit the notes if needed, and click **Publish release**. A tag containing `-` (e.g. `v0.3.0-beta.1`) is drafted as a pre-release.

If the build fails, fix it, then re-run the workflow, or move the tag to the fixed commit and push it again (`git tag -f v0.2.0 && git push -f origin v0.2.0`). Re-running against an existing draft replaces its assets. A published release is never rebuilt: bump the version instead.

## Smoke test

Windows Sandbox (built into Windows 11 Pro: *Turn Windows features on or off → Windows Sandbox*) gives a clean machine in seconds.

- [ ] The installer runs without admin rights. The build is unsigned, so SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**.
- [ ] PeetMail starts. Sign in with a Microsoft account and with a Google account, and the first sync completes.
- [ ] Open, archive and undo a conversation; send a message to yourself.
- [ ] Close to tray, reopen from the tray, quit with `Ctrl+Q`.
- [ ] Install over the previous release: mail and sign-ins survive the upgrade.
- [ ] Uninstall from *Settings → Apps*. Data in `%APPDATA%\com.peetsoftware.peetmail` stays unless you tick the option to delete app data.

## Telling users

The release page link is enough. Until auto-update lands (Stage 2), users install each release over the previous one by running the new installer. Their data and sign-ins are kept.
