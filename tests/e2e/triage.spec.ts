import { test, expect, row, selectedRow, selectWithKeys, snap, syncNow } from "./fixtures";
import type { Page } from "@playwright/test";

type Fake = Parameters<Parameters<typeof test>[2]>[0]["fake"];

/** Server-side copy of a message (folder, read state, flag). */
const serverMessage = (fake: Fake, id: string) => fake.control(`message?id=${id}`);
const folderOf = async (fake: Fake, id: string) => (await serverMessage(fake, id)).parentFolderId as string;

async function selectConversation(page: Page, conversationId: string) {
  await selectWithKeys(page, conversationId);
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", conversationId);
}

test("e archives instantly, syncs after the grace period, and z brings it back", async ({ inbox: page, fake }, testInfo) => {
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "conv-hostile");
  await page.keyboard.press("e");
  await expect(row(page, "conv-hostile")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Archived");
  await snap(page, testInfo, "archived-toast");

  await expect.poll(() => folderOf(fake, "msg-hostile"), { timeout: 10_000 }).toBe("AAMkAGI2-archive");

  await page.keyboard.press("z");
  await expect(row(page, "conv-hostile")).toHaveCount(1);
  await expect.poll(() => folderOf(fake, "msg-hostile"), { timeout: 10_000 }).toBe("AAMkAGI2-inbox");
});

test("undo inside the grace period never reaches the server", async ({ inbox: page, fake }) => {
  await page.keyboard.press("e");
  await expect(row(page, "conv-hostile")).toHaveCount(0);
  await page.keyboard.press("z");
  await expect(row(page, "conv-hostile")).toHaveCount(1);
  await page.waitForTimeout(3000);
  expect(fake.state.sent.filter((s) => s.kind === "move")).toEqual([]);
});

test("# moves the conversation to Deleted Items", async ({ inbox: page, fake }) => {
  await selectConversation(page, "conv-plain");
  await page.keyboard.press("#");
  await expect(row(page, "conv-plain")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Deleted");
  await expect.poll(() => folderOf(fake, "msg-plain"), { timeout: 10_000 }).toBe("AAMkAGI2-deleted");
});

test("u toggles read state locally and on the server", async ({ inbox: page, fake }) => {
  await selectConversation(page, "conv-invite");
  await expect(row(page, "conv-invite")).toHaveAttribute("data-unread", "true");
  await page.keyboard.press("u");
  await expect(row(page, "conv-invite")).toHaveAttribute("data-unread", "false");
  await expect.poll(async () => (await serverMessage(fake, "msg-invite")).isRead, { timeout: 10_000 }).toBe(true);

  await page.keyboard.press("u");
  await expect(row(page, "conv-invite")).toHaveAttribute("data-unread", "true");
  await expect.poll(async () => (await serverMessage(fake, "msg-invite")).isRead, { timeout: 10_000 }).toBe(false);
});

test("s flags the newest message", async ({ inbox: page, fake }) => {
  await page.keyboard.press("s");
  await expect(selectedRow(page).locator("[title=Flagged]")).toBeVisible();
  await expect.poll(async () => (await serverMessage(fake, "msg-hostile")).flag.flagStatus, { timeout: 10_000 }).toBe("flagged");
});

test("opening a conversation marks it read without an undo entry", async ({ inbox: page, fake }) => {
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect.poll(async () => (await serverMessage(fake, "msg-hostile")).isRead, { timeout: 10_000 }).toBe(true);
  await page.keyboard.press("z");
  await expect(page.getByTestId("toast")).toContainText("Nothing to undo");
});

test("archiving in the reader moves on to the next conversation", async ({ inbox: page }) => {
  const second = await page.getByTestId("thread-row").nth(1).getAttribute("data-conversation-id");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("reader").locator("h1")).toHaveText("Weird formatting in this one");
  await page.keyboard.press("e");
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(selectedRow(page)).toHaveCount(0); // list isn't rendered in the reader
  await page.keyboard.press("Escape");
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", second!);
});

test("a stale delta can't undo a change that's still queued", async ({ inbox: page, fake }) => {
  await selectConversation(page, "conv-invite");
  await page.keyboard.press("u"); // mark read locally; queued for 2s
  // Meanwhile the server reports the (old) unread state through delta.
  await fake.control("update", { id: "msg-invite", fields: { isRead: false, subject: "Invitation: Design review (moved)" } });
  await syncNow(page, fake);
  await expect(row(page, "conv-invite")).toHaveAttribute("data-unread", "false");
  await expect.poll(async () => (await serverMessage(fake, "msg-invite")).isRead, { timeout: 10_000 }).toBe(true);
});

test("a rejected write shows an error and counts as failed", async ({ inbox: page, fake }) => {
  await fake.control("config", { failWrites: 403 });
  await page.keyboard.press("e");
  await expect(page.getByTestId("toast")).toContainText("Couldn't sync a change", { timeout: 10_000 });
  await expect(page.getByTestId("outbox-failed")).toHaveText("1 failed");
});
