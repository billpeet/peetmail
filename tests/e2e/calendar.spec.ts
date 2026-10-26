import type { Page } from "@playwright/test";
import { localAt } from "../harness/calendar-fixtures.ts";
import { test, expect, snap, syncNow } from "./fixtures";

const event = (page: Page, remoteId: string) => page.locator(`[data-testid=cal-event][data-remote-id="${remoteId}"]`);

async function showCalendar(page: Page) {
  await page.keyboard.press("0");
  await expect(page.getByTestId("day-view")).toBeVisible();
}

test("0 shows today's calendar in the right pane, synced from Graph", async ({ inbox: page }, testInfo) => {
  await showCalendar(page);
  await expect(page.getByTestId("day-label")).toContainText("Today");
  await expect(event(page, "evt-invite")).toContainText("Design review");
  await expect(event(page, "evt-lunch")).toContainText("Lunch with Sam");
  await expect(page.getByTestId("now-line")).toBeVisible();
  await snap(page, testInfo, "day-view");

  // 0 again goes back to Recent Opens.
  await page.keyboard.press("0");
  await expect(page.getByTestId("day-view")).toHaveCount(0);
  await expect(page.getByTestId("pane-tab-recent")).toHaveAttribute("aria-selected", "true");
});

test("overlapping events sit side by side", async ({ inbox: page }) => {
  await showCalendar(page);
  await expect(event(page, "evt-1on1")).toHaveAttribute("data-cols", "2");
  await expect(event(page, "evt-focus")).toHaveAttribute("data-cols", "2");
  await expect(event(page, "evt-focus")).toHaveAttribute("data-col", "1");
  await expect(event(page, "evt-lunch")).toHaveAttribute("data-cols", "1");
});

test("day navigation: tomorrow, all-day events, and back to today", async ({ inbox: page }) => {
  await showCalendar(page);
  await page.getByTestId("day-next").click();
  await expect(page.getByTestId("day-label")).toContainText("Tomorrow");
  await expect(event(page, "evt-dentist")).toBeVisible();
  await expect(page.getByTestId("now-line")).toHaveCount(0);
  await page.getByTestId("day-next").click();
  await expect(page.locator('[data-testid=all-day-event][data-remote-id="evt-offsite"]')).toContainText("Team offsite");
  await page.getByTestId("day-today").click();
  await expect(page.getByTestId("day-label")).toContainText("Today");
});

test("new, changed and removed events arrive through delta sync", async ({ inbox: page, fake }) => {
  await showCalendar(page);
  await fake.control("event", { id: "evt-new", subject: "Coffee with Hannah", start: localAt(0, 17).toISOString(), end: localAt(0, 17, 30).toISOString() });
  await fake.control("event-remove", { id: "evt-lunch" });
  await syncNow(page, fake);
  await expect(event(page, "evt-new")).toContainText("Coffee with Hannah");
  await expect(event(page, "evt-lunch")).toHaveCount(0);
});

test("an expired calendar delta link triggers a full resync", async ({ inbox: page, fake }) => {
  await showCalendar(page);
  await fake.control("config", { expireCalendarDelta: true });
  await fake.control("event", { id: "evt-late", subject: "Late addition", start: localAt(0, 18).toISOString(), end: localAt(0, 19).toISOString() });
  await syncNow(page, fake);
  await expect(event(page, "evt-late")).toBeVisible();
  expect(fake.state.requests.some((r) => r.path.endsWith("/calendarView/delta") && r.status === 410)).toBe(true);
  await expect(event(page, "evt-invite")).toBeVisible(); // nothing lost in the resync
});

test("the calendar tab is remembered", async ({ inbox: page }) => {
  await showCalendar(page);
  await page.reload();
  await expect(page.getByTestId("thread-row").first()).toBeVisible();
  await expect(page.getByTestId("day-view")).toBeVisible();
});
