# Testing PeetMail

Four layers, fastest first. `pnpm verify` runs them all.

| Layer | Command | Covers |
|---|---|---|
| Types | `pnpm check` | Svelte, TS, and the harness (`tests/**`) |
| Unit (TS) | `pnpm test:unit` | Pure modules in `src/lib`, files named `*.test.ts` |
| Unit (Rust) | `pnpm test:rust` | `#[cfg(test)]` modules: SQL queries, PKCE, sanitizer, Graph parsing |
| E2E | `pnpm test:e2e` | The real app end to end against the fake Graph server |

## How E2E works

```
Playwright ──CDP──▶ WebView2 in peetmail.exe (debug build, headless)
                         │ Rust core
                         ▼
              fake Microsoft (tests/harness/fake-graph.ts)
              OAuth authorize/token + Graph /me, inbox, delta, bodies
```

- **Fake Microsoft.** `fake-graph.ts` implements the identity platform and the Graph routes PeetMail calls, with real semantics: PKCE verification, token expiry and rotation, delta paging with next/delta links, partial and `@removed` items, 429 throttling, 410 resync. Only `CLIENT_ID` (`11111111-2222-3333-4444-555555555555`) is accepted. Any other ID never redirects back, like Entra.
- **Fixtures.** `fixtures.ts` builds a seeded mailbox with dates relative to now. Messages tests can target by id: `msg-hostile` (scripts and handlers to strip), `msg-newsletter` (remote images), `msg-plain` (text body), `conv-thread-1` (4-message thread).
- **Isolation.** `app.ts` launches the exe with `PEETMAIL_DATA_DIR`, its own `WEBVIEW2_USER_DATA_FOLDER`, the fake server's URLs, and a free DevTools port. Every test gets a fresh app and a fresh fake server, so tests run in parallel.
- **Headless.** The window is created hidden, so nothing appears on screen or takes focus. WebView2 still renders, and screenshots and keyboard input over CDP work. Set `PEETMAIL_HEADED=1` to watch.
- **Builds.** `global-setup.ts` rebuilds the debug exe when sources are newer than the last harness build. `PEETMAIL_SKIP_BUILD=1` skips that check.

## Writing an E2E test

Import from `tests/e2e/fixtures.ts`:

- `page` is the app, not signed in. `inbox` is signed in with the first sync finished.
- `fake` is the in-process fake server. Use `fake.control(route, body)` to change the world and `fake.requestsSince(n)` to assert on traffic.
- Helpers: `syncNow`, `waitForSyncIdle`, `row(page, conversationId)`, `selectedRow`, `messageBody(page, n)` (frame locator for a message iframe), `snap(page, testInfo, name)` for a named screenshot.

```ts
test("new mail appears after Ctrl+R", async ({ inbox: page, fake }) => {
  await fake.control("deliver", { subject: "Hot off the press" });
  await syncNow(page, fake);
  await expect(page.getByTestId("thread-row").first()).toContainText("Hot off the press");
});
```

Drive the app the way a user does: keyboard first (`page.keyboard.press("j")`), selectors by `data-testid`. Wait on observable state (`toHaveAttribute("data-state", "idle")`, a visible element) before the next step, since saves and syncs are async.

Every test attaches `final-screen.png`, `app.log` and `console.log` to the report. On failure, read `test-results/e2e/<test>/error-context.md` for the error and an accessibility snapshot, or open `test-results/e2e-report/index.html`.

## The drive CLI

`pnpm drive` keeps one app + fake server running between shell calls, for exploring, reproducing bugs and checking UI changes. `pnpm drive help` lists every command. Typical loop:

```sh
pnpm drive start                 # headless, signed in, synced. --fresh stops at setup, --dev hot-reloads
pnpm drive key j j Enter         # prints a JSON state line after each action
pnpm drive body                  # text of the open message
pnpm drive shot                  # prints a PNG path; read it to see the screen
pnpm drive graph deliver '{"subject":"Hi"}'
pnpm drive key ctrl+r
pnpm drive logs
pnpm drive stop
```

`pnpm drive restart` relaunches the app on the same data, which tests persistence. `pnpm fake-graph` runs the fake server on its own, verbose, on port 4010.

## Fake server control API

`POST /_test/<route>` with JSON. `GET /_test` lists them all. The main ones: `deliver`, `update` (partial change such as `isRead`), `remove`, `throttle`, `config` (`rejectDeltaFilter`, `expireDelta`, `tokenTtl`, `latencyMs`, `failBody`), `expire-tokens`, `reset`, `requests`.

When the app starts calling a new Graph endpoint, add it to `fake-graph.ts` with the real API's semantics, including its error cases, then test it through the app.
