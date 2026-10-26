import { signIn } from "../harness/app.ts";
import { localAt } from "../harness/calendar-fixtures.ts";
import { test, expect, row, snap, waitForSyncIdle, showRecentPane } from "./fixtures";

type Fake = Parameters<Parameters<typeof test>[2]>[0]["fake"];
type Page = import("@playwright/test").Page;

const labels = (page: Page) => page.getByTestId("meeting-label").allTextContents();

async function openMovedMeeting(page: Page) {
  await row(page, "conv-update").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
}

test("a meeting moved after you accepted shows your acceptance and asks about the new time", async ({ inbox: page, fake }, testInfo) => {
  await openMovedMeeting(page);
  await expect.poll(() => labels(page)).toEqual(["Invitation", "You accepted", "Updated invitation"]);

  const card = page.getByTestId("invite-card");
  await expect(card).toContainText("Updated");
  // The old time is shown struck through.
  const oldStart = localAt(2, 14, 0);
  await expect(page.getByTestId("invite-changed")).toContainText("Time changed");
  await expect(page.getByTestId("invite-changed")).toContainText(oldStart.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  await expect(page.getByTestId("invite-location-changed")).toContainText("Room 1");
  await expect(page.getByTestId("invite-status")).toHaveText("You accepted the earlier time. This update needs your response.");
  await snap(page, testInfo, "moved-meeting");

  await page.keyboard.press("y");
  await expect(page.getByTestId("invite-status")).toHaveText("You're going");
  await expect.poll(async () => (await fake.control("event?id=evt-update")).responseStatus.response, { timeout: 10_000 }).toBe("accepted");
});

async function signInWith(page: Page, fake: Fake, config: Record<string, unknown>) {
  await fake.control("config", config);
  await signIn(page, fake.clientId);
  await waitForSyncIdle(page);
}

test("invites are recognised even when sync responses leave out @odata.type", async ({ page, fake }) => {
  await signInWith(page, fake, { omitODataType: true });
  await openMovedMeeting(page);
  await expect.poll(() => labels(page)).toEqual(["Invitation", "You accepted", "Updated invitation"]);
});

test("if Graph rejects the meeting-type field, sync falls back and @odata.type still identifies invites", async ({ page, fake }) => {
  await signInWith(page, fake, { rejectMeetingSelect: true });
  const inbox = fake.state.requests.filter((r) => r.path.endsWith("/AAMkAGI2-inbox/messages/delta"));
  expect(inbox[0].status).toBe(400);
  expect(inbox.find((r) => r.status === 200)!.query).not.toContain("meetingMessageType");
  await row(page, "conv-update").click();
  await expect(page.getByTestId("invite-card")).toBeVisible();
});

test("viewing an invite jumps the calendar sidebar to its day and highlights it among that day's events", async ({ inbox: page }, testInfo) => {
  await showRecentPane(page); // the sidebar on Recent Opens: viewing the invite switches it, leaving restores it
  await openMovedMeeting(page);

  // The sidebar switches to the calendar on the meeting's day.
  await expect(page.getByTestId("day-view")).toBeVisible();
  const day = localAt(3, 10).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  await expect(page.getByTestId("day-label")).toContainText(day);
  const meeting = page.locator('[data-testid=cal-event][data-remote-id="evt-update"]');
  await expect(meeting).toHaveAttribute("data-focused", "true");
  await expect(meeting).toBeInViewport();
  // In context: the clashing call sits beside it.
  const clash = page.locator('[data-testid=cal-event][data-remote-id="evt-clash"]');
  await expect(clash).toBeVisible();
  await expect(meeting).toHaveAttribute("data-cols", "2");
  await snap(page, testInfo, "invite-in-context");

  // Answering updates the highlighted event too.
  await page.keyboard.press("y");
  await expect(meeting).toHaveAttribute("data-response", "accepted");

  // Leaving the invite restores the sidebar.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pane-tab-recent")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("0");
  await expect(page.getByTestId("day-label")).toContainText("Today");
});
