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
  await expect(tabs).toHaveText([/Inbox/, /Other/]);
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
  await expect(tabs).toHaveText([/Inbox/, /Other/, /Invites/]);
  await tabs.nth(2).click();
  await expect(page.getByTestId("thread-row")).toHaveCount(1);
  await expect(row(page, "conv-invite")).toHaveCount(1);
  // The invite moved out of Inbox: every message lives in exactly one tab.
  await tabs.nth(0).click();
  await expect(page.getByTestId("thread-count")).toHaveText(`${DEFAULT_CONVERSATIONS - 1} conversations`);
  await expect(row(page, "conv-invite")).toHaveCount(0);
});

test("mail that matches no split stays in Inbox, and the first matching split wins", async ({ inbox: page }, testInfo) => {
  // Replace the defaults with splits that don't cover everything (the reported case).
  await page.keyboard.press("Control+,");
  const editor = page.getByTestId("split-editor");
  await editor.getByTestId("split-name").first().fill("GitHub");
  await editor.getByTestId("split-query").first().fill("from:github.com");
  await page.getByTestId("split-add").click();
  await editor.getByTestId("split-name").last().fill("Notifications");
  await editor.getByTestId("split-query").last().fill("is:other");
  await page.getByTestId("split-save").click();
  await page.keyboard.press("Escape");

  const tabs = page.getByTestId("split-tab");
  await expect(tabs).toHaveText([/Inbox/, /GitHub/, /Notifications/]);
  // Inbox still has everything the splits don't claim.
  await expect(page.getByTestId("thread-count")).toHaveText(`${DEFAULT_CONVERSATIONS} conversations`);
  await snap(page, testInfo, "inbox-with-custom-splits");

  // GitHub mail is also "other", but GitHub comes first, so Notifications doesn't show it.
  await tabs.nth(1).click();
  await expect(page.getByTestId("thread-row").first()).toContainText("GitHub");
  await tabs.nth(2).click();
  await expect(tabs.nth(2)).toHaveAttribute("data-active", "true");
  // Poll: right after the click the GitHub tab's rows are still on screen.
  const rows = page.getByTestId("thread-row");
  await expect
    .poll(async () => {
      const texts = await rows.evaluateAll((els) => els.map((r) => r.textContent ?? ""));
      return texts.length > 0 && !texts.some((t) => t.includes("GitHub"));
    })
    .toBe(true);
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

test("empty splits can be hidden; the tab you're on stays until you leave it", async ({ inbox: page }, testInfo) => {
  await page.keyboard.press("Control+,");
  const editor = page.getByTestId("split-editor");
  for (const [name, query] of [["Invites", "is:invite"], ["Nobody", "from:nobody@nowhere.test"]]) {
    await page.getByTestId("split-add").click();
    await editor.getByTestId("split-name").last().fill(name);
    await editor.getByTestId("split-query").last().fill(query);
  }
  await page.getByTestId("split-save").click();
  await page.getByTestId("hide-empty-splits").check();
  await snap(page, testInfo, "hide-empty-option");
  await page.keyboard.press("Escape");

  const tabs = page.getByTestId("split-tab");
  await expect(tabs).toHaveText([/Inbox/, /Other/, /Invites/]);

  // Two quick Tabs land on Invites, and the list shows Invites' mail (not a late reply for Other).
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(tabs.nth(2)).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("thread-row")).toHaveCount(1);
  await expect(row(page, "conv-invite")).toHaveCount(1);

  // Archiving the only invite empties the tab you're on; it stays put...
  await page.keyboard.press("e");
  await expect(row(page, "conv-invite")).toHaveCount(0);
  await expect(tabs).toHaveText([/Inbox/, /Other/, /Invites/]);
  // ...and disappears once you move on.
  await page.keyboard.press("Tab");
  await expect(tabs).toHaveText([/Inbox/, /Other/]);
  await expect(tabs.nth(0)).toHaveAttribute("data-active", "true");

  // Turning the option off brings empty splits back.
  await page.keyboard.press("Control+,");
  await page.getByTestId("hide-empty-splits").uncheck();
  await page.keyboard.press("Escape");
  await expect(tabs).toHaveText([/Inbox/, /Other/, /Invites/, /Nobody/]);
});
