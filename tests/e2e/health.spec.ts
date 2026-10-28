import { test, expect } from "./fixtures";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

const invoke = (page: Page, cmd: string, args?: Record<string, unknown>) =>
  page.evaluate(([cmd, args]) => (window as any).__TAURI_INTERNALS__.invoke(cmd, args), [cmd, args] as const);

/** Waits for the first round of checks (they run in the background after startup). */
async function checked(logPath: string) {
  await expect.poll(() => readFile(logPath, "utf8").catch(() => ""), { timeout: 15_000 }).toMatch(/health: checked, \d+ issue/);
}

/** Every check reporting a problem, through the debug-only stand-ins. */
const EVERYTHING_WRONG = {
  PEETMAIL_FAKE_HEALTH: "disk_free_mb=120;clock_skew_secs=-1200;webview=109.0.1518.78;db_check=row 5 missing from index messages_folder_sort;readonly=1",
};

test("a healthy PC gets no warnings (the real checks, clock against the server's Date)", async ({ inbox: page, app }) => {
  await checked(app.logPath);
  // The clock really was compared (with the fake Graph's Date header), not skipped.
  expect(await readFile(app.logPath, "utf8")).toMatch(/health: checked, 0 issue\(s\); clock -?[0-2]s off/);
  expect(await invoke(page, "health_issues")).toEqual([]);
  await expect(page.getByTestId("health-banner")).toHaveCount(0);
});

test.describe("when everything is wrong", () => {
  test.use({ appEnv: EVERYTHING_WRONG });

  test("each problem gets a banner saying what to do", async ({ inbox: page }) => {
    const banners = page.getByTestId("health-banner");
    await expect(banners).toHaveCount(5);
    await expect(banners.nth(0)).toHaveAttribute("data-id", "db_integrity");
    await expect(banners.nth(0)).toHaveAttribute("data-severity", "error");
    await expect(banners.nth(0)).toContainText("row 5 missing from index");
    await expect(page.locator('[data-id="data_dir"]')).toContainText("can't save to its data folder");
    await expect(page.locator('[data-id="disk_space"]')).toContainText("120 MB free");
    await expect(page.locator('[data-id="clock"]')).toContainText("Your PC's clock is 20 minutes fast");
    await expect(page.locator('[data-id="webview"]')).toContainText("109.0.1518.78");

    // Dismissing hides one for this session.
    await page.locator('[data-id="disk_space"]').getByTestId("health-dismiss").click();
    await expect(banners).toHaveCount(4);
    await expect(page.locator('[data-id="disk_space"]')).toHaveCount(0);

    // Help explains each one, and the banners stay out of the way of overlays.
    await page.locator('[data-id="clock"]').getByTestId("health-help").click();
    await expect(page.getByTestId("help")).toHaveAttribute("data-page", "troubleshooting");
    await expect(page.getByTestId("help-content")).toContainText("Set time automatically");
    await expect(banners).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(banners).toHaveCount(4);

    // The palette dismisses the rest.
    await page.keyboard.press("Control+k");
    await page.keyboard.type("Dismiss warnings");
    await page.keyboard.press("Enter");
    await expect(banners).toHaveCount(0);
  });
});

test.describe("with telemetry", () => {
  test.use({ withTelemetry: true, appEnv: { PEETMAIL_FAKE_HEALTH: "clock_skew_secs=7200" } });

  test("each problem found is counted, by check", async ({ inbox: page, telemetry }) => {
    await expect(page.locator('[data-id="clock"]')).toContainText("2 hours slow");
    await expect
      .poll(
        async () => {
          await invoke(page, "debug_flush_telemetry");
          return telemetry
            .metrics()
            .filter((m) => m.name === "peetmail.health.issues")
            .flatMap((m) => m.points.map((p) => p["peetmail.health.check"]));
        },
        { timeout: 15_000 },
      )
      .toContain("clock");
  });
});
