import { test, expect, syncNow, waitForSyncIdle } from "./fixtures";
import { GMAIL_ACCOUNT } from "../harness/fake-gmail.ts";
import type { Page } from "@playwright/test";

type Boot = { clientId: string | null; builtin: { microsoft: boolean; google: boolean }; accounts: { provider: string; email: string; signedIn: boolean; oauthApp: string }[] };
const boot = (page: Page): Promise<Boot> => page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("bootstrap"));

const OTHER_APP = "aaaaaaaa-1111-2222-3333-444444444444";

test("without built-in apps (local builds), setup asks for a client ID as before", async ({ page }) => {
  await expect(page.getByTestId("setup")).toHaveAttribute("data-builtin", "false");
  await expect(page.getByTestId("client-id-input")).toBeVisible();
  expect((await boot(page)).builtin).toEqual({ microsoft: false, google: false });
});

test.describe("with PeetMail's own apps built in", () => {
  test.use({ builtinApps: true, withGmail: true });

  test("signing in needs no setup: Enter, and the inbox loads", async ({ page }) => {
    await expect(page.getByTestId("setup")).toHaveAttribute("data-builtin", "true");
    await expect(page.getByTestId("client-id-input")).toHaveCount(0);
    await expect(page.getByTestId("sign-in")).toContainText("Sign in with Microsoft");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("inbox")).toBeVisible({ timeout: 15_000 });
    expect((await boot(page)).accounts.map((a) => [a.provider, a.oauthApp])).toEqual([["microsoft", "builtin"]]);
  });

  test("Gmail works straight away too", async ({ page }) => {
    await page.getByTestId("sign-in-google").click();
    await expect(page.getByTestId("inbox")).toBeVisible({ timeout: 15_000 });
    expect((await boot(page)).accounts.map((a) => [a.email, a.oauthApp])).toEqual([[GMAIL_ACCOUNT.email, "builtin"]]);
  });

  test("your own app sits under Advanced, and setting it signs nobody out", async ({ inbox: page }) => {
    await page.keyboard.press("Control+,");
    const advanced = page.getByTestId("advanced-apps");
    await expect(page.getByTestId("client-id-input")).toBeHidden();
    await advanced.locator("summary").click();
    await page.getByTestId("client-id-input").fill(OTHER_APP);
    await page.getByTestId("client-id-input").press("Enter");
    await expect(page.getByTestId("account-add-custom")).toBeVisible();

    const b = await boot(page);
    expect(b.clientId).toBe(OTHER_APP);
    expect(b.accounts.map((a) => [a.signedIn, a.oauthApp])).toEqual([[true, "builtin"]]);
  });

  test.describe("with short-lived tokens", () => {
    test.beforeEach(async ({ fake }) => {
      // Every request needs a fresh token, so each sync refreshes.
      await fake.control("config", { tokenTtl: 30 });
    });

    test("a refresh uses the app the account signed in with, not the one set later", async ({ inbox: page, fake }) => {
      await page.keyboard.press("Control+,");
      await page.getByTestId("advanced-apps").locator("summary").click();
      await page.getByTestId("client-id-input").fill(OTHER_APP);
      await page.getByTestId("client-id-input").press("Enter");
      await expect(page.getByTestId("account-add-custom")).toBeVisible();
      await page.keyboard.press("Escape");

      // The fake's token endpoint only knows the built-in app's ID: refreshing with
      // OTHER_APP would fail with unauthorized_client and the sync would error.
      const before = fake.state.requests.length;
      await syncNow(page, fake);
      await waitForSyncIdle(page);
      const tokens = fake.requestsSince(before).filter((r) => r.path === "/oauth/token");
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.map((r) => r.status)).toEqual(tokens.map(() => 200));
      expect((await boot(page)).accounts[0].signedIn).toBe(true);
    });
  });
});
