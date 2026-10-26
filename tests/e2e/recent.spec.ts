import { test, expect, row, snap } from "./fixtures";

const recentIds = (page: import("@playwright/test").Page) =>
  page.getByTestId("recent-item").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.conversationId));

test("opened conversations show in Recent Opens, newest first, and reopen on click", async ({ inbox: page }, testInfo) => {
  await expect(page.getByTestId("recent-empty")).toBeVisible();

  await row(page, "conv-plain").click();
  await page.getByTestId("reader-back").click();
  await row(page, "conv-hostile").click();
  await page.getByTestId("reader-back").click();

  await expect.poll(() => recentIds(page)).toEqual(["conv-hostile", "conv-plain"]);
  await expect(page.getByTestId("right-pane")).toContainText("Last 7 days");
  await snap(page, testInfo, "recent-opens");

  await page.locator('[data-testid=recent-item][data-conversation-id="conv-plain"]').click();
  await expect(page.getByTestId("reader").locator("h1")).toHaveText("Weekend plans");
  // Reopening moves it back to the top.
  await expect.poll(() => recentIds(page)).toEqual(["conv-plain", "conv-hostile"]);
});

test("Recent Opens reopens a conversation that's no longer in the list", async ({ inbox: page }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("e"); // archive; the reader moves on
  await page.getByTestId("reader-back").click();
  await expect(row(page, "conv-plain")).toHaveCount(0);

  await page.locator('[data-testid=recent-item][data-conversation-id="conv-plain"]').click();
  await expect(page.getByTestId("reader").locator("h1")).toHaveText("Weekend plans");
  await expect(page.getByTestId("reader-toolbar")).toContainText("From Recent Opens");
  await page.getByTestId("reader-back").click();
  await expect(page.getByTestId("thread-list")).toBeVisible();
});

test("\ toggles the pane, and both the choice and the history survive a reload", async ({ inbox: page }) => {
  await row(page, "conv-plain").click();
  await page.getByTestId("reader-back").click();
  await expect(page.getByTestId("right-pane")).toBeVisible();

  await page.keyboard.press("\\");
  await expect(page.getByTestId("right-pane")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("thread-row").first()).toBeVisible();
  await expect(page.getByTestId("right-pane")).toHaveCount(0);

  await page.getByTestId("toggle-pane").click();
  await expect(page.getByTestId("right-pane")).toBeVisible();
  await expect.poll(() => recentIds(page)).toEqual(["conv-plain"]);
});
