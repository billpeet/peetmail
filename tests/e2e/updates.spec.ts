import { test, expect, openSettings } from "./fixtures";
import { readFile } from "node:fs/promises";
import { SIGNED_VERSION } from "../harness/fake-update.ts";
import type { Page } from "@playwright/test";

/** What the app "installed" (PEETMAIL_FAKE_UPDATE_INSTALL), or null. */
const installed = (path: string) =>
  readFile(path, "utf8").then((t) => JSON.parse(t) as { version: string; bytes: number }, () => null);

async function openUpdates(page: Page) {
  await openSettings(page, "updates");
  await expect(page.getByTestId("update-status")).toBeVisible();
}

test("without an update feed, updates are off and say so", async ({ inbox: page }) => {
  await openUpdates(page);
  await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "disabled");
  await expect(page.getByTestId("update-status")).toHaveText("Updates aren't available in this build.");
  await expect(page.getByTestId("update-check")).toBeDisabled();
  await expect(page.getByTestId("app-version")).toHaveText(/^\d+\.\d+\.\d+/);
});

test.describe("with update feeds", () => {
  test.use({ withUpdates: true });

  test.describe("background check", () => {
    test.use({ updateFirstCheckSecs: 1, updateFeed: { stable: { version: SIGNED_VERSION, notes: "Faster search" } } });

    test("a newer stable release downloads by itself, verified, and Ctrl+Shift+U installs it", async ({ inbox: page, updates }) => {
      const ready = page.getByTestId("update-ready");
      await expect(ready).toContainText(`${SIGNED_VERSION} is ready`, { timeout: 15_000 });
      expect(updates.feedRequests("canary")).toBe(0);

      // It's a binding, so it shows in the shortcut overlay.
      await page.keyboard.press("?");
      await expect(page.getByTestId("shortcut-help")).toContainText("Restart to update");
      await page.keyboard.press("Escape");

      await page.keyboard.press("Control+Shift+U");
      await expect.poll(() => installed(updates.installedPath)).toEqual({ version: SIGNED_VERSION, bytes: expect.any(Number) });
    });
  });

  test("Check now: up to date, then a release appears", async ({ inbox: page, updates }) => {
    await openUpdates(page);
    await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "idle");
    await page.getByTestId("update-check").click();
    await expect(page.getByTestId("update-status")).toHaveText("Up to date.");

    updates.publish("stable", { version: SIGNED_VERSION });
    await page.getByTestId("update-check").click();
    await expect(page.getByTestId("update-status")).toHaveText(`${SIGNED_VERSION} is ready. Restart to update.`);
    await page.getByTestId("update-install").click();
    await expect.poll(() => installed(updates.installedPath)).toMatchObject({ version: SIGNED_VERSION });
  });

  test("switching to canary checks the canary feed and finds its build", async ({ inbox: page, updates }) => {
    updates.publish("canary", { version: SIGNED_VERSION });
    await openUpdates(page);
    await page.getByTestId("update-channel").selectOption("canary");
    await expect(page.getByTestId("update-status")).toHaveText(`${SIGNED_VERSION} is ready. Restart to update.`);
    expect(updates.feedRequests("canary")).toBeGreaterThan(0);
    expect(updates.feedRequests("stable")).toBe(0);

    // The choice sticks, and going back drops the canary download.
    await page.getByTestId("update-channel").selectOption("stable");
    await expect(page.getByTestId("update-status")).toHaveText("Up to date.");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("update-ready")).toHaveCount(0);
  });

  test("switching channel mid-check drops the old channel's result", async ({ inbox: page, updates }) => {
    updates.publish("stable", { version: SIGNED_VERSION, delayMs: 1500 });
    await openUpdates(page);
    await page.getByTestId("update-check").click();
    await expect(page.getByTestId("update-status")).toHaveText("Checking…");
    await page.getByTestId("update-channel").selectOption("canary");

    // Canary has nothing; the slow stable answer must not land as "ready".
    await expect(page.getByTestId("update-status")).toHaveText("Up to date.", { timeout: 10_000 });
    expect(updates.feedRequests("canary")).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("update-status")).toHaveText("Up to date.");
    await expect(page.getByTestId("update-channel")).toHaveValue("canary");
  });

  test("a download whose signature doesn't match is refused", async ({ inbox: page, updates }) => {
    updates.publish("stable", { version: SIGNED_VERSION, tampered: true });
    await openUpdates(page);
    await page.getByTestId("update-check").click();
    await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "error");
    await expect(page.getByTestId("update-status")).toContainText(/signature/i);
    expect(updates.requests).toContain("/tampered.bin");
    await expect(page.getByTestId("update-install")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("update-ready")).toHaveCount(0);
  });

  test("a manifest can't pass an old signed build off as a newer version", async ({ inbox: page, updates }) => {
    // Validly signed bytes, but signed for SIGNED_VERSION, not the version announced.
    updates.publish("stable", { version: "9.9.1" });
    await openUpdates(page);
    await page.getByTestId("update-check").click();
    await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "error");
    await expect(page.getByTestId("update-status")).toContainText(`signed for version ${SIGNED_VERSION}`);
    await expect(page.getByTestId("update-install")).toHaveCount(0);
  });

  test.describe("while sending", () => {
    test.use({ undoSendSecs: 30, updateFirstCheckSecs: 1, updateFeed: { stable: { version: SIGNED_VERSION } } });

    test("won't restart with a draft open or a message in its undo window", async ({ inbox: page, updates }) => {
      await expect(page.getByTestId("update-ready")).toBeVisible({ timeout: 15_000 });

      await page.keyboard.press("c");
      await page.getByTestId("compose-to").fill("priya@fabrikam.io");
      await page.getByTestId("compose-subject").fill("Before the update");
      await page.keyboard.press("Control+Shift+U");
      await expect(page.getByTestId("toast")).toContainText("Send or close your draft first");

      await page.keyboard.press("Control+Enter");
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await page.keyboard.press("Control+Shift+U");
      await expect(page.getByTestId("toast")).toContainText("A message is still sending");
      expect(await installed(updates.installedPath)).toBeNull();
    });
  });
});
