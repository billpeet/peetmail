import { test, expect, openSettings } from "./fixtures";

const PAGES = ["accounts", "mail", "calendar", "notifications", "storage", "updates", "privacy", "apps"];

test("every settings page is a click away, and each says what it's for", async ({ inbox: page }) => {
  await page.keyboard.press("Control+,");
  const settings = page.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "accounts");
  for (const p of PAGES) {
    await page.getByTestId(`settings-nav-${p}`).click();
    await expect(settings).toHaveAttribute("data-page", p);
    await expect(settings.locator("h2").last()).not.toBeEmpty();
  }
});

test("the keyboard moves between pages, and Ctrl+, comes back to the last one", async ({ inbox: page }) => {
  await openSettings(page, "accounts");
  const settings = page.getByTestId("settings");
  await page.keyboard.press("Control+PageDown");
  await expect(settings).toHaveAttribute("data-page", "mail");
  await page.keyboard.press("Control+PageUp");
  await page.keyboard.press("Control+PageUp");
  await expect(settings).toHaveAttribute("data-page", "apps"); // wraps round
  // Arrow keys move through the sidebar when it has focus (it does when Settings opens).
  await page.getByTestId("settings-nav-calendar").click();
  await page.keyboard.press("ArrowDown");
  await expect(settings).toHaveAttribute("data-page", "notifications");

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("Control+,");
  await expect(settings).toHaveAttribute("data-page", "notifications");
});

test("saving the offline cache stays on the page and says so", async ({ inbox: page }) => {
  await openSettings(page, "storage");
  await page.getByTestId("cache-save").click();
  await expect(page.getByTestId("cache-saved")).toBeVisible();
  await expect(page.getByTestId("settings")).toHaveAttribute("data-page", "storage");
});

test.describe("with crash reports configured", () => {
  test.use({ withSentry: true });

  test("the privacy notice's Settings button opens the Privacy page, and the notice stays out of the way", async ({ inbox: page }) => {
    await page.getByTestId("privacy-notice-settings").click();
    await expect(page.getByTestId("settings")).toHaveAttribute("data-page", "privacy");
    await expect(page.getByTestId("crash-reports")).toBeVisible();
    await expect(page.getByTestId("privacy-notice")).toHaveCount(0);
  });
});
