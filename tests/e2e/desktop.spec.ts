import { test, expect, syncNow } from "./fixtures";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

type App = Parameters<Parameters<typeof test>[2]>[0]["app"];

/** Toasts the app would have shown (PEETMAIL_NOTIFY_LOG). */
async function toasts(app: App): Promise<{ title: string; body: string }[]> {
  const raw = await readFile(join(app.dataDir, "notifications.jsonl"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function setNotify(page: Page, value: string) {
  await page.keyboard.press("Control+,");
  await page.getByTestId("notify-select").selectOption(value);
  await page.keyboard.press("Escape");
}

const exited = (app: App) => app.proc.exitCode !== null;

test("new focused mail raises a notification; the first sync and Other mail don't", async ({ inbox: page, app, fake }) => {
  expect(await toasts(app)).toEqual([]); // signing in pulled lots of unread mail, silently
  await fake.control("deliver", { from: ["Priya Nair", "priya@fabrikam.io"], subject: "Budget sign-off", preview: "Can you approve by Friday?" });
  await fake.control("deliver", { from: ["Shop", "deals@shop.example"], subject: "50% off", inference: "other" });
  await syncNow(page, fake);
  await expect.poll(() => toasts(app)).toEqual([{ title: "Priya Nair", body: "Budget sign-off\nCan you approve by Friday?" }]);

  // Nothing new: nothing announced again.
  await syncNow(page, fake);
  expect(await toasts(app)).toHaveLength(1);
});

test("the notification setting: all mail, off, and a summary for a burst", async ({ inbox: page, app, fake }) => {
  await setNotify(page, "all");
  await fake.control("deliver", { from: ["Shop", "deals@shop.example"], subject: "50% off", inference: "other" });
  await syncNow(page, fake);
  await expect.poll(async () => (await toasts(app)).map((t) => t.title)).toEqual(["Shop"]);

  await setNotify(page, "off");
  await fake.control("deliver", { subject: "Quiet one" });
  await syncNow(page, fake);
  await page.waitForTimeout(300);
  expect(await toasts(app)).toHaveLength(1);

  // Back on: what arrived while off isn't replayed; a burst is one summary.
  await setNotify(page, "focused");
  await fake.control("deliver", { count: 5, subject: "Thread" });
  await syncNow(page, fake);
  await expect.poll(async () => (await toasts(app)).at(-1)).toEqual({ title: "5 new messages", body: "From Sam Carter" });
  expect(await toasts(app)).toHaveLength(2);
});

test("a snooze coming back raises a reminder", async ({ inbox: page, app }) => {
  const until = new Date(Date.now() + 2000).toISOString();
  await page.evaluate((until) => (window as any).__TAURI_INTERNALS__.invoke("snooze_thread", { accountId: 1, conversationId: "conv-plain", until }), until);
  await expect.poll(() => toasts(app), { timeout: 10_000 }).toEqual([{ title: "Reminder: Weekend plans", body: "From Mum, back in your inbox" }]);
});

test("closing the window keeps PeetMail running; with that turned off, closing quits", async ({ inbox: page, app }) => {
  await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }));
  await page.waitForTimeout(1500);
  expect(exited(app)).toBe(false);
  await expect(page.getByTestId("sync-status")).toBeAttached(); // the page is still alive

  await page.keyboard.press("Control+,");
  await page.getByTestId("close-to-tray").uncheck();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" })).catch(() => {});
  await expect.poll(() => exited(app), { timeout: 10_000 }).toBe(true);
});

test("Ctrl+Q quits", async ({ inbox: page, app }) => {
  await page.keyboard.press("Control+q");
  await expect.poll(() => exited(app), { timeout: 10_000 }).toBe(true);
});

test("start with Windows is a setting (kept out of the real registry in tests)", async ({ inbox: page }) => {
  await page.keyboard.press("Control+,");
  const box = page.getByTestId("autostart");
  await expect(box).not.toBeChecked();
  await box.check();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+,");
  await expect(page.getByTestId("autostart")).toBeChecked();
});
