// Playwright fixtures: every test gets a fresh fake Graph server and a fresh app
// instance with its own data dir and WebView2 profile.
//
//   fake   the in-process fake server (control API: fake.control("deliver", {...}))
//   app    launched app handle ({ page, dataDir, logPath, ... }), not signed in
//   page   the app's WebView2 page (overrides Playwright's built-in browser page)
//   inbox  the page after signing in and finishing the first sync
//
// After each test a final screenshot and the app log are attached to the report.

import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startFakeGraph } from "../harness/fake-graph.ts";
import { startFakePair } from "../harness/fake-pair.ts";
import { launchApp, signIn } from "../harness/app.ts";
import { defaultMailbox, FOLDER_IDS } from "../harness/fixtures.ts";

type Fake = Awaited<ReturnType<typeof startFakeGraph>>;
type Pair = Awaited<ReturnType<typeof startFakePair>>;
type App = Awaited<ReturnType<typeof launchApp>>;

export const test = base.extend<{ fake: Fake; app: App; page: Page; inbox: Page; undoSendSecs: number; secondAccount: boolean; pair: Pair }>({
  /** Serve a second mailbox too (`test.use({ secondAccount: true })`), then use `pair`. */
  secondAccount: [false, { option: true }],
  /** The two-mailbox fake (only with secondAccount): `pair.second`, `pair.signInAs("b")`. */
  pair: async ({ fake, secondAccount }, use) => {
    if (!secondAccount) throw new Error("the pair fixture needs test.use({ secondAccount: true })");
    await use(fake as Pair);
  },
  /** Undo-send delay for this test's app (`test.use({ undoSendSecs: 3 })`); 0 sends at once. */
  undoSendSecs: [0, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  fake: async ({ secondAccount }, use) => {
    const fake = secondAccount ? await startFakePair() : await startFakeGraph();
    await use(fake);
    await fake.close();
  },

  app: async ({ fake, undoSendSecs }, use, testInfo) => {
    const app = await launchApp({ fake, undoSendSecs });
    const consoleLines: string[] = [];
    app.page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    app.page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.stack ?? e.message}`));
    await use(app);
    if (consoleLines.length) await testInfo.attach("console.log", { body: consoleLines.join("\n"), contentType: "text/plain" });
    const shot = await app.page.screenshot().catch(() => null);
    if (shot) await testInfo.attach("final-screen.png", { body: shot, contentType: "image/png" });
    const log = await readFile(app.logPath, "utf8").catch(() => "");
    if (log) await testInfo.attach("app.log", { body: log, contentType: "text/plain" });
    await app.close();
  },

  page: async ({ app }, use) => {
    await use(app.page);
  },

  inbox: async ({ app, fake }, use) => {
    await signIn(app.page, fake.clientId);
    await waitForSyncIdle(app.page);
    // Background body prefetch runs after the first sync; let it finish so tests that
    // count requests see only their own traffic.
    await waitForQuiet(fake);
    await use(app.page);
  },
});

export { expect };

/** Default cache window in the app (state.rs DEFAULT_CACHE_DAYS). */
export const CACHE_DAYS = 90;

/** Conversations in the inbox matching `pred`, inside the cache window (mirrors the app's SQL). */
export function inboxConversations(pred: (m: ReturnType<typeof defaultMailbox>[number]) => boolean = () => true) {
  const cutoff = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
  return new Set(
    defaultMailbox()
      .filter((m) => m.parentFolderId === FOLDER_IDS.inbox && m.receivedDateTime >= cutoff && pred(m))
      .map((m) => m.conversationId),
  ).size;
}

/** What the default view (the built-in Inbox tab: everything the default Other split doesn't claim) shows after a fresh sync. */
export const DEFAULT_CONVERSATIONS = inboxConversations((m) => m.inferenceClassification === "focused");

export async function waitForSyncIdle(page: Page) {
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
}

/** Waits until the fake has received no requests for `quietMs`. */
export async function waitForQuiet(fake: Fake, quietMs = 400, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = fake.state.requests.length;
  let since = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const n = fake.state.requests.length;
    if (n !== last) {
      last = n;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
  throw new Error(`fake server still busy after ${timeoutMs}ms`);
}

/** GETs of one message's body. */
export function bodyRequests(fake: Fake, messageId: string, since = 0) {
  return fake.requestsSince(since).filter((r) => r.method === "GET" && r.path === `/v1.0/me/messages/${messageId}`);
}

/** Presses Ctrl+R and waits until the app has made a delta request and gone idle again. */
export async function syncNow(page: Page, fake: Fake) {
  const before = fake.state.requests.length;
  await page.keyboard.press("Control+r");
  await expect.poll(() => fake.requestsSince(before).some((r) => r.path.endsWith("/delta") && r.status === 200)).toBe(true);
  await waitForSyncIdle(page);
}

export function row(page: Page, conversationId: string) {
  return page.locator(`[data-testid=thread-row][data-conversation-id="${conversationId}"]`);
}

export function selectedRow(page: Page) {
  return page.locator("[data-testid=thread-row][aria-selected=true]");
}

/**
 * Jumps to the top (g g), then moves down with j until `conversationId` is selected, without opening it
 * (a click opens the conversation, which also marks it read).
 */
export async function selectWithKeys(page: Page, conversationId: string) {
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  for (let i = 0; i < 300; i++) {
    if ((await selectedRow(page).getAttribute("data-conversation-id")) === conversationId) return;
    await page.keyboard.press("j");
  }
  throw new Error(`couldn't reach ${conversationId} with j`);
}

export function messageBody(page: Page, nth = 0) {
  return page.frameLocator("[data-testid=message-body]").nth(nth);
}

/** Attaches a named screenshot to the report mid-test. */
export async function snap(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(`${name}.png`, { body: await page.screenshot(), contentType: "image/png" });
}
