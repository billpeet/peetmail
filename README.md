# PeetMail

Fast, minimal, keyboard-first mail and calendar for Windows. Microsoft 365 and Outlook.com first.

Plan, architecture and roadmap are in [docs/PLAN.md](docs/PLAN.md).

## Prerequisites

- Node 22+ and pnpm
- Rust (stable, MSVC toolchain) and the Visual Studio C++ build tools
- WebView2 runtime (preinstalled on Windows 11)
- An Entra app registration, see [docs/PLAN.md#entra-app-registration](docs/PLAN.md#entra-app-registration)

## Develop

```sh
pnpm install
pnpm tauri dev
```

On first launch, paste your Entra Application (client) ID, then press Enter to sign in.

## Test and check

```sh
pnpm check                         # svelte-check + TypeScript
cargo test --manifest-path src-tauri/Cargo.toml
```

## Build

```sh
pnpm tauri build                   # NSIS installer in src-tauri/target/release/bundle
```

## Where things live

| Path | What |
|---|---|
| `src-tauri/src/` | Rust core: auth, Graph client, sync, SQLite, sanitizing |
| `src-tauri/migrations/` | Numbered SQL migrations |
| `src/lib/api.ts` | Typed wrappers for Rust commands and events |
| `src/lib/keys.svelte.ts` | Keymap registry, the source of truth for shortcuts |
| `src/lib/mail.svelte.ts` | UI state: threads, selection, view |
| `src/lib/components/` | Svelte components |

App data lives in `%APPDATA%\com.boris.peetmail\peetmail.db`. Logs go to `%LOCALAPPDATA%\com.boris.peetmail\logs`.
