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

test("the right pane resizes by dragging its edge, remembers the width, and resets on double-click", async ({ inbox: page }, testInfo) => {
  const pane = page.getByTestId("right-pane");
  const handle = page.getByTestId("pane-resize");
  const width = async () => Number(await pane.getAttribute("data-width"));
  expect(await width()).toBe(320);

  // Drag the left edge 150px further left: the pane grows by 150.
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 200;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 75, y, { steps: 5 });
  await page.mouse.move(x - 150, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(width).toBe(470);
  expect(Math.round((await pane.boundingBox())!.width)).toBe(470);
  await snap(page, testInfo, "wide-pane");

  // Saved: still 470 after a reload.
  await page.reload();
  await expect(page.getByTestId("thread-row").first()).toBeVisible();
  await expect.poll(width).toBe(470);

  // Can't shrink below the minimum.
  const box2 = (await handle.boundingBox())!;
  await page.mouse.move(box2.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box2.x + 900, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(width).toBe(240);

  // Keyboard: focus the handle, arrows widen/narrow; double-click resets.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBe(256);
  await handle.dblclick();
  await expect.poll(width).toBe(320);
});
