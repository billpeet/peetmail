// Gmail's per-user quota (the fake enforces Google's 250 units/s and 15,000/min, with
// Google's 403 "Quota exceeded" error).
import { test, expect, messageBody, row, waitForSyncIdle } from "./fixtures";
import type { Page } from "@playwright/test";
import { GMAIL_ACCOUNT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../harness/fake-gmail.ts";

test.use({ withGmail: true });

async function startAddingGmail(page: Page) {
  await page.keyboard.press("Control+,");
  await page.getByTestId("google-client-id").fill(GOOGLE_CLIENT_ID);
  await page.getByTestId("google-client-secret").fill(GOOGLE_CLIENT_SECRET);
  await page.getByTestId("google-client-save").click();
  await page.getByTestId("account-add-google").click();
  await expect(page.locator(`[data-testid=account-row][data-email="${GMAIL_ACCOUNT.email}"]`)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
}

/** Conversations the app has from Gmail (search scope: all mail). */
async function gmailThreads(page: Page): Promise<number> {
  return page.evaluate(
    async () =>
      ((await (window as any).__TAURI_INTERNALS__.invoke("list_threads", { folderId: null, query: "account:gmail", split: null, cursor: null, limit: 1000 })) as unknown[])
        .length,
  );
}

test.describe("a big first sync", () => {
  test.use({ gmailExtra: 150 });

  test("stays inside Gmail's quota and fetches everything", async ({ inbox: page, gmail }) => {
    await startAddingGmail(page);
    await expect(row(page, "g-thread-trip")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => gmailThreads(page), { timeout: 30_000 }).toBe(155); // 150 fillers + trip, sale, photos, latin, invite
    await waitForSyncIdle(page);
    expect(gmail.state.quotaErrors).toBe(0);
  });
});

test("opening a message waits out a quota error instead of failing", async ({ inbox: page, gmail }) => {
  await startAddingGmail(page);
  await waitForSyncIdle(page);
  await expect(row(page, "g-thread-photos")).toBeVisible();
  await page.waitForTimeout(1500); // let body prefetch finish
  // The attachment list always comes from the server; make its first two tries hit the quota.
  await gmail.control("config", { failQuotaNext: 2 });
  await row(page, "g-thread-photos").click();
  await expect(page.getByTestId("attachment")).toContainText("plan.pdf", { timeout: 20_000 });
  await expect(messageBody(page).locator("p")).toContainText("Here they are");
  expect(gmail.state.quotaErrors).toBe(2);
});

test("a message that couldn't be fetched is retried on the next sync, not lost", async ({ inbox: page, gmail }) => {
  await gmail.control("config", { failIds: { "g-4": 1 } });
  await startAddingGmail(page);
  await expect(row(page, "g-thread-trip")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-status")).not.toHaveAttribute("data-state", "syncing", { timeout: 15_000 });
  await expect(row(page, "g-thread-photos")).toHaveCount(0);

  await page.keyboard.press("Control+r");
  await expect(row(page, "g-thread-photos")).toBeVisible({ timeout: 15_000 });
  await waitForSyncIdle(page);
});
