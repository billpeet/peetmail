import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, row, snap, syncNow } from "./fixtures";

test("inline cid: images render from the message's attachments", async ({ inbox: page }) => {
  await row(page, "conv-attach").click();
  await page.keyboard.press("Enter");
  const img = page.frameLocator("[data-testid=message-body]").first().locator("img");
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
});

test("attachments are listed and download to disk", async ({ inbox: page, app }, testInfo) => {
  await row(page, "conv-attach").click();
  await page.keyboard.press("Enter");
  const chip = page.getByTestId("attachment");
  await expect(chip).toHaveCount(1); // the inline chart isn't listed
  await expect(chip).toContainText("Q4 plan.pdf");
  await snap(page, testInfo, "attachments");
  await chip.click();
  await expect(page.getByTestId("toast")).toContainText("Saved Q4 plan.pdf");
  expect(await readFile(join(app.dataDir, "downloads", "Q4 plan.pdf"), "utf8")).toBe("%PDF-1.4 fake plan");
});

test("i loads remote images through the app, never from the page", async ({ inbox: page, fake }, testInfo) => {
  const { ids } = await fake.control("deliver", {
    subject: "Photos from Saturday",
    body: `<p>Look!</p><img src="${fake.origin}/img/hero.png" width="20">`,
  });
  await syncNow(page, fake);
  await row(page, `conv-${ids[0]}`).click();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("images-blocked")).toBeVisible();
  const img = page.frameLocator("[data-testid=message-body]").first().locator("img");
  await expect(img).toHaveAttribute("src", /\/img\/hero\.png$/);
  expect(fake.state.requests.filter((r) => r.path.startsWith("/img/"))).toEqual([]);

  await page.keyboard.press("i");
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.getByTestId("images-blocked")).toHaveCount(0);
  expect(fake.state.requests.filter((r) => r.path === "/img/hero.png")).toHaveLength(1);
  await snap(page, testInfo, "images-loaded");
});
