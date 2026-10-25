// Mouse paths: everything the keyboard does should be reachable by pointer too.
import { test, expect, row, selectedRow, snap, syncNow } from "./fixtures";

test("clicking a conversation opens it and the back button returns to the list", async ({ inbox: page }, testInfo) => {
  await row(page, "conv-plain").click();
  await expect(page.getByTestId("reader").locator("h1")).toHaveText("Weekend plans");
  await snap(page, testInfo, "reader-toolbar");
  await page.getByTestId("reader-back").click();
  await expect(page.getByTestId("thread-list")).toBeVisible();
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "conv-plain");
});

test("hover actions archive a conversation without opening it", async ({ inbox: page }, testInfo) => {
  const target = row(page, "conv-plain");
  await target.hover();
  await expect(target.getByTestId("row-actions")).toBeVisible();
  await snap(page, testInfo, "row-hover-actions");
  await target.getByTestId("row-archive").click();
  await expect(target).toHaveCount(0);
  await expect(page.getByTestId("thread-list")).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("Archived");
});

test("hover action toggles read state", async ({ inbox: page }) => {
  const target = row(page, "conv-invite");
  await expect(target).toHaveAttribute("data-unread", "true");
  await target.hover();
  await target.getByTestId("row-read").click();
  await expect(target).toHaveAttribute("data-unread", "false");
});

test("the reader toolbar does what the keys do", async ({ inbox: page }) => {
  const second = await page.getByTestId("thread-row").nth(1).textContent();
  await row(page, "conv-hostile").click();
  await page.getByTestId("reader-archive").click();
  await expect(page.getByTestId("reader").locator("h1")).not.toHaveText("Weird formatting in this one");
  expect(second).toContain(await page.getByTestId("reader").locator("h1").textContent());

  await page.getByTestId("reader-flag").click();
  await expect(page.getByTestId("reader-flag")).toHaveAttribute("title", "Unflag (S)");

  await page.getByTestId("reader-reply").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("compose-close").click();
  await expect(page.getByTestId("composer")).toHaveCount(0);

  await page.getByTestId("reader-next").click();
  await expect(page.getByTestId("reader").locator("h1")).toBeVisible();
});

test("header, footer and title bar buttons open compose, search, settings, help and the palette", async ({ inbox: page }) => {
  await page.getByTestId("header-compose").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("compose-close").click();

  await page.getByTestId("header-search").click();
  await expect(page.getByTestId("search-input")).toBeFocused();
  await page.getByTestId("search-close").click();
  await expect(page.getByTestId("splits")).toBeVisible();

  await page.getByTestId("footer-settings").click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.getByTestId("settings").click({ position: { x: 5, y: 5 } }); // backdrop closes it
  await expect(page.getByTestId("settings")).toHaveCount(0);

  await page.getByTestId("footer-help").click();
  await expect(page.getByTestId("shortcut-help")).toBeVisible();
  await page.getByTestId("shortcut-help").click({ position: { x: 5, y: 5 } });

  await page.getByTestId("footer-palette").click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette").click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("palette")).toHaveCount(0);

  await expect(page.getByTestId("titlebar-title")).toHaveText(/^Inbox \(\d+\)$/);
  await page.getByTestId("titlebar-command").click();
  await expect(page.getByTestId("palette")).toBeVisible();
  for (const id of ["window-minimize", "window-maximize", "window-close"]) await expect(page.getByTestId(id)).toBeVisible();
});

test("the mouse back button steps back out of the reader", async ({ inbox: page }) => {
  await row(page, "conv-plain").click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true })));
  await expect(page.getByTestId("thread-list")).toBeVisible();
});

test("remote images can be loaded with a click", async ({ inbox: page, fake }) => {
  const { ids } = await fake.control("deliver", { subject: "Pics", body: `<p>Look</p><img src="${fake.origin}/img/a.png" width="10">` });
  await syncNow(page, fake);
  await row(page, `conv-${ids[0]}`).click();
  await page.getByTestId("load-images").click();
  await expect(page.frameLocator("[data-testid=message-body]").first().locator("img")).toHaveAttribute("src", /^data:image\/png/);
});
