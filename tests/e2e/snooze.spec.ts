import { test, expect, row, selectedRow, selectWithKeys, snap, syncNow } from "./fixtures";
import type { Page } from "@playwright/test";

type Fake = Parameters<Parameters<typeof test>[2]>[0]["fake"];

const moves = (fake: Fake) => fake.state.sent.filter((s: Record<string, any>) => s.kind === "move");
const folderCreates = (fake: Fake) => fake.state.sent.filter((s: Record<string, any>) => s.kind === "create-folder");
const folderOf = async (fake: Fake, id: string) => (await fake.control(`message?id=${id}`)).parentFolderId as string;

async function select(page: Page, conversationId: string) {
  await selectWithKeys(page, conversationId);
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", conversationId);
}

/** Snoozes through the backend, to a time a test can wait for. */
async function snoozeFor(page: Page, conversationId: string, ms: number) {
  const until = new Date(Date.now() + ms).toISOString();
  await page.evaluate(
    ({ conversationId, until }) => (window as any).__TAURI_INTERNALS__.invoke("snooze_thread", { accountId: 1, conversationId, until }),
    { conversationId, until },
  );
}

test("h snoozes a conversation into a hidden server folder; g h lists it; a sync doesn't bring it back", async ({ inbox: page, fake }, testInfo) => {
  await select(page, "conv-plain");
  await page.keyboard.press("h");
  await expect(page.getByTestId("snooze")).toBeVisible();
  await expect(page.getByTestId("snooze-preset").filter({ hasText: "Tomorrow" })).toBeVisible();
  await snap(page, testInfo, "snooze-picker");
  await page.getByTestId("snooze-preset").and(page.locator("[data-id=tomorrow]")).click();

  await expect(page.getByTestId("snooze")).toHaveCount(0);
  await expect(row(page, "conv-plain")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Snoozed until tomorrow, 8:00");

  // Server side: one hidden folder, created once, and the message moved into it.
  await expect.poll(() => folderOf(fake, "msg-plain"), { timeout: 10_000 }).toBe("folder-1");
  expect(folderCreates(fake)).toEqual([expect.objectContaining({ displayName: "PeetMail Snoozed", isHidden: true })]);

  await syncNow(page, fake);
  await expect(row(page, "conv-plain")).toHaveCount(0);

  // A second snooze reuses the folder.
  await select(page, "conv-hostile");
  await page.keyboard.press("h");
  await page.getByTestId("snooze-preset").and(page.locator("[data-id=nextweek]")).click();
  await expect.poll(() => folderOf(fake, "msg-hostile"), { timeout: 10_000 }).toBe("folder-1");
  expect(folderCreates(fake)).toHaveLength(1);

  await page.keyboard.press("g");
  await page.keyboard.press("h");
  const rows = page.getByTestId("snoozed-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-conversation-id", "conv-plain"); // soonest back first
  await expect(page.getByTestId("snoozed-until").first()).toContainText("tomorrow");
  await snap(page, testInfo, "snoozed-list");
});

test("z undoes a snooze before it reaches the server", async ({ inbox: page, fake }) => {
  await select(page, "conv-plain");
  await page.keyboard.press("h");
  await page.getByTestId("snooze-preset").and(page.locator("[data-id=tomorrow]")).click();
  await expect(row(page, "conv-plain")).toHaveCount(0);
  await page.keyboard.press("z");
  await expect(row(page, "conv-plain")).toHaveCount(1);
  await page.waitForTimeout(2500);
  expect(moves(fake)).toEqual([]);
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page.getByTestId("snoozed-empty")).toBeVisible();
});

test("a typed time works too", async ({ inbox: page }) => {
  await select(page, "conv-plain");
  await page.keyboard.press("h");
  await page.getByTestId("snooze-input").fill("whenever");
  await expect(page.getByTestId("snooze-hint")).toBeVisible();
  await page.getByTestId("snooze-input").fill("in 2 hours");
  await expect(page.getByTestId("snooze-when")).toContainText("Until");
  await page.keyboard.press("Enter");
  await expect(row(page, "conv-plain")).toHaveCount(0);
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page.getByTestId("snoozed-row")).toHaveCount(1);
});

test("when it's due, it comes back to the top of the inbox, unread, marked as a reminder", async ({ inbox: page, fake }) => {
  // conv-plain is read and not the newest conversation.
  await expect(row(page, "conv-plain")).toBeVisible();
  await expect(page.getByTestId("thread-row").first()).not.toHaveAttribute("data-conversation-id", "conv-plain");
  await snoozeFor(page, "conv-plain", 3000);
  await expect(row(page, "conv-plain")).toHaveCount(0);
  await expect.poll(() => folderOf(fake, "msg-plain"), { timeout: 10_000 }).toBe("folder-1");

  await expect(page.getByTestId("thread-row").first()).toHaveAttribute("data-conversation-id", "conv-plain", { timeout: 10_000 });
  await expect(row(page, "conv-plain").getByTestId("thread-reminder")).toBeVisible();
  await expect.poll(() => folderOf(fake, "msg-plain"), { timeout: 10_000 }).toBe("AAMkAGI2-inbox");
  await expect.poll(async () => (await fake.control("message?id=msg-plain")).isRead, { timeout: 10_000 }).toBe(false);

  // It stays on top through a sync.
  await syncNow(page, fake);
  await expect(page.getByTestId("thread-row").first()).toHaveAttribute("data-conversation-id", "conv-plain");
});

test("from the snoozed list: Enter reads it without waking it, u brings it back now", async ({ inbox: page }) => {
  await select(page, "conv-plain");
  await page.keyboard.press("h");
  await page.getByTestId("snooze-preset").and(page.locator("[data-id=tomorrow]")).click();
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page.getByTestId("snoozed-row")).toHaveCount(1); // loaded, so Enter has a row to open
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("reader")).toHaveAttribute("data-conversation-id", "conv-plain");
  await page.keyboard.press("Escape");
  await expect(row(page, "conv-plain")).toHaveCount(0);

  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page.getByTestId("snoozed-row")).toHaveCount(1);
  await page.keyboard.press("u");
  await expect(page.getByTestId("toast")).toContainText("Back in your inbox");
  await expect(page.getByTestId("snoozed-empty")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thread-row").first()).toHaveAttribute("data-conversation-id", "conv-plain");
});

test("snoozing from the reader moves on to the next conversation", async ({ inbox: page }) => {
  await select(page, "conv-plain");
  const next = await page.getByTestId("thread-row").nth(1 + (await selectedIndex(page))).getAttribute("data-conversation-id");
  await page.keyboard.press("Enter");
  await page.keyboard.press("h");
  await page.getByTestId("snooze-preset").and(page.locator("[data-id=tomorrow]")).click();
  await expect(page.getByTestId("reader")).toHaveAttribute("data-conversation-id", next!);
});

async function selectedIndex(page: Page) {
  const ids = await page.getByTestId("thread-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-conversation-id")));
  const sel = await selectedRow(page).getAttribute("data-conversation-id");
  return ids.indexOf(sel);
}
