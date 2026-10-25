import { test, expect, DEFAULT_CONVERSATIONS, inboxConversations, row, snap } from "./fixtures";
import type { Page } from "@playwright/test";

async function search(page: Page, text: string) {
  await page.keyboard.press("/");
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();
  await input.fill(text);
  return input;
}

test("/ searches all mail, including Sent, and Esc returns to the split", async ({ inbox: page }, testInfo) => {
  // Quotes make it a phrase; bare words match as prefixes ("quick" would hit "Quick one").
  await search(page, '"quick question"');
  await expect(page.getByTestId("thread-count")).toHaveText("3 conversations");
  await snap(page, testInfo, "search-results");
  await page.getByTestId("search-input").press("Escape");
  await expect(page.getByTestId("splits")).toBeVisible();
  await expect(page.getByTestId("thread-count")).toHaveText(`${DEFAULT_CONVERSATIONS} conversations`);
});

test("query terms filter by sender and type", async ({ inbox: page }) => {
  await search(page, "is:invite");
  await expect(page.getByTestId("thread-row")).toHaveCount(1);
  await expect(row(page, "conv-invite")).toHaveCount(1);

  await page.getByTestId("search-input").fill("from:github.com");
  await expect(page.getByTestId("thread-row").first()).toContainText("GitHub");
  const senders = await page.getByTestId("thread-row").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""));
  expect(senders.every((t) => t.includes("GitHub"))).toBe(true);
});

test("Enter moves from the search box to the results", async ({ inbox: page }) => {
  await search(page, "offsite");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("search-input")).not.toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("reader").locator("h1")).toContainText("Offsite agenda");
});

test("prefetched bodies are searchable without opening them", async ({ inbox: page }) => {
  // "Chart below" is only in msg-attach's body, not its subject or preview.
  await search(page, '"chart below"');
  await expect(page.getByTestId("thread-row")).toHaveCount(1);
  await expect(row(page, "conv-attach")).toHaveCount(1);
});

test("Tab cycles split inboxes", async ({ inbox: page }) => {
  const tabs = page.getByTestId("split-tab");
  await expect(tabs).toHaveText([/Important/, /Other/]);
  await page.keyboard.press("Tab");
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("thread-count")).toHaveText(`${inboxConversations((m) => m.inferenceClassification === "other")} conversations`);
  await page.keyboard.press("Shift+Tab");
  await expect(tabs.nth(0)).toHaveAttribute("data-active", "true");
});

test("a custom split from Settings shows up as a tab", async ({ inbox: page }, testInfo) => {
  await page.keyboard.press("Control+,");
  await page.getByTestId("split-add").click();
  await page.getByTestId("split-name").last().fill("Invites");
  await page.getByTestId("split-query").last().fill("is:invite");
  await page.getByTestId("split-save").click();
  await snap(page, testInfo, "split-editor");
  await page.keyboard.press("Escape");
  const tabs = page.getByTestId("split-tab");
  await expect(tabs).toHaveCount(3);
  await tabs.nth(2).click();
  await expect(page.getByTestId("thread-row")).toHaveCount(1);
  await expect(row(page, "conv-invite")).toHaveCount(1);
});

test("Ctrl+K runs any command by name", async ({ inbox: page }, testInfo) => {
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  await expect(input).toBeFocused();
  await input.fill("arch");
  await expect(page.getByTestId("palette-item").first()).toContainText("Archive");
  await snap(page, testInfo, "palette");
  await input.press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(row(page, "conv-hostile")).toHaveCount(0);
});
