import { test, expect, selectedRow, selectWithKeys, snap, openSettings } from "./fixtures";
import type { Page } from "@playwright/test";

type Fake = Parameters<Parameters<typeof test>[2]>[0]["fake"];

const sentNew = (fake: Fake) => fake.state.sent.filter((s: Record<string, any>) => s.kind === "new");

async function draft(page: Page, subject: string) {
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("priya@fabrikam.io");
  await page.getByTestId("compose-subject").fill(subject);
  await page.getByTestId("compose-body").fill("See you there");
}

test.describe("undo send", () => {
  test.use({ undoSendSecs: 3 });

  test("a sent message waits out the undo window; z takes it back into the composer", async ({ inbox: page, fake }, testInfo) => {
    await draft(page, "Lunch?");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("Sending…");
    await expect(page.getByTestId("toast")).toContainText("undo");
    await snap(page, testInfo, "undo-send-toast");

    await page.keyboard.press("z");
    await expect(page.getByTestId("toast")).toContainText("Send undone");
    await expect(page.getByTestId("compose-to")).toHaveValue("priya@fabrikam.io");
    await expect(page.getByTestId("compose-subject")).toHaveValue("Lunch?");
    await expect(page.getByTestId("compose-body")).toHaveValue("See you there");
    await page.waitForTimeout(4000);
    expect(sentNew(fake)).toEqual([]);

    // Sent again and left alone, it goes once the window is over, and not before.
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(1000);
    expect(sentNew(fake)).toEqual([]);
    await expect.poll(() => sentNew(fake).length, { timeout: 10_000 }).toBe(1);
    expect(sentNew(fake)[0].subject).toBe("Lunch?");
    await expect(page.getByTestId("outbox-pending")).toHaveCount(0);
  });

});

test.describe("a long undo window", () => {
  test.use({ undoSendSecs: 10 });

  test("triage during a send's undo window isn't held up by it", async ({ inbox: page, fake }) => {
    await draft(page, "Slow one");
    await page.keyboard.press("Control+Enter");
    await selectWithKeys(page, "conv-plain");
    await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "conv-plain");
    const before = fake.state.requests.length;
    await page.keyboard.press("e");
    // The archive's 2s grace (plus at most a 1s nap), not the send's 10s, decides when it goes.
    await expect
      .poll(() => fake.requestsSince(before).some((r) => r.method === "POST" && r.path.endsWith("/move")), { timeout: 6000 })
      .toBe(true);
    expect(sentNew(fake)).toEqual([]);
  });
});

test("the undo window is a setting", async ({ inbox: page, fake }) => {
  await openSettings(page, "mail");
  await page.getByTestId("undo-send-select").selectOption("5");
  await page.keyboard.press("Escape");
  await draft(page, "Configured");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("toast")).toContainText("undo");
  await page.waitForTimeout(2500);
  expect(sentNew(fake)).toEqual([]);
  await expect.poll(() => sentNew(fake).length, { timeout: 10_000 }).toBe(1);
});

test("Ctrl+Shift+Enter schedules a message; g s lists it, Enter edits it, # cancels it", async ({ inbox: page, fake }, testInfo) => {
  await draft(page, "Quarterly numbers");
  await page.keyboard.press("Control+Shift+Enter");
  const input = page.getByTestId("compose-later-input");
  await expect(input).toBeFocused();
  await input.fill("tomorrow whenever");
  await expect(page.getByTestId("compose-later-hint")).toContainText("whenever");
  await input.fill("tomorrow 9am");
  await expect(page.getByTestId("compose-later-when")).toContainText("tomorrow");
  await snap(page, testInfo, "send-later-picker");
  await input.press("Enter");

  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Scheduled for tomorrow");
  await expect(page.getByTestId("footer-scheduled")).toHaveText("1 scheduled message");

  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page.getByTestId("mailbox-title")).toHaveAttribute("data-mailbox", "scheduled");
  await expect(page.getByTestId("rail-mailbox-scheduled")).toHaveAttribute("data-active", "true");
  const rows = page.getByTestId("scheduled-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Quarterly numbers");
  await expect(page.getByTestId("scheduled-when").first()).toContainText("9:00");
  await snap(page, testInfo, "scheduled-list");

  // Enter: back into the composer, no longer scheduled.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("compose-subject")).toHaveValue("Quarterly numbers");
  await expect(page.getByTestId("footer-scheduled")).toHaveCount(0);

  // Schedule it again with a preset, then cancel it from the list.
  await page.keyboard.press("Control+Shift+Enter");
  await page.getByTestId("compose-later-preset").filter({ hasText: "Tomorrow morning" }).click();
  await expect(page.getByTestId("footer-scheduled")).toHaveText("1 scheduled message");
  await page.getByTestId("footer-scheduled").click();
  await page.keyboard.press("#");
  await expect(page.getByTestId("toast")).toContainText("Scheduled message cancelled");
  await expect(page.getByTestId("scheduled-empty")).toBeVisible();
  await expect(page.getByTestId("footer-scheduled")).toHaveCount(0);
  expect(sentNew(fake)).toEqual([]);
});

test("Esc closes the send-later picker without closing the composer", async ({ inbox: page }) => {
  await draft(page, "Keep me");
  await page.keyboard.press("Control+Shift+Enter");
  await expect(page.getByTestId("compose-later")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("compose-later")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("compose-body")).toBeFocused();
});

test("a scheduled message goes out at its time and leaves the list", async ({ inbox: page, fake }) => {
  // Scheduling to the second isn't possible from the picker, so ask the backend directly.
  const sendAt = new Date(Date.now() + 4000).toISOString();
  await page.evaluate(
    (sendAt) =>
      (window as any).__TAURI_INTERNALS__.invoke("send_message", {
        input: { accountId: 1, kind: "new", referenceMessageId: null, to: ["priya@fabrikam.io"], cc: [], subject: "On time", body: "hi", sendAt },
      }),
    sendAt,
  );
  await expect(page.getByTestId("footer-scheduled")).toHaveText("1 scheduled message");
  await page.waitForTimeout(2000);
  expect(sentNew(fake)).toEqual([]);
  await expect.poll(() => sentNew(fake).length, { timeout: 8000 }).toBe(1);
  await expect(page.getByTestId("footer-scheduled")).toHaveCount(0);
});

test("scheduling in the past is refused", async ({ inbox: page }) => {
  const err = await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__
      .invoke("send_message", {
        input: { accountId: 1, kind: "new", referenceMessageId: null, to: ["priya@fabrikam.io"], cc: [], subject: "x", body: "x", sendAt: "2001-01-01T00:00:00Z" },
      })
      .then(() => null, (e: unknown) => String(e)),
  );
  expect(err).toContain("already passed");
});
