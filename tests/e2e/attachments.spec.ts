import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  // Blocked images carry no live src at all, so the page never even attempts the request
  // (each attempt costs a CSP violation; 300 of them added ~120ms to a newsletter).
  await expect(img).toHaveAttribute("data-remote-src", /\/img\/hero\.png$/);
  await expect(img).not.toHaveAttribute("src", /.+/);
  expect(fake.state.requests.filter((r) => r.path.startsWith("/img/"))).toEqual([]);

  await page.keyboard.press("i");
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.getByTestId("images-blocked")).toHaveCount(0);
  expect(fake.state.requests.filter((r) => r.path === "/img/hero.png")).toHaveLength(1);
  await snap(page, testInfo, "images-loaded");
});

test("double-clicking an attachment opens it, without saving a copy to Downloads", async ({ inbox: page, app }) => {
  await row(page, "conv-attach").click();
  await page.keyboard.press("Enter");
  await page.getByTestId("attachment").dblclick();
  await expect(page.getByTestId("toast")).toContainText("Opening Q4 plan.pdf");
  // The app opened a copy in its temp folder (tests log the path instead of launching an app).
  const opened = await readFile(join(app.dataDir, "opened.txt"), "utf8").then((t) => t.trim().split("\n").at(-1)!);
  expect(basename(opened)).toBe("Q4 plan.pdf");
  expect(dirname(dirname(opened)).endsWith(join("PeetMail", "attachments"))).toBe(true);
  expect(await readFile(opened, "utf8")).toBe("%PDF-1.4 fake plan");
  // Marked as downloaded from the internet, so Office opens it in Protected View.
  expect(await readFile(`${opened}:Zone.Identifier`, "utf8")).toContain("ZoneId=3");
  // Let the single click's wait pass: nothing lands in Downloads.
  await page.waitForTimeout(800);
  expect(await readdir(join(app.dataDir, "downloads")).catch(() => [])).toEqual([]);

  // Opening it again reuses the same file.
  await page.getByTestId("attachment").dblclick();
  await expect.poll(() => readFile(join(app.dataDir, "opened.txt"), "utf8").then((t) => t.trim().split("\n"))).toEqual([opened, opened]);
});

test("a program attached to a message isn't opened by a double-click, but can still be saved", async ({ inbox: page, fake, app }) => {
  const { ids } = await fake.control("deliver", { subject: "Your invoice", attachments: [{ name: "invoice.pdf.exe", text: "MZ not really" }] });
  await syncNow(page, fake);
  await row(page, `conv-${ids[0]}`).click();
  await page.keyboard.press("Enter");
  await page.getByTestId("attachment").dblclick();
  await expect(page.getByTestId("toast")).toContainText("doesn't open .exe files directly");
  expect(await readFile(join(app.dataDir, "opened.txt"), "utf8").catch(() => "")).toBe("");
  await page.getByTestId("attachment").click();
  await expect.poll(() => readdir(join(app.dataDir, "downloads")).catch(() => [])).toEqual(["invoice.pdf.exe"]);
});
