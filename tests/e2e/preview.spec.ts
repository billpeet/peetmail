import { test, expect, row, selectedRow, snap } from "./fixtures";

const previewTitle = (page: import("@playwright/test").Page) => page.getByTestId("preview-pane").locator("h1");

test("v switches to list + reading pane, j/k update the preview, and the choice is saved", async ({ inbox: page }, testInfo) => {
  const main = page.getByTestId("main");
  await expect(main).toHaveAttribute("data-layout", "list");
  await page.keyboard.press("v");
  await expect(main).toHaveAttribute("data-layout", "preview");
  await expect(previewTitle(page)).toHaveText("Weird formatting in this one");
  await page.keyboard.press("j");
  await expect(previewTitle(page)).toHaveText("Q4 plan attached");
  await expect(page.getByTestId("thread-list")).toBeVisible();
  await snap(page, testInfo, "preview-layout");

  await page.reload();
  await expect(page.getByTestId("thread-row").first()).toBeVisible();
  await expect(main).toHaveAttribute("data-layout", "preview");

  await page.getByTestId("toggle-layout").click();
  await expect(main).toHaveAttribute("data-layout", "list");
  await expect(page.getByTestId("preview-pane")).toHaveCount(0);
});

test("previewing marks read only after you stay on a conversation", async ({ inbox: page }) => {
  await page.keyboard.press("v");
  // Skim straight past the first (unread) conversation.
  await page.keyboard.press("j");
  await page.keyboard.press("j"); // lands on the unread invite
  await expect(previewTitle(page)).toHaveText("Invitation: Design review (Thu 10am)");
  await page.waitForTimeout(2200);
  await expect(row(page, "conv-invite")).toHaveAttribute("data-unread", "false");
  await expect(row(page, "conv-hostile")).toHaveAttribute("data-unread", "true");
  // Dwelling also counts as opening it.
  await expect(page.locator('[data-testid=recent-item][data-conversation-id="conv-invite"]')).toBeVisible();
  await expect(page.locator('[data-testid=recent-item][data-conversation-id="conv-hostile"]')).toHaveCount(0);
});

test("click previews, Enter opens full width, Esc returns to the split", async ({ inbox: page }) => {
  await page.keyboard.press("v");
  await row(page, "conv-plain").click();
  await expect(previewTitle(page)).toHaveText("Weekend plans");
  await expect(page.getByTestId("thread-list")).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-list")).toHaveCount(0);
  await expect(page.getByTestId("reader").locator("h1")).toHaveText("Weekend plans");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thread-list")).toBeVisible();
  await expect(previewTitle(page)).toHaveText("Weekend plans");

  await page.getByTestId("reader-expand").click();
  await expect(page.getByTestId("thread-list")).toHaveCount(0);
});

test("archiving in the preview moves on to the next conversation", async ({ inbox: page }) => {
  await page.keyboard.press("v");
  const second = (await page.getByTestId("thread-row").nth(1).getAttribute("data-conversation-id"))!;
  await page.keyboard.press("e");
  await expect(row(page, "conv-hostile")).toHaveCount(0);
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", second);
  await expect(previewTitle(page)).toHaveText("Q4 plan attached");
});

test("the list in the preview layout is resizable and remembers its width", async ({ inbox: page }) => {
  await page.keyboard.press("v");
  const list = page.getByTestId("preview-list");
  const width = async () => Number(await list.getAttribute("data-width"));
  expect(await width()).toBe(420);
  const box = (await page.getByTestId("list-resize").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 300;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(width).toBe(320);
  await page.reload();
  await expect(page.getByTestId("thread-row").first()).toBeVisible();
  await expect.poll(width).toBe(320);
});
