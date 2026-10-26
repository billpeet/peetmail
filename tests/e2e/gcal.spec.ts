import { test, expect, row, selectWithKeys, selectedRow, snap, waitForSyncIdle, showCalendarPane } from "./fixtures";
import type { Page } from "@playwright/test";
import { GMAIL_ACCOUNT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../harness/fake-gmail.ts";

test.use({ withGmail: true });

type Gmail = Parameters<Parameters<typeof test>[2]>[0]["gmail"];
type Ev = { remoteId: string; subject: string; startAt: string; isAllDay: boolean; response: string | null; joinUrl: string | null; showAs: string | null; isOrganizer: boolean; location: string | null };

async function setGoogleClient(page: Page) {
  await page.getByTestId("google-client-id").fill(GOOGLE_CLIENT_ID);
  await page.getByTestId("google-client-secret").fill(GOOGLE_CLIENT_SECRET);
  await page.getByTestId("google-client-save").click();
}

async function addGmail(page: Page) {
  await page.keyboard.press("Control+,");
  await setGoogleClient(page);
  await page.getByTestId("account-add-google").click();
  await expect(page.locator(`[data-testid=account-row][data-email="${GMAIL_ACCOUNT.email}"]`)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await waitForSyncIdle(page);
  await expect(row(page, "g-thread-trip")).toBeVisible({ timeout: 15_000 });
}

/** Google events the app has, over a wide range. */
async function gEvents(page: Page): Promise<Ev[]> {
  const all: Ev[] = await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke("list_events", {
      from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z", fromDate: "2000-01-01", toDate: "2100-01-01",
    }),
  );
  return all.filter((e) => e.remoteId.startsWith("gcal-"));
}

async function syncNow(page: Page, gmail: Gmail) {
  const before = gmail.state.requests.length;
  await page.keyboard.press("Control+r");
  await expect.poll(() => gmail.state.requests.slice(before).some((r) => r.path.endsWith("/profile") || r.path.endsWith("/history"))).toBe(true);
  await waitForSyncIdle(page);
}

test("Google Calendar events sync in: invitations, series instances, all-day, inside the window", async ({ inbox: page }, testInfo) => {
  await addGmail(page);
  await expect.poll(async () => (await gEvents(page)).map((e) => e.remoteId).sort(), { timeout: 15_000 }).toEqual(
    ["gcal-dentist", "gcal-holiday", "gcal-lunch", "gcal-yoga_1", "gcal-yoga_2", "gcal-yoga_3"], // no series master, nothing outside the window
  );
  const by = Object.fromEntries((await gEvents(page)).map((e) => [e.remoteId, e]));
  expect(by["gcal-lunch"]).toMatchObject({ subject: "Team lunch", response: "notResponded", isOrganizer: false, joinUrl: "https://meet.google.com/abc-defg-hij", location: "Café Beetroot" });
  expect(by["gcal-dentist"]).toMatchObject({ response: "organizer", isOrganizer: true, showAs: "busy" });
  expect(by["gcal-yoga_2"]).toMatchObject({ subject: "Yoga", showAs: "free" });
  expect(by["gcal-holiday"]).toMatchObject({ isAllDay: true });
  await page.keyboard.press("2");
  await snap(page, testInfo, "google-calendar-week");
});

test("later syncs use the sync token: new and cancelled events; an expired token means a full resync", async ({ inbox: page, gmail }) => {
  await addGmail(page);
  await expect.poll(async () => (await gEvents(page)).length, { timeout: 15_000 }).toBe(6);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await gmail.control("gcal-add", { id: "gcal-new", summary: "Coffee", start: { dateTime: `${tomorrow}T03:00:00Z` }, end: { dateTime: `${tomorrow}T03:30:00Z` } });
  await gmail.control("gcal-cancel", { id: "gcal-holiday" });
  await syncNow(page, gmail);
  await expect.poll(async () => (await gEvents(page)).map((e) => e.remoteId)).toContain("gcal-new");
  expect((await gEvents(page)).map((e) => e.remoteId)).not.toContain("gcal-holiday");

  await gmail.control("gcal-expire-sync", {});
  await gmail.control("gcal-add", { id: "gcal-after", summary: "After the gap", start: { dateTime: `${tomorrow}T05:00:00Z` }, end: { dateTime: `${tomorrow}T06:00:00Z` } });
  await syncNow(page, gmail);
  await expect.poll(async () => (await gEvents(page)).map((e) => e.remoteId)).toContain("gcal-after");
  expect((await gEvents(page)).length).toBe(7);
});

test("a Gmail invitation gets the RSVP card, and y accepts it on Google Calendar", async ({ inbox: page, gmail }, testInfo) => {
  await addGmail(page);
  await selectWithKeys(page, "g-thread-invite");
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "g-thread-invite");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("invite-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Team lunch");
  await expect(card).toHaveAttribute("data-response", "notResponded");
  await snap(page, testInfo, "gmail-invite-card");
  await page.keyboard.press("y");
  await expect(card).toHaveAttribute("data-response", "accepted");
  await expect.poll(() => gmail.state.sent.filter((s) => s.kind === "rsvp").length, { timeout: 10_000 }).toBe(1);
  const rsvp = gmail.state.sent.find((s) => s.kind === "rsvp")!;
  expect(rsvp.id).toBe("gcal-lunch");
  expect(rsvp.sendUpdates).toBe("all");
  expect(rsvp.attendees.map((a: any) => [a.email, a.responseStatus])).toEqual([
    ["kim@friends.example", "accepted"],
    [GMAIL_ACCOUNT.email, "accepted"],
    ["lee@friends.example", "tentative"],
  ]);

  // Ordinary Gmail threads get no card.
  await page.keyboard.press("Escape");
  await row(page, "g-thread-latin").click();
  await expect(page.getByTestId("reader")).toHaveAttribute("data-conversation-id", "g-thread-latin");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("invite-card")).toHaveCount(0);
});

test("quick add on a Gmail-only setup creates the event on Google Calendar", async ({ page, gmail }) => {
  await setGoogleClient(page);
  await page.getByTestId("sign-in-google").click();
  await expect(row(page, "g-thread-trip")).toBeVisible({ timeout: 20_000 });
  await waitForSyncIdle(page);
  await page.keyboard.press("Shift+C");
  await expect(page.getByTestId("quick-add-account")).toHaveCount(0); // one account: no picker
  await page.getByTestId("quick-add-input").fill("Lunch with Sam tomorrow 1pm");
  await page.keyboard.press("Enter");
  await expect.poll(() => gmail.state.sent.filter((s) => s.kind === "create-event").length, { timeout: 10_000 }).toBe(1);
  const created = gmail.state.sent.find((s) => s.kind === "create-event")!;
  expect(created.body.summary).toBe("Lunch with Sam");
  expect(created.body.start.dateTime).toMatch(/Z$/);
  // The placeholder is swapped for Google's event.
  await expect.poll(async () => (await gEvents(page)).map((e) => e.remoteId)).toContain(created.id);
});

test("without calendar permission, mail still works and calendar writes say to sign in again", async ({ page, gmail }) => {
  await gmail.control("gcal-access", { granted: false });
  await setGoogleClient(page);
  await page.getByTestId("sign-in-google").click();
  await expect(row(page, "g-thread-trip")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Shift+C");
  await page.getByTestId("quick-add-input").fill("Lunch tomorrow 1pm");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toast")).toContainText("sign in to this Google account again", { timeout: 15_000 });
});

/** Moves the sidebar day view (from today) to the event's local day; fixture times are UTC. */
async function findDayOf(page: Page, remoteId: string) {
  const event = (await gEvents(page)).find((e) => e.remoteId === remoteId)!;
  const localDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((localDay(new Date(event.startAt)) - localDay(new Date())) / 86_400_000);
  if (await page.getByTestId("day-today").isEnabled()) await page.getByTestId("day-today").click();
  for (let i = 0; i < days; i++) await page.getByTestId("day-next").click();
}

/** Moves the sidebar day view to the event's day and returns its block. */
async function findInDayView(page: Page, remoteId: string) {
  await findDayOf(page, remoteId);
  const ev = page.locator(`[data-testid=cal-event][data-remote-id="${remoteId}"]`);
  await expect(ev).toBeVisible();
  return ev;
}

test("with two accounts, calendar events show whose they are, and details link to the right app", async ({ inbox: page }, testInfo) => {
  await addGmail(page);
  await showCalendarPane(page);
  await expect.poll(async () => (await gEvents(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);

  const google = await findInDayView(page, "gcal-dentist");
  await expect(google.getByTestId("event-account")).toHaveAttribute("title", GMAIL_ACCOUNT.email);
  await snap(page, testInfo, "calendar-account-dots");
  await google.click();
  await expect(page.getByTestId("event-calendar")).toContainText(`Google Calendar · ${GMAIL_ACCOUNT.email}`);
  await expect(page.getByTestId("event-open")).toHaveText("Open in Google Calendar");
  await page.keyboard.press("Escape");

  await page.getByTestId("day-today").click();
  const outlook = page.locator("[data-testid=cal-event]:not([data-remote-id^=gcal-])").first();
  await expect(outlook).toBeVisible();
  const msEmail = await outlook.getByTestId("event-account").getAttribute("title");
  expect(msEmail).not.toBe(GMAIL_ACCOUNT.email);
  await outlook.click();
  await expect(page.getByTestId("event-calendar")).toContainText(`Outlook calendar · ${msEmail}`);
  await expect(page.getByTestId("event-open")).toHaveText("Open in Outlook");
  await page.keyboard.press("Escape");

  // Toggling the Google account off in the footer takes its events out of the calendar too.
  await page.locator(`[data-testid=footer-account][data-email="${GMAIL_ACCOUNT.email}"]`).click();
  await findDayOf(page, "gcal-dentist");
  await expect(page.locator('[data-testid=cal-event][data-remote-id="gcal-dentist"]')).toHaveCount(0);
  await page.locator(`[data-testid=footer-account][data-email="${GMAIL_ACCOUNT.email}"]`).click();
  await expect(page.locator('[data-testid=cal-event][data-remote-id="gcal-dentist"]')).toBeVisible();
});

test("quick add asks which calendar when there are two, Tab switches, and it remembers", async ({ inbox: page, gmail, fake }) => {
  await addGmail(page);
  await page.keyboard.press("Shift+C");
  const picker = page.getByTestId("quick-add-account");
  await expect(picker).toContainText("Outlook calendar");
  await page.getByTestId("quick-add-input").fill("Climbing tomorrow 6pm");
  await page.keyboard.press("Tab");
  await expect(picker).toContainText(`Google Calendar · ${GMAIL_ACCOUNT.email}`);
  await expect(page.getByTestId("quick-add-input")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => gmail.state.sent.filter((s) => s.kind === "create-event").length, { timeout: 10_000 }).toBe(1);
  expect(gmail.state.sent.find((s) => s.kind === "create-event")!.body.summary).toBe("Climbing");
  expect(fake.state.sent.filter((s: Record<string, any>) => s.kind === "create-event")).toEqual([]);

  await page.keyboard.press("Shift+C");
  await expect(page.getByTestId("quick-add-account")).toContainText("Google Calendar"); // remembered
});
