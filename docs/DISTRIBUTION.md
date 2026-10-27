# Distribution plan

How PeetMail goes from "runs from source on one PC" to "installed and auto-updating for a small internal group", with errors, logs and traces we can actually use. Work is split into stages; each one ships on its own and leaves `pnpm verify` green.

## Status

| Stage | State |
|---|---|
| 0 Groundwork | Done |
| 1 CI + releases | Done (workflows written and linted; first real run happens when the repo is pushed) |
| 2 Auto-update, canary and stable channels | Done (same caveat) |
| 3 Sentry | Done in code and tests; uploads wait for the `SENTRY_AUTH_TOKEN` secret |
| 4 Telemetry | Done in code and tests; sends nothing until the endpoint variable and token secret are set |
| 5–6 | Not started |

## Decisions

| Question | Decision |
|---|---|
| Repo and releases | Public GitHub repo, MIT. Releases on the same repo, so the updater reads `latest.json` from public release assets with no token. |
| Code signing | Unsigned for now. Users click through SmartScreen once per download; updates are still verified by the updater key. Revisit Azure Trusted Signing if the group grows. |
| Telemetry backend | Self-hosted LGTM behind the OTLP gateway PolyCode already uses (see Stage 4). |
| Users | Small internal group, mostly in one Entra tenant, also using personal Outlook.com and Gmail accounts. |
| Consent | Crash reports and telemetry on by default, with a first-run notice and an opt-out in Settings. |
| Identity | Identifier `com.peetsoftware.peetmail`, publisher "Peet Software". |
| Release channels | Canary (a build of every push to `master`) and Stable (tagged releases only). |
| Sentry | Project `peetmail` in the `metroid` org. DSN in the repo variable `PEETMAIL_SENTRY_DSN`; uploads use the `SENTRY_AUTH_TOKEN` secret. |
| OTLP token | A PeetMail-specific, write-only gateway token: the `PEETMAIL_OTLP_HEADERS` secret, with the gateway URL in the `PEETMAIL_OTLP_ENDPOINT` variable. |

## Where we started

- NSIS bundle target, `com.boris.peetmail` identifier, version `0.1.0` written in three places (`package.json`, `Cargo.toml`, `tauri.conf.json`).
- No git remote, no CI.
- OAuth client IDs can already be baked in at build time (`PEETMAIL_MS_CLIENT_ID`, `PEETMAIL_GOOGLE_CLIENT_ID`, `PEETMAIL_GOOGLE_CLIENT_SECRET` via `option_env!`), with a stored setting that overrides them. There is one client per provider, global, so changing it signs every account of that provider out.
- Logging goes through the `log` crate and `tauri-plugin-log` to a file in `%LOCALAPPDATA%`. Panics are written to that file. Release builds use `panic = "abort"` and `strip = true`.
- The frontend has no error handling beyond what each call site does, and the CSP allows `connect-src` only to IPC.

## Principles

1. **One egress point.** Only the Rust core talks to Sentry, the OTLP endpoint and the update server. The webview sends errors and spans over IPC, so the CSP stays `connect-src ipc:` and there's one place to redact.
2. **Allowlist, not denylist, for telemetry.** Spans and logs carry only attributes we chose and typed. Free text (subjects, addresses, bodies, error strings from servers) never leaves the machine unless it has been through the scrubber. The scrubber exists as a backstop, not as the plan.
3. **Testable like everything else.** The harness gets a fake Sentry, a fake OTLP collector and a fake update server, the same way it has a fake Graph. A test seeds known PII into the fixtures and fails if any of it reaches a fake collector.
4. **Release builds can't be pointed elsewhere by env var.** Endpoint overrides for tests go in `testenv.rs`, as now.

---

## Stage 0: groundwork (done)

- **Identity.** Identifier `com.peetsoftware.peetmail`, publisher and authors "Peet Software", MIT `LICENSE`. Data from the old `com.boris.peetmail` folders (database and WebView2 profile) moves across on first start (`src-tauri/src/datadir.rs`), never over existing data.
- **One version source.** `package.json` holds it; `tauri.conf.json` reads `../package.json`; `pnpm version:set` copies it into `Cargo.toml` and `Cargo.lock`; `pnpm version:check` (in `pnpm verify` and CI) fails on drift, and the release checks the tag against it (`scripts/version.ts`).
- **Install mode.** NSIS `installMode: "currentUser"`: install and update need no admin. WebView2 bootstrapper left at the default.
- **Debug symbols.** The release profile adds `debug = "line-tables-only"`, so the linker writes `peetmail.pdb` (39 MB) beside a ~11 MB exe. `strip = true` stays: with MSVC it doesn't touch the PDB or the exe's CodeView record (checked: same PDB, same debug ID reference, exe 90 KB smaller). The exe embeds only the file name `peetmail.pdb`, not the build path. The PDB is attached to each release as a zip and isn't installed.
- **DB safety on upgrade.** Before migrating an existing database, `Db::open` writes `peetmail.db.v<schema>.bak` with `VACUUM INTO` and keeps the newest two. A database with a newer schema than the build knows is refused. The app shows a message box with the reason and exits, instead of crashing silently or touching the file.
- **Clippy clean.** Existing warnings are fixed and `pnpm lint:rust` (`-D warnings`) is part of `pnpm verify`.

Tests: Rust unit tests for backup, pruning, refusal and legacy-data adoption; Vitest for the version script; E2E (`tests/e2e/startup.spec.ts`) that the real exe exits with the reason logged and the newer database untouched.

## Stage 1: CI and GitHub Releases (done)

**`ci.yml`** runs on pushes to `master`, PRs, and as the first job of a release.
- `verify` (windows-latest): version check, `svelte-check`, Vitest, clippy `-D warnings`, `cargo test`, Playwright E2E headless against the fakes. One cargo target dir (`target-harness`) is shared by clippy, tests and the harness build so the Rust cache holds one set of dependencies; only `master` writes the cache. Test results are uploaded on failure.
- `audit` (ubuntu): `cargo deny` for licences, bans and sources (blocking; policy in `src-tauri/deny.toml`), advisories (reported on branches, blocking on release tags), and `pnpm audit --prod`.

**`release.yml`** runs on `v*` tags: calls CI, checks the tag against the version, builds with `pnpm tauri build` (built-in OAuth client IDs from secrets), then creates or refreshes a draft release with the installer, the symbols zip and `SHA256SUMS.txt`, and checks every asset arrived. Pre-release tags (`-beta.N`) become pre-releases. Publishing stays manual. Runbook: `docs/RELEASING.md`.

All actions are pinned by commit SHA (the release job holds a write token, and later the signing keys).

Stage 2 reworked `release.yml` into the two channels described there. Not done yet, added by later stages: Sentry release, PDB and source-map upload (Stage 3), OTLP endpoint and DSN secrets (Stages 3 and 4).

## Stage 2: automatic updates, canary and stable (done)

**Channels.** Canary is a build of every push to `master`, versioned `<next patch>-canary.<run>` (`scripts/version.ts canary`), so canaries sort after the last stable and before the next. It's published straight away as a pre-release `canary-v<version>`; then the fixed pre-release `canary` gets a new `latest.json` pointing at it, and builds beyond the newest 10 are pruned. Stable is a `v*` tag, drafted with its `latest.json`; publishing the draft makes it the repo's latest release, which is what the Stable feed (`releases/latest/download/latest.json`) reads. PolyCode's publish-on-every-push model is the canary channel; stable keeps a human in the loop. Runbook: `docs/RELEASING.md`.

**In the app** (`src-tauri/src/update.rs`, `src/lib/updates.svelte.ts`):
- `tauri-plugin-updater` with the public key in `tauri.conf.json` and `requireSignedVersion` on, so a tampered manifest can't pass an older, validly signed build off as a newer version (the signature's trusted comment carries the version; `tauri build` writes it). `tauri-plugin-process` wasn't needed.
- The feed URL is built at runtime from the channel and the repo, compiled in from CI (`PEETMAIL_UPDATE_REPO`, `PEETMAIL_CHANNEL`). Local builds have no repo, so they show "Updates aren't available in this build" and never check.
- First check a minute after start, then every 6 hours, plus Settings → Updates → Check now and a palette command. A newer build is downloaded and verified in the background; the footer then shows "0.3.0 is ready · restart to update", and `Ctrl+Shift+U` (a keymap binding, so it's in `?` and the palette) installs it.
- Install is refused while a draft is open or a send is in its undo window (`outbox::sends_in_progress`); scheduled sends persist and don't block. NSIS runs in passive mode; the app flushes its log, exits, and the new version starts.
- Settings → Updates: version, channel (Stable / Canary), status, Check now / Restart to update. A build defaults to the channel it was built for. Switching channel drops a download from the other channel and checks the new one. Canary → Stable takes effect at the next stable release (no downgrades).
- Status events carry a sequence number, so a late command result can't overwrite a newer event (a real race the E2E caught).

**Tests.** Rust: channel resolution, feed URLs, canary version ordering (with the `semver` crate the updater uses), `sends_in_progress`. Vitest: canary version rule, manifest shape, status text, out-of-order statuses. E2E (`tests/e2e/updates.spec.ts`) against a fake update server serving test-key-signed payloads: disabled without a feed; background check finds, downloads, verifies and installs via `Ctrl+Shift+U`; Check now; channel switch; tampered payload refused; mismatched signed version refused; no install with a draft open or a send pending. Install itself is faked in tests (`PEETMAIL_FAKE_UPDATE_INSTALL`); the real install-and-relaunch is on the release smoke-test checklist. A canary-versioned, signed installer was built locally to confirm NSIS accepts pre-release versions and the asset names match the workflow.

**Not done:** install-on-quit, and a `minimumVersion` field to force everyone off a bad build. Both are small additions to `update.rs` if they're needed.

## Stage 3: Sentry (done)

**What's reported** (`src-tauri/src/crash.rs`):
- Rust panics, from any thread (the SDK's panic integration; with `panic = "abort"` it captures and flushes before the process dies).
- Native crashes (access violations, stack overflows) as minidumps. Sentry's minidump integration runs a small crash-reporter process (this exe, re-run; it stops inside `sentry::init`, which is why that's the first thing `run()` does) and uploads the dump when the app dies. Minidumps hold raw stack memory, which the scrubber can't reach; Sentry doesn't keep the raw dump after processing unless the project's "Store Native Crash Reports" setting is on, so leave it off.
- Webview errors: `window.onerror` and unhandled rejections (`src/lib/errors.ts`) go to the `report_error` command, and Rust sends them as JavaScript events. The webview never talks to the network, so the CSP is unchanged. At most 20 reports a session, the same message once a minute.
- Not reported: WebView2 process crashes (they're separate processes; a `ProcessFailed` handler could add them later), and log lines on their own. Info and above are kept as a 50-line breadcrumb trail on every report. The trail is process-wide rather than in the SDK's per-thread scope, which would have dropped lines logged on sync threads.

**What's removed** (`src-tauri/src/scrub.rs`, shared with Stage 4): the signed-in accounts' addresses and names (exact, case-insensitive), any email address, bearer tokens and JWTs, OAuth parameters (`code=`, `refresh_token=`…), URL query strings (routes are kept), Windows profile paths (`C:\Users\<name>` with spaces handled), and long opaque IDs. Every event also loses its host name, device name, request and user fields except a random install ID. `send_default_pii` is off.

**Consent:** on by default; Settings → Privacy turns it off (immediately, and before the next start's crash reporter is spawned) and shows the install ID to quote. A first-run notice says reports are on, with a Settings button. Builds without a DSN (local, and tests without the fake) show neither and send nothing.

**Release:** the DSN is compiled in from the repo variable. The release job builds the frontend with hidden source maps, uploads them for `peetmail@<version>`, deletes them before `tauri build` embeds `build/`, uploads `peetmail.pdb` and `peetmail.exe` as debug files, and finalizes the release. Without the `SENTRY_AUTH_TOKEN` secret those steps warn and skip, so builds still ship.

**Tests:** Rust unit tests for the scrubber, event scrubbing, JS stack parsing, the breadcrumb trail and the install ID; Vitest for the webview hooks and rate limit. E2E against a fake Sentry (`tests/harness/fake-sentry.ts`, parses envelopes including binary attachments): a webview error arrives scrubbed with release, environment, install ID and breadcrumbs; a panic arrives with its message and trail; opting out stops reports at once and opting back in resumes them; the notice shows once; a deliberate native crash produces a real minidump (`MDMP`) from the crash reporter; and no report contains the account's address or name, a correspondent's address, the PC's name or the Windows user name.

## Stage 4: telemetry to the LGTM stack (done)

### Pipeline (`src-tauri/src/telemetry.rs`)

- OpenTelemetry SDK 0.33 with the OTLP exporter over **HTTP/JSON** to the gateway (`/v1/traces`, `/v1/metrics`, `/v1/logs`). JSON is what PolyCode's exporters already send to it, and what the harness's fake collector reads without a protobuf library. Batch processors for spans and logs (bounded queues; when the gateway is unreachable they drop rather than block), metrics every 30 s, 5 s export timeouts, shutdown on exit and before an update installs.
- Endpoint and headers are compiled in: `PEETMAIL_OTLP_ENDPOINT` (repo variable) and `PEETMAIL_OTLP_HEADERS` (secret, `key=value,key=value`). The token is extractable from the binary of a public repo, so it must be write-only, PeetMail's own, and rate-limited at the gateway.
- **Deviation from the plan:** no move from `log` to `tracing`. Spans use the OpenTelemetry API directly through `telemetry::traced(name, attrs, future)`, which carries the span's context through the future so child spans (HTTP inside a folder sync inside an account sync) nest. Logs keep going through `log`: the logger wrapper from Stage 3 also exports info-and-above lines, scrubbed, and the SDK attaches the active trace, so Loki lines link to Tempo traces. This avoided rewriting every log call and a second subscriber stack next to Sentry.
- Resource: `service.name=peetmail`, `service.namespace=peetsoftware`, `service.version`, `deployment.environment.name` (stable, canary or dev), `service.instance.id` (per process), `peetmail.install.id`, `peetmail.machine.id`, `os.type`.

#### What to reuse from PolyCode

PolyCode's `apps/desktop/src/main/observability.ts` (Node/Electron) solved several problems we'd otherwise rediscover. The Rust port should keep these:

- **`service.instance.id` is per process, not per install.** PolyCode first used the install hash. When two processes from one install overlapped (an old one lingering after an update), Prometheus saw two cumulative counters interleaved as one series, counted a reset every export, and showed rates a thousand times too high. Use `<install id prefix>-<machine id>-<pid>-<start time>`, with the install ID as its own attribute for grouping launches. The updater makes this overlap likely for us too.
- **A hashed machine ID** (SHA-256 of the lowercased hostname, first 8 hex chars) tells apart machines that would otherwise share an install ID. PolyCode derives the install ID from a hash of the user-data path. That path contains the Windows username, so its hash is guessable. PeetMail uses a random install ID stored in settings instead.
- **Byte histograms need their own buckets.** The default histogram buckets are millisecond-shaped (up to 10,000). PolyCode adds a view giving `By`-unit histograms doubling buckets from 1 KB to 4 GB. The view must also match the instrument type: matching on the unit alone turned memory gauges into histograms and hid heap size for several releases.
- **Small helper API** (`with_span`, `count`, `record_duration`, `record_size`, `record_gauge`, `record_log`) over lazily created instruments. That keeps call sites to one line, and the attribute allowlist (below) can be enforced in one place.
- **Logs carry the active span's context**, so Loki lines link to Tempo traces.
- **Only W3C `traceparent` crosses process boundaries**, never arguments. PolyCode does this for its child processes; we do it for `invoke()` from the webview.
- **Export interval 30 s for metrics, batch processors for spans and logs, flush on quit** (with a short timeout, so quitting is never held up).
- **Crash incidents share an ID** between the local log, the OTLP log and the Sentry event (`docs/crash-diagnostics.md` in PolyCode). Worth copying in Stage 3 for WebView2 process failures, which are the Tauri equivalent of Electron renderer crashes.

PolyCode's own PII handling is per-call-site discipline (hashes for IDs, allowlisted categories). PeetMail handles mail, so it adds the enforced allowlist, the scrubber and the canary test described below.

### What's instrumented

| Area | Telemetry | Attributes |
|---|---|---|
| Startup | `app.startup.duration` (process start to window), `ui.first_paint.duration` | |
| Auth | `auth.sign_in`, `auth.refresh` spans | provider, outcome, error kind, `AADSTS…`/OAuth error code only |
| Sync | `sync.run` → `sync.account` → `sync.folder` / `sync.mail` / `sync.calendar` spans; a "sync finished" log line in each run | provider, folder role, pages, items, full resync |
| HTTP | `http.request` span for every Graph, Gmail and Calendar call (one choke point, `graph::send`); `peetmail.http.throttled` counter | method, **URL template** (`/v1.0/me/mailFolders/{id}/messages/delta`), API, status, attempts |
| Outbox | `outbox.op` span (sends included) | op kind, attempt, outcome |
| Bodies | `body.fetch` span, `body.sanitize.duration`, `body.fetch.size` histogram, `peetmail.body.reads` (cache hit/miss) | size bucket |
| Search | `search.query` span | number of free-text terms and of operators, result count |
| UI | `ui.action` span per keymap binding, key press to next painted frame; `ui.long_task` (> 50 ms) | binding id, view |
| Updater, snooze | `peetmail.update.checks`, `peetmail.snooze.woke` counters | channel, outcome |
| Process (every minute) | `peetmail.outbox.depth`, `peetmail.body_cache.size`, `peetmail.db.size`, `peetmail.accounts`, `process.memory.usage` gauges | provider |

Every span also feeds a `<name>.duration` histogram (ms buckets up to 2 minutes) with its low-cardinality attributes and outcome, so Mimir has latency and error rates without querying Tempo.

### Keeping personal data out

1. **By type, not by care.** Attributes are `(Key, Val)`. `Key` is a closed enum. A `Val` is a `&'static str`, a number, a bool, or `Safe`, which only `route_template` and `code` can make. A subject, address or search term can't become an attribute without editing `telemetry.rs`, and a unit test fails if any other file builds OpenTelemetry attributes itself.
2. **URL templates, not URLs:** the path only, with every segment that isn't a fixed route word replaced by `{id}`. Hosts and query strings are dropped.
3. **Shapes, not content:** search sends counts of terms and operators; sizes are buckets; errors are a kind (`server` plus status, `timeout`, `auth` plus code), never text.
4. **Logs are scrubbed** by the same `scrub.rs` as crash reports, and only info and above leave the PC.
5. **Consent:** Settings → Privacy → "Send usage and performance data", on by default, covered by the first-run notice. Off stops recording at once; without an endpoint, or when off at start, the exporters are never created.

Planned items still open: per-account correlation (`account.ref`) isn't needed, since nothing is per account; the trace context isn't yet passed through `invoke`, so a UI action and the command it triggers are separate traces; there's no WebView2 memory gauge, `os.version` or WebView2 version, slow-query DB spans or head sampler. Grafana dashboards (`ops/grafana/`) are still to do.

### Tests

- Rust: URL templates (Graph, Gmail, Calendar, the fakes), codes, auth-error attributes, size buckets, header parsing, per-process instance IDs, search shape, and the no-raw-attributes check.
- Vitest: the webview timing batcher.
- E2E against a fake OTLP collector (`tests/harness/fake-otlp.ts`). A session (sign-in, sync, open, search, send, archive) produces the expected spans, nested correctly (`http.request` inside `sync.folder` inside `sync.account`), with templated routes, the search's shape, binding ids, the resource and install ID, the auth header on every request, metrics, and logs carrying trace IDs. **PII canaries:** none of the account address or name, correspondents' names and addresses, subjects, body text, the search word, provider message IDs, the sent message's recipient, subject and body, the ingest token, the PC name or the Windows user name appears anywhere the collector received. Opting out stops spans straight away.

## Stage 5: embedded OAuth apps, with custom apps as an advanced option

### Built-in apps

- **Microsoft:** one Entra app registration in the main tenant, "any organizational directory and personal Microsoft accounts" (`common`), public client, `http://localhost` redirect, the delegated scopes in PLAN.md. A tenant admin grants consent once for the main tenant, so those users see no consent prompt. Personal Outlook.com accounts consent for themselves. Users in other tenants may hit "needs admin approval" if their tenant blocks user consent; that's where the custom-app option below helps. Publisher verification (needs an MPN ID) can come later.
- **Google:** one Google Cloud project, user type *External*, published *In production* and left unverified. Any Google account can sign in, behind the "Google hasn't verified this app" screen, capped at 100 users lifetime, which is fine for this group. (`gmail.modify` is a restricted scope; verification would need a CASA assessment, which isn't worth it here. *Internal* would hide the warning but block personal Gmail.)
- The client IDs (and Google's non-confidential desktop secret) are injected by `release.yml` from secrets, via the existing `option_env!` path. Dev builds keep working with no IDs (setup screen) or a local `.env`.

### Custom apps (advanced)

The current model (one stored client per provider, changing it signs everyone out) gets awkward once there's a default. Change it to:

- Each account records the client it signed in with: `accounts.client_ref` = `builtin` or the ID of a row in a new `oauth_clients` table (provider, client ID, optional secret DPAPI-encrypted, label, optional tenant/authority).
- Refresh uses the account's own client, so a custom-app account and built-in-app accounts can coexist, and changing the default no longer signs anyone out.
- Migration: existing accounts point at a client row created from today's stored `ms_client_id`/`google_client_id` settings, so nobody is signed out by the upgrade.
- UI: the setup screen and "Add account" show just "Sign in with Microsoft / Google". Settings > Accounts > **Advanced** lists custom apps, lets you add one, and "Add account with…" picks which app. The existing `ClientIdForm`/`GoogleClientForm` move there.
- Optional tenant lock: a custom Microsoft app can set the authority to a tenant ID instead of `common`, for single-tenant registrations.
- Org-managed override: read `HKCU\Software\Policies\PeetMail` (and HKLM) for `MicrosoftClientId`, `GoogleClientId`, `TelemetryEnabled`, `UpdateChannel`, so an admin can preconfigure installs through Intune/GPO without a custom build. Policy beats settings, which beat built-in.

Tests: Rust unit tests for client resolution order (policy > account's client > built-in) and the migration; E2E for adding a second Microsoft account through a custom app with the fake server checking which client ID each refresh uses; E2E that the built-in path needs no setup screen.

The "register your own app" sections of PLAN.md become the docs for the Advanced path; the default user never sees them.

## Stage 6: the rest of what a distributed app needs

- **Diagnostics export.** Palette command "Export diagnostics": zips the last few log files (scrubbed), app/WebView2/OS versions, settings minus secrets, DB stats (row counts, sizes, `user_version`), outbox state. Saves to Downloads. For when telemetry is off or the problem is "it won't start".
- **Feedback.** A binding that opens a small form and sends it as Sentry User Feedback with the install ID and current trace ID attached. Cheaper than a separate channel for a small group.
- **What's new.** After an update, show the release notes once (from the release body cached at download time).
- **First-run notice.** One screen covering what's sent (crash reports, usage and performance data), what's never sent (mail content, addresses), and where to turn it off.
- **Health checks at startup.** WebView2 version below a minimum, DB integrity (`PRAGMA quick_check` on version change), disk space low; each a clear message rather than a blank window.
- **Dependency hygiene.** Renovate or Dependabot for cargo, pnpm and GitHub Actions, grouped weekly. Pin actions by SHA in the release workflow, since it holds signing keys.
- **Secrets inventory.** Updater signing key (and its password), Sentry auth token (CI only) and DSN, OTLP endpoint and ingest token, Microsoft client ID, Google client ID and secret. Store the updater private key outside GitHub as well: losing it means no installed copy can ever auto-update again.
- **Release checklist** (`docs/RELEASING.md`): bump version, tag, wait for the draft, smoke-test the installer on a clean VM (install, sign in with both providers, update from the previous version, uninstall), publish.
- **Docs.** A short user-facing README for the internal group: install, what the warning screens mean, how to report a problem.

## Suggested order

| Stage | Depends on | Size |
|---|---|---|
| 0 Groundwork | – | S |
| 1 CI + releases | 0 | M |
| 2 Auto-update | 1 | M |
| 3 Sentry | 1 (for symbols, source maps) | M |
| 4 Telemetry | 3 (shares scrubber, install ID) | L |
| 5 OAuth apps | 1 (secrets) | M |
| 6 Rest | 1–5 | M, can be picked off individually |

Stage 5 is independent of 2–4 and can run in parallel or go first if the setup screen is the bigger barrier for users. The first build handed to anyone should include at least 1, 2, 3 and 5; telemetry can follow in an update, which is one more reason to have the updater early.

## Open questions

Answered ones are under Decisions at the top. Nothing is open right now; Sentry and the OTLP token get set up when their stages start.
