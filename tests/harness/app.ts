// Launches the real PeetMail binary against the fake Graph server, isolated from
// the user's real data, and connects Playwright to its WebView2 over CDP.
// Used by the Playwright fixtures (tests/e2e) and the drive CLI.

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnType } from "node:child_process";
import { chromium, type Browser, type Page } from "@playwright/test";

/** What the launcher needs from a fake server (in-process or a detached one). */
export type FakeEndpoints = { graphUrl: string; authorityUrl: string };

export type LaunchOptions = {
  fake: FakeEndpoints;
  dataDir?: string;
  cdpPort?: number;
  syncIntervalSecs?: number;
  /** Undo-send delay. 0 (the default here) sends at once, so tests don't wait out the app's 10s. */
  undoSendSecs?: number;
  headed?: boolean;
  /** Run `pnpm tauri dev` (hot reload) instead of the prebuilt debug exe. */
  dev?: boolean;
  /** Leave the app running after this process exits (used by the drive CLI). */
  detached?: boolean;
};

export type LaunchedApp = {
  page: Page;
  browser: Browser;
  proc: ReturnType<typeof spawnType>;
  dataDir: string;
  cdpPort: number;
  logPath: string;
  close(): Promise<void>;
};

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * The harness builds into its own target dir, so tests never fight a dev copy of the app
 * (`pnpm tauri dev`) over a locked target/debug/peetmail.exe.
 */
const TARGET_DIR = join(ROOT, "src-tauri/target-harness");
export const EXE = join(TARGET_DIR, "debug/peetmail.exe");
/**
 * Written after a successful `tauri build --debug`. A plain `cargo build` produces an
 * exe that loads the Vite dev server instead of the embedded frontend, so an exe newer
 * than the stamp means "not built by us" and forces a rebuild.
 */
const STAMP = join(TARGET_DIR, "debug/.harness-build-stamp");

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as import("node:net").AddressInfo;
      s.close(() => res(port));
    });
  });
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/** True when the debug exe is missing or older than any frontend/Rust source. */
export function needsBuild(): boolean {
  if (!existsSync(EXE) || !existsSync(STAMP)) return true;
  const built = statSync(STAMP).mtimeMs;
  if (statSync(EXE).mtimeMs > built + 1000) return true;
  const sources = ["src", "src-tauri/src", "src-tauri/migrations", "static"].map((d) => join(ROOT, d)).filter(existsSync);
  const files = ["src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "package.json", "vite.config.js", "svelte.config.js"].map((f) => join(ROOT, f));
  return Math.max(...sources.map(newestMtime), ...files.filter(existsSync).map((f) => statSync(f).mtimeMs)) > built;
}

/** Builds the debug binary (frontend embedded) if sources changed. Set PEETMAIL_SKIP_BUILD=1 to skip. */
export function ensureBuilt({ force = false, log = console.log }: { force?: boolean; log?: (msg: string) => void } = {}) {
  if (process.env.PEETMAIL_SKIP_BUILD === "1" && existsSync(STAMP)) return;
  if (!force && !needsBuild()) return;
  log("building debug app (pnpm tauri build --debug --no-bundle)…");
  const r = spawnSync("pnpm tauri build --debug --no-bundle", {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET_DIR },
  });
  if (r.status !== 0) throw new Error("debug build failed");
  writeFileSync(STAMP, new Date().toISOString());
}

/** Headless unless PEETMAIL_HEADED=1 (or `headed: true`), so test windows never interrupt you. */
export const DEFAULT_HEADED = process.env.PEETMAIL_HEADED === "1";

// Off-screen windows count as occluded to Chromium, which then throttles rendering
// and timers. Tauri's own feature flags are repeated because this env var replaces them.
const HEADLESS_BROWSER_ARGS = [
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
].join(" ");

export function testEnv({
  fake,
  dataDir,
  cdpPort,
  syncIntervalSecs = 3600,
  undoSendSecs = 0,
  headed = DEFAULT_HEADED,
}: { fake: FakeEndpoints; dataDir: string; cdpPort: number; syncIntervalSecs?: number; undoSendSecs?: number; headed?: boolean }): Record<string, string> {
  return {
    ...(headed ? {} : { PEETMAIL_HEADLESS: "1" }),
    PEETMAIL_DATA_DIR: dataDir,
    PEETMAIL_GRAPH_URL: fake.graphUrl,
    PEETMAIL_AUTHORITY_URL: fake.authorityUrl,
    PEETMAIL_AUTH_AUTOFOLLOW: "1",
    PEETMAIL_SYNC_INTERVAL_SECS: String(syncIntervalSecs),
    PEETMAIL_UNDO_SEND_SECS: String(undoSendSecs),
    PEETMAIL_DOWNLOAD_DIR: join(dataDir, "downloads"),
    // Own WebView2 profile, so a running copy of the real app can't collide with tests.
    WEBVIEW2_USER_DATA_FOLDER: join(dataDir, "webview2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}${headed ? "" : " " + HEADLESS_BROWSER_ARGS}`,
  };
}

export async function waitForCdp(
  port: number,
  { timeoutMs = 30_000, proc }: { timeoutMs?: number; proc?: ReturnType<typeof spawnType> } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new Error(`app exited with code ${proc.exitCode} before WebView2 came up`);
    try {
      const targets: { type: string; url: string }[] = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page" && /tauri\.localhost|localhost:1420/.test(t.url))) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`WebView2 DevTools endpoint on port ${port} did not come up within ${timeoutMs}ms`);
}

export async function connect(cdpPort: number): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  // Playwright attaches to existing targets asynchronously, and the page may still be
  // on about:blank while WebView2 navigates, so poll briefly.
  const isApp = (p: Page) => /tauri\.localhost|localhost:1420/.test(p.url());
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find(isApp);
    if (page) return { browser, page };
    await new Promise((r) => setTimeout(r, 100));
  }
  const seen = browser.contexts().flatMap((c) => c.pages()).map((p) => p.url());
  await browser.close().catch(() => {});
  throw new Error(`PeetMail page not found over CDP (pages: ${JSON.stringify(seen)})`);
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

/**
 * Starts the app. Returns { page, browser, proc, dataDir, cdpPort, logPath, close }.
 * `dev: true` runs `pnpm tauri dev` (hot reload) instead of the prebuilt exe.
 */
export async function launchApp({ fake, dataDir, cdpPort, syncIntervalSecs, undoSendSecs, headed, dev = false, detached = false }: LaunchOptions): Promise<LaunchedApp> {
  dataDir ??= await mkdtemp(join(tmpdir(), "peetmail-test-"));
  mkdirSync(dataDir, { recursive: true });
  cdpPort ??= await freePort();
  const logPath = join(dataDir, "app-stdout.log");
  const env = { ...process.env, ...testEnv({ fake, dataDir, cdpPort, syncIntervalSecs, undoSendSecs, headed }) };

  const out = detached ? "ignore" : createWriteStream(logPath);
  const proc = dev
    ? spawn("pnpm tauri dev", { cwd: ROOT, env, shell: true, detached, stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"] })
    : spawn(EXE, [], { cwd: ROOT, env, detached, stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"] });
  if (!detached && typeof out !== "string") {
    proc.stdout?.pipe(out);
    proc.stderr?.pipe(out);
  } else {
    proc.unref();
  }

  try {
    await waitForCdp(cdpPort, { timeoutMs: dev ? 300_000 : 30_000, proc: detached ? undefined : proc });
  } catch (e) {
    killTree(proc.pid);
    throw e;
  }
  const { browser, page } = await connect(cdpPort);
  await page.waitForLoadState("domcontentloaded");
  await page.locator("body").waitFor();
  await waitForKeyboard(page);

  return {
    page,
    browser,
    proc,
    dataDir,
    cdpPort,
    logPath,
    async close() {
      await browser.close().catch(() => {});
      killTree(proc.pid);
    },
  };
}

/**
 * On the first launches of a freshly built exe, WebView2 silently drops keys sent over
 * DevTools for a while after the page loads (no keydown ever reaches the page). Press a
 * harmless key until the page sees it, so tests never type into the void.
 */
export async function waitForKeyboard(page: Page, timeoutMs = 20_000) {
  await page.evaluate(() => {
    const w = window as unknown as { __keyProbe?: boolean };
    w.__keyProbe = false;
    window.addEventListener("keydown", () => (w.__keyProbe = true), { capture: true, once: true });
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.keyboard.press("Shift"); // modifiers alone are ignored by the keymap
    if (await page.evaluate(() => (window as unknown as { __keyProbe?: boolean }).__keyProbe)) {
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`WebView2 never delivered keyboard input within ${timeoutMs}ms`);
}

/** What the app is showing right now, read from data-testid hooks. Used by drive and in error messages. */
export function screenState(page: Page) {
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector<HTMLElement>(s);
    const sel = q("[data-testid=thread-row][aria-selected=true]");
    return {
      view: q("[data-testid=setup]") ? "setup" : q("[data-testid=reader]") ? "reader" : q("[data-testid=thread-list]") ? "list" : "unknown",
      overlay: q("[data-testid=settings]") ? "settings" : q("[data-testid=shortcut-help]") ? "help" : null,
      selected: sel ? { conversationId: sel.dataset.conversationId, text: sel.innerText.replace(/\s+/g, " ").slice(0, 100) } : null,
      readerSubject: q("[data-testid=reader] h1")?.textContent ?? null,
      threadCount: q("[data-testid=thread-count]")?.textContent ?? null,
      sync: q("[data-testid=sync-status]")?.dataset.state ?? null,
      clientIdInput: (q("[data-testid=client-id-input]") as HTMLInputElement | null)?.value ?? null,
      error: q("[data-testid=app-error]")?.textContent ?? q("[data-testid=setup-error]")?.textContent ?? q("[data-testid=client-id-error]")?.textContent ?? null,
      focused: (document.activeElement as HTMLElement | null)?.dataset?.testid ?? document.activeElement?.tagName ?? null,
    };
  });
}

/** Waits for `locator`; on timeout the error includes the current screen state. */
async function waitOrExplain(page: Page, locator: ReturnType<Page["getByTestId"]>, what: string, timeout: number) {
  try {
    await locator.waitFor({ timeout });
  } catch {
    const state = await screenState(page).catch((e) => `unavailable: ${e}`);
    throw new Error(`timed out after ${timeout}ms waiting for ${what}; screen: ${JSON.stringify(state)}`);
  }
}

/** Drives the setup screen: enters the fake client ID (if asked) and signs in. */
export async function signIn(page: Page, clientId: string) {
  const input = page.getByTestId("client-id-input");
  const signInButton = page.getByTestId("sign-in");
  await waitOrExplain(page, input.or(signInButton).first(), "the setup screen", 15_000);
  if (await input.isVisible()) {
    await input.fill(clientId);
    await input.press("Enter");
  }
  await waitOrExplain(page, signInButton, "the sign-in button", 15_000);
  await page.keyboard.press("Enter");
  await waitOrExplain(page, page.getByTestId("inbox"), "the inbox after sign-in", 15_000);
}
