# PeetMail

Keyboard-first mail + calendar client for Windows: Tauri 2 (Rust core) + SvelteKit SPA. Architecture, roadmap and decisions: `docs/PLAN.md`.

## Verify every change

Run the narrowest check that covers the change, then widen:

1. `pnpm check` for any TS or Svelte edit.
2. `pnpm test:unit` (Vitest, `src/**/*.test.ts`) and `pnpm test:rust` (`cargo test`) for logic changes.
3. `pnpm test:e2e` for anything a user can see or that touches sync, auth or IPC. Playwright drives the real app against a fake Microsoft Graph, headless.
4. For UI work, look at it: `pnpm drive start`, drive it with keys, `pnpm drive shot`, and read the PNG.

Done means `pnpm verify` is green and every new behaviour has a test that would go red without it. Testing details, the drive CLI and the fake server: `tests/README.md`.

## Gotchas

- The harness runs its own `tauri build --debug` exe from `src-tauri/target-harness` (separate from `target/`, so a running `pnpm tauri dev` never locks it). It rebuilds automatically via a stamp file. A plain `cargo build` exe loads the Vite dev server instead of the embedded frontend, so it is never used for tests.
- Test-only env overrides (`PEETMAIL_*`, see `src-tauri/src/testenv.rs`) are compiled out of release builds. Keep new test knobs there.
- Tests and the drive CLI run in their own data dir and WebView2 profile. The user's real data lives in `%APPDATA%\com.peetsoftware.peetmail`; leave it alone.
- UI elements that tests or agents target get a `data-testid`. Add one with every new interactive element.
- Every action is a binding in the keymap registry (`src/lib/keys.svelte.ts`) so it shows in the `?` overlay and the future command palette.
- Clippy runs with `-D warnings` (`pnpm lint:rust`, part of `pnpm verify` and CI). The Rust code isn't rustfmt-formatted; don't reformat files wholesale.
- The version lives in `package.json`; `pnpm version:set <x.y.z>` copies it to `Cargo.toml` and `Cargo.lock`. Releasing: `docs/RELEASING.md`.
- Harness builds merge `src-tauri/tauri.harness.conf.json` over `tauri.conf.json`: the updater trusts the test key in `tests/harness/updater/` and allows the fake update server's http. Never put test keys or `dangerous*` flags in `tauri.conf.json`.
