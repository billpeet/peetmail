# PeetMail

Fast, minimal, keyboard-first mail and calendar for Windows and Linux. Microsoft 365, Outlook.com and Gmail.

Plan, architecture and roadmap are in [docs/PLAN.md](docs/PLAN.md).

## Prerequisites

- Node 22+ and pnpm
- Rust (stable, MSVC toolchain) and the Visual Studio C++ build tools
- WebView2 runtime (preinstalled on Windows 11)
- On Linux instead: Rust (stable) and the WebKitGTK build packages. On Debian or Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential file` (other distros: [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/#linux))
- For local builds, an Entra app registration (release builds have PeetMail's own built in), see [docs/user/your-own-app.md](docs/user/your-own-app.md). To build with one built in, set `PEETMAIL_MS_CLIENT_ID` (and `PEETMAIL_GOOGLE_CLIENT_ID`/`_SECRET`) before building.

## Develop

```sh
pnpm install
pnpm tauri dev
```

On first launch, paste your Entra Application (client) ID, then press Enter to sign in.

## Test and check

```sh
pnpm verify                        # types, unit (TS + Rust), headless E2E
pnpm drive start                   # explore a test instance step by step
```

How the test system works, including the fake Microsoft server and the drive CLI: [tests/README.md](tests/README.md).

## Build and release

```sh
pnpm tauri build                   # Windows: NSIS installer; Linux: AppImage (src-tauri/target/release/bundle)
```

Releases are built by GitHub Actions from a version tag; see [docs/RELEASING.md](docs/RELEASING.md). The distribution roadmap (updates, crash reporting, telemetry) is in [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

## Where things live

| Path | What |
|---|---|
| `src-tauri/src/` | Rust core: auth, Graph client, sync, SQLite, sanitizing |
| `src-tauri/migrations/` | Numbered SQL migrations |
| `src/lib/api.ts` | Typed wrappers for Rust commands and events |
| `src/lib/keys.svelte.ts` | Keymap registry, the source of truth for shortcuts |
| `src/lib/mail.svelte.ts` | UI state: threads, selection, view |
| `src/lib/components/` | Svelte components |
| `docs/user/` | Help for people using PeetMail, also shown in the app (F1). `CHANGELOG.md` is its What's new |
| `src-tauri/icons/source/` | The app icon's sources: the master SVG and hand-tuned 16/24/32 px versions. `pnpm icons` regenerates `src-tauri/icons/` from them |

App data lives in `%APPDATA%\com.peetsoftware.peetmail\peetmail.db` (Linux: `~/.local/share/com.peetsoftware.peetmail/`). Logs go to `%LOCALAPPDATA%\com.peetsoftware.peetmail\logs` (Linux: `logs/` in that folder). Before a schema migration the database is copied to `peetmail.db.v<schema>.bak` beside it (the last two are kept). Early dev builds used `com.boris.peetmail`; the first start of a current build moves that data across.

## Licence

MIT, see [LICENSE](LICENSE).
