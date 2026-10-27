# Distribution plan

How PeetMail goes from "runs from source on one PC" to "installed and auto-updating for a small internal group", with errors, logs and traces we can actually use. Work is split into stages; each one ships on its own and leaves `pnpm verify` green.

## Status

| Stage | State |
|---|---|
| 0 Groundwork | Done |
| 1 CI + releases | Done (workflows written and linted; first real run happens when the repo is pushed) |
| 2 Auto-update, canary and stable channels | Done (same caveat) |
| 3 Sentry | Done in code and tests; uploads wait for the `SENTRY_AUTH_TOKEN` secret |
| 4–6 | Not started |

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
| OTLP token | A PeetMail-specific gateway token, arranged when Stage 4 starts. |

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

## Stage 4: telemetry to the LGTM stack

### Pipeline

- Move from `log` to `tracing`. The `tracing-log` bridge keeps the existing 35 `log::` calls working while we convert modules as we instrument them.
- `tracing-subscriber` layers: file (replaces `tauri-plugin-log`'s file target, with size-based rotation), Sentry (Stage 3), and OpenTelemetry.
- `opentelemetry` + `opentelemetry-otlp` (HTTP/protobuf over reqwest, batch processors) for traces, logs (`opentelemetry-appender-tracing`) and metrics.
- Export over OTLP/HTTP to the self-hosted gateway PolyCode already ships to. The endpoint and auth headers are compiled in from CI secrets (`PEETMAIL_OTLP_ENDPOINT`, `PEETMAIL_OTLP_HEADERS`, `key=value,key=value` like PolyCode's `POLYCODE_OTLP_HEADERS`). The token is extractable from the binary, and the repo is public, so it must be write-only and only for this app. Give PeetMail its own token so it can be rotated without touching PolyCode, and rate-limit it at the gateway.
- Resource attributes: `service.name=peetmail`, `service.namespace=peetsoftware`, `service.version`, `deployment.environment.name`, `service.instance.id` (per process, see below), `peetmail.install.id`, `peetmail.machine.id`, `os.version`, WebView2 version. No hostname, no username.

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
- Offline behaviour: bounded in-memory queue, drop oldest when full, never block the UI or sync. Export failures are counted, never logged in a loop.
- Sampling: 100% of traces for an internal group is fine at first; add a head sampler (setting-controlled) if volume grows. Errors are always kept.

### What gets instrumented

Spans (Tempo), with the same names reused as histogram metrics (Mimir):

| Area | Spans | Key attributes |
|---|---|---|
| Startup | `app.start` → `db.open`, `db.migrate`, `window.first_paint` (reported from the UI) | cold/warm, migration count |
| Auth | `auth.sign_in`, `auth.refresh` | provider, outcome, error code (`AADSTS…`, `invalid_grant`) |
| Sync | `sync.run` → `sync.folder` → `http.request`; `gmail.history`, `calendar.delta` | provider, folder role, pages, items added/removed, full resync y/n, 429/503 backoff count and wait |
| HTTP | every Graph/Gmail/GCal call | method, **route template** (`/me/mailFolders/{id}/messages/delta`), status, retry count, bytes |
| Outbox | `outbox.op` | op kind, attempt, outcome, queue depth |
| Send | `send.message` | provider, size bucket, attachment count, undo window used / cancelled |
| Bodies | `body.fetch`, `body.sanitize`, `body.prefetch`, cache eviction | size bucket, cache hit/miss, sanitize ms |
| Search | `search.query` | term count, operators used (not values), result count, ms |
| DB | slow-query span only when over a threshold | query name (static), ms |
| UI | `ui.action` per keymap binding: key → handler → next paint | binding id, view, ms |
| UI | `ui.open_thread`, `ui.list_render`, long tasks (> 50 ms) | message count bucket, ms |
| Updater, notifications, snooze wake | one span each | outcome |

UI spans are timed in the webview (`performance.now()`, `PerformanceObserver` for long tasks) and sent over IPC in small batches; Rust turns them into spans in the same trace when the action called a command (we pass a trace context through `invoke`). This gives "pressed `e` → archive → outbox → Graph" as one trace.

Metrics (Mimir): sync duration and failures, outbox depth and failures, body cache size, DB size, process memory and WebView2 memory (sampled every few minutes; PLAN.md already flags WebView2 memory as a risk), update check outcomes, account count by provider.

Logs (Loki): `info` and above from Rust via the OTLP log exporter, carrying trace and span IDs so Grafana links log lines to traces. Labels kept low-cardinality (service, version, env, level); the install ID is a structured field, not a label.

### PII and sensitive data

Sensitive here: email addresses and display names, subjects, previews, bodies, attachment names, calendar titles/locations/attendees, search terms, snippets, OAuth tokens and auth codes, provider message/thread/event IDs, Graph/Gmail URLs (their query strings carry IDs, `$filter` values and sometimes addresses), local paths (`C:\Users\<name>`), machine name.

Rules:
1. **Typed attributes only.** A `telemetry` module defines the allowed attribute keys and value types. Instrumentation uses those helpers; a lint test (grep in CI) rejects raw `tracing` field names that aren't on the list in instrumented modules.
2. **Route templating.** The HTTP client records the route template it was called with, never the URL. Query strings are dropped.
3. **Buckets, not values,** for sizes and counts where the exact value could fingerprint a message.
4. **Account correlation** uses `account.ref` = HMAC(install secret, account email), so we can tell "same account across events" on one install without knowing who.
5. **Error strings from servers** go through the scrubber: regexes for email addresses, bearer/JWT/refresh tokens, `code=`/`state=` parameters, GUID-like and base64-ish provider IDs, Windows user paths, plus the current accounts' own addresses and display names (exact match). The same scrubber runs in Sentry `before_send` and as a final OTel processor before export.
6. **Log levels.** `debug`/`trace` stay local (file only), so we can keep verbose local logs without shipping them.
7. **Consent.** Settings > Privacy: "Send usage and performance data" (separate from crash reports), on by default with the first-run notice. Off means the OTel layers aren't installed at all.

Tests:
- Rust unit tests for the scrubber and route templating, with real-world error bodies from Graph and Google.
- A fake OTLP collector in the harness that decodes the protobuf and records spans, logs and metrics.
- **PII canary E2E:** the fake Graph/Gmail fixtures get canary values (an address, subject, body phrase, attachment name, event title, search term, display name). The test signs in, syncs, opens, searches, sends, triggers an error, then asserts none of the canaries appear anywhere in what the fake collector or fake Sentry received. This is the test that keeps the guarantee from rotting.
- E2E asserts the expected spans exist for sync, open thread and archive, linked into one trace.

Grafana side (outside this repo, but part of the stage): dashboards for startup time, sync health per provider, UI action latency p50/p95 per binding, error rate per version, memory; alerts on sync failure rate and on a new version's error rate. Store dashboard JSON in `ops/grafana/` so it's reviewed like code.

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
