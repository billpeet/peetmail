import type { Page } from "@playwright/test";
import { test, expect, showCalendarPane, snap } from "./fixtures";

type Fake = { state: { sent: Record<string, any>[] } };
const event = (page: Page, remoteId: string) => page.locator(`[data-testid=cal-event][data-remote-id="${remoteId}"]`);
const sentOf = (fake: Fake, kind: string) => fake.state.sent.filter((s) => s.kind === kind);

async function openEvent(page: Page, remoteId: string) {
  await showCalendarPane(page);
  await event(page, remoteId).scrollIntoViewIfNeeded();
  await event(page, remoteId).click();
  await expect(page.getByTestId("event-details")).toBeVisible();
}

async function openEditor(page: Page, remoteId: string, scope?: "o" | "s") {
  await openEvent(page, remoteId);
  await page.keyboard.press("e");
  if (scope) {
    await expect(page.getByTestId("event-scope")).toBeVisible();
    await page.keyboard.press(scope);
  }
  await expect(page.getByTestId("event-editor")).toBeVisible();
  await expect(page.getByTestId("editor-loading")).toHaveCount(0);
}

test("editing your own event: title, reminder, a guest and a rich description; only the changes are sent", async ({ inbox: page, fake }, testInfo) => {
  await openEditor(page, "evt-lunch");
  await expect(page.getByTestId("editor-mode")).toHaveText("Edit event");
  await expect(page.getByTestId("editor-title")).toHaveValue("Lunch with Sam");
  await expect(page.getByTestId("editor-location")).toHaveValue("Café Beetroot");
  await expect(page.getByTestId("editor-reminder")).toHaveValue("none");
  await expect(page.getByTestId("editor-private")).toBeChecked();

  await page.getByTestId("editor-title").fill("Lunch with Sam & Priya");
  await page.getByTestId("editor-reminder").selectOption("10");
  const guest = page.getByTestId("editor-attendee-input");
  await guest.pressSequentially("priya");
  await expect(page.getByTestId("editor-attendee-suggestions")).toContainText("priya@fabrikam.io");
  await guest.press("Enter");
  await expect(page.getByTestId("editor-attendee")).toHaveText(/Priya Nair/);
  const rich = page.getByTestId("rich-editor");
  await rich.click();
  await page.keyboard.type("Bring the ");
  await page.keyboard.press("Control+b");
  await page.keyboard.type("receipts");
  await snap(page, testInfo, "event-editor");
  await page.keyboard.press("Control+Enter");

  await expect(page.getByTestId("event-editor")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Saved; guests will get an update");
  await expect.poll(() => sentOf(fake, "update-event").length, { timeout: 10_000 }).toBe(1);
  const u = sentOf(fake, "update-event")[0];
  expect(u.id).toBe("evt-lunch");
  expect(u.body.subject).toBe("Lunch with Sam & Priya");
  expect(u.body.reminderMinutesBeforeStart).toBe(10);
  expect(u.body.isReminderOn).toBe(true);
  expect(u.body.attendees).toEqual([{ emailAddress: { address: "priya@fabrikam.io", name: "Priya Nair" }, type: "required" }]);
  expect(u.body.body.content).toContain("<strong>receipts</strong>");
  // Unchanged fields stay out.
  expect(Object.keys(u.body).sort()).toEqual(["attendees", "body", "isReminderOn", "reminderMinutesBeforeStart", "subject"]);
  await expect(event(page, "evt-lunch")).toContainText("Lunch with Sam & Priya");
});

test("moving the start keeps the length; the new times are sent in UTC", async ({ inbox: page, fake }) => {
  await openEditor(page, "evt-lunch"); // 13:00–14:00
  await page.getByTestId("editor-start-time").fill("15:30");
  await page.getByTestId("editor-start-time").dispatchEvent("change");
  await expect(page.getByTestId("editor-end-time")).toHaveValue("16:30");
  await page.getByTestId("editor-save").click();
  await expect.poll(() => sentOf(fake, "update-event").length, { timeout: 10_000 }).toBe(1);
  const b = sentOf(fake, "update-event")[0].body;
  expect(b.start.timeZone).toBe("UTC");
  const start = new Date(`${b.start.dateTime}Z`);
  const end = new Date(`${b.end.dateTime}Z`);
  expect([start.getHours(), start.getMinutes()]).toEqual([15, 30]);
  expect(end.getTime() - start.getTime()).toBe(60 * 60_000);
  expect(Object.keys(b).sort()).toEqual(["end", "isAllDay", "start"]);
});

test("a recurring event asks what to edit, and the editor says which", async ({ inbox: page, fake }, testInfo) => {
  // Just this occurrence.
  await openEditor(page, "evt-review-1", "o");
  await expect(page.getByTestId("editor-scope")).toHaveAttribute("data-series", "false");
  await expect(page.getByTestId("editor-scope")).toContainText("Editing this occurrence only");
  await page.getByTestId("editor-title").fill("Weekly review (moved agenda)");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOf(fake, "update-event").length, { timeout: 10_000 }).toBe(1);
  expect(sentOf(fake, "update-event")[0]).toMatchObject({ id: "evt-review-1", body: { subject: "Weekly review (moved agenda)" } });

  // The whole series: the master, with its pattern shown.
  await openEditor(page, "evt-review-1", "s");
  const scope = page.getByTestId("editor-scope");
  await expect(scope).toHaveAttribute("data-series", "true");
  await expect(scope).toContainText("Editing the whole series");
  await expect(scope).toContainText(/Every week on \w+day/);
  await expect(page.getByTestId("editor-mode")).toHaveText("Edit series");
  await expect(page.getByTestId("editor-title")).toHaveValue("Weekly review"); // the series' own title
  await snap(page, testInfo, "editor-series");
  await page.getByTestId("editor-location").fill("Room 9");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOf(fake, "update-event").length, { timeout: 10_000 }).toBe(2);
  expect(sentOf(fake, "update-event")[1]).toMatchObject({ id: "evt-review-series", body: { location: { displayName: "Room 9" } } });
});

test("guests can only change their own show-as and reminder", async ({ inbox: page, fake }) => {
  await openEditor(page, "evt-invite");
  await expect(page.getByTestId("editor-guest")).toBeVisible();
  await expect(page.getByTestId("editor-title")).toBeDisabled();
  await expect(page.getByTestId("editor-location")).toBeDisabled();
  await expect(page.getByTestId("editor-attendee-input")).toHaveCount(0);
  await page.getByTestId("editor-show-as").selectOption("free");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("toast")).toHaveText("Saved");
  await expect.poll(() => sentOf(fake, "update-event").length, { timeout: 10_000 }).toBe(1);
  expect(sentOf(fake, "update-event")[0].body).toEqual({ showAs: "free" });
});

test("deleting: your own event, cancelling a meeting (one occurrence and the series), and a guest removing", async ({ inbox: page, fake }, testInfo) => {
  // Your own event, no guests: a plain delete.
  await openEvent(page, "evt-own");
  await page.keyboard.press("#");
  await expect(page.getByTestId("event-delete-confirm")).toContainText("Delete this event?");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("toast")).toContainText("Deleted the event");
  await expect(event(page, "evt-own")).toHaveCount(0);
  await expect.poll(() => sentOf(fake, "delete-event").map((s) => s.id), { timeout: 10_000 }).toEqual(["evt-own"]);

  // A meeting you organise: cancelling tells the guests, with a message.
  await openEvent(page, "evt-review-1");
  await page.getByTestId("event-delete").click();
  await page.getByTestId("scope-one").click();
  await expect(page.getByTestId("event-delete-confirm")).toContainText("Cancel this occurrence of the meeting? Guests get a cancellation.");
  await page.getByTestId("event-delete-message").fill("Out sick, sorry");
  await snap(page, testInfo, "cancel-meeting");
  await page.getByTestId("event-delete-go").click();
  await expect(page.getByTestId("toast")).toContainText("Cancelled the meeting occurrence");
  await expect.poll(() => sentOf(fake, "cancel-event"), { timeout: 10_000 }).toEqual([{ kind: "cancel-event", id: "evt-review-1", comment: "Out sick, sorry" }]);

  // The whole series goes, occurrences and all (today's is gone: next week's is left).
  await page.keyboard.press("2");
  await page.getByTestId("week-next").click();
  const weekReview = page.locator("[data-testid=week-event]", { hasText: "Weekly review" });
  await expect(weekReview.first()).toBeVisible();
  await weekReview.first().click();
  await page.keyboard.press("Delete");
  await page.keyboard.press("s");
  await expect(page.getByTestId("event-delete-confirm")).toContainText("Cancel every meeting in this series?");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOf(fake, "cancel-event").map((s) => s.id), { timeout: 10_000 }).toEqual(["evt-review-1", "evt-review-series"]);
  await expect(weekReview).toHaveCount(0);

  // A meeting you were invited to: removed from your calendar, organiser not told.
  await page.keyboard.press("Escape");
  await openEvent(page, "evt-invite");
  await page.keyboard.press("#");
  await expect(page.getByTestId("event-delete-confirm")).toContainText("Remove this from your calendar?");
  await page.getByTestId("event-delete-go").click();
  await expect.poll(() => sentOf(fake, "delete-event").map((s) => s.id), { timeout: 10_000 }).toEqual(["evt-own", "evt-invite"]);
});

test("quick add's Ctrl+Enter opens the full editor; a new meeting with guests, a description and privacy", async ({ inbox: page, fake }, testInfo) => {
  await page.keyboard.press("Shift+C");
  await page.getByTestId("quick-add-input").fill("Design sync tomorrow 2pm");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("event-editor")).toBeVisible();
  await expect(page.getByTestId("editor-mode")).toHaveText("New event");
  await expect(page.getByTestId("editor-title")).toHaveValue("Design sync");
  await expect(page.getByTestId("editor-start-time")).toHaveValue("14:00");
  await expect(page.getByTestId("editor-end-time")).toHaveValue("14:30");
  await page.getByTestId("editor-attendee-input").fill("sam@contoso.com");
  await page.getByTestId("editor-attendee-input").press("Enter");
  await page.getByTestId("editor-private").check();
  await page.getByTestId("rich-editor").click();
  await page.keyboard.type("Agenda: mockups");
  await expect(page.getByTestId("editor-save")).toHaveText("Send");
  await snap(page, testInfo, "editor-new");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("toast")).toContainText("Sent “Design sync” to 1 guest");
  await expect.poll(() => sentOf(fake, "create-event").length, { timeout: 10_000 }).toBe(1);
  const b = sentOf(fake, "create-event")[0].body;
  expect(b.subject).toBe("Design sync");
  expect(b.attendees).toEqual([{ emailAddress: { address: "sam@contoso.com", name: "sam@contoso.com" }, type: "required" }]);
  expect(b.sensitivity).toBe("private");
  expect(b.body.content).toContain("Agenda: mockups");
});

test("Esc with unsaved changes asks first; nothing is sent", async ({ inbox: page, fake }) => {
  await openEditor(page, "evt-lunch");
  await page.getByTestId("editor-title").fill("Changed my mind");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-discard")).toBeVisible();
  await expect(page.getByTestId("event-editor")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("event-editor")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(sentOf(fake, "update-event")).toEqual([]);

  // No changes: Esc just closes.
  await openEditor(page, "evt-lunch");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("event-editor")).toHaveCount(0);
});

test("a Microsoft 365 location suggests rooms; picking one books it as a room guest", async ({ inbox: page, fake }, testInfo) => {
  await page.keyboard.press("Shift+C");
  await page.getByTestId("quick-add-input").fill("Planning tomorrow 10am");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("event-editor")).toBeVisible();
  const loc = page.getByTestId("editor-location");
  await loc.click();
  // All the rooms on focus, narrowed as you type.
  await expect(page.getByTestId("editor-room")).toHaveCount(3);
  await loc.fill("hud");
  await expect(page.getByTestId("editor-room")).toHaveText(["Huddle 1"]);
  await loc.fill("");
  await loc.pressSequentially("board");
  await snap(page, testInfo, "editor-rooms");
  await loc.press("Enter");
  await expect(loc).toHaveValue("Boardroom");
  await expect(page.getByTestId("editor-location-room")).toBeVisible();
  const room = page.locator("[data-testid=editor-attendee][data-room=true]");
  await expect(room).toHaveAttribute("data-address", "boardroom@contoso.com");

  // Choosing another room swaps it, rather than booking both.
  await loc.fill("");
  await loc.pressSequentially("Room 4");
  await page.getByTestId("editor-room").first().click();
  await expect(room).toHaveCount(1);
  await expect(room).toHaveAttribute("data-address", "room4@contoso.com");

  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOf(fake, "create-event").length, { timeout: 10_000 }).toBe(1);
  const b = sentOf(fake, "create-event")[0].body;
  expect(b.location).toEqual({ displayName: "Room 4", locationEmailAddress: "room4@contoso.com", locationType: "conferenceRoom" });
  expect(b.attendees).toEqual([{ emailAddress: { address: "room4@contoso.com", name: "Room 4" }, type: "resource" }]);
});

test("typing over a booked room, or removing its chip, un-books it", async ({ inbox: page, fake }) => {
  await openEditor(page, "evt-lunch");
  const loc = page.getByTestId("editor-location");
  await loc.fill("");
  await loc.pressSequentially("Huddle");
  await loc.press("Enter");
  const room = page.locator("[data-testid=editor-attendee][data-room=true]");
  await expect(room).toHaveCount(1);
  // Removing the room chip clears the location it filled in.
  await room.getByTestId("editor-attendee-remove").click();
  await expect(room).toHaveCount(0);
  await expect(loc).toHaveValue("");
  // Pick it again, then type something else: no room any more.
  await loc.pressSequentially("Huddle");
  await loc.press("Enter");
  await expect(room).toHaveCount(1);
  await loc.press("End");
  await loc.pressSequentially(" (or the kitchen)");
  await expect(room).toHaveCount(0);
  await expect(page.getByTestId("editor-location-room")).toHaveCount(0);
  await page.keyboard.press("Escape"); // close the suggestions
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOf(fake, "update-event").length, { timeout: 10_000 }).toBe(1);
  const b = sentOf(fake, "update-event")[0].body;
  expect(b.location).toEqual({ displayName: "Huddle 1 (or the kitchen)" });
  expect(b.attendees).toBeUndefined();
});

test("an event with a booked room reopens showing it as a room", async ({ inbox: page }) => {
  await openEditor(page, "evt-lunch");
  const loc = page.getByTestId("editor-location");
  await loc.fill("");
  await loc.pressSequentially("Boardroom");
  await loc.press("Enter");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("event-editor")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Saved");
  await page.waitForTimeout(1500); // let the outbox send it
  await openEditor(page, "evt-lunch");
  await expect(page.getByTestId("editor-location")).toHaveValue("Boardroom");
  await expect(page.getByTestId("editor-location-room")).toBeVisible();
  await expect(page.locator("[data-testid=editor-attendee][data-room=true]")).toHaveAttribute("data-address", "boardroom@contoso.com");
});
