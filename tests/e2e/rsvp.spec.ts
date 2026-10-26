import { test, expect, row, snap, syncNow, showCalendarPane } from "./fixtures";

type Fake = Parameters<Parameters<typeof test>[2]>[0]["fake"];
const serverResponse = async (fake: Fake) => (await fake.control("event?id=evt-invite")).responseStatus.response as string;

test("an invite shows an RSVP card; y accepts, locally at once and on the server", async ({ inbox: page, fake }, testInfo) => {
  await row(page, "conv-invite").click();
  const card = page.getByTestId("invite-card");
  await expect(card).toContainText("Design review");
  await expect(page.getByTestId("invite-status")).toHaveText("You haven't responded yet");
  await snap(page, testInfo, "invite-card");

  await page.keyboard.press("y");
  await expect(page.getByTestId("invite-status")).toHaveText("You're going");
  await expect(page.getByTestId("rsvp-accept")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("toast")).toContainText("Accepted");
  await expect.poll(() => serverResponse(fake), { timeout: 10_000 }).toBe("accepted");
  expect(fake.state.sent.find((s) => s.kind === "rsvp")).toMatchObject({ eventId: "evt-invite", sendResponse: true });

  // The calendar reflects it too.
  await showCalendarPane(page);
  await expect(page.locator('[data-testid=cal-event][data-remote-id="evt-invite"]')).toHaveAttribute("data-response", "accepted");
});

test("Decline from the card button; m means maybe", async ({ inbox: page, fake }) => {
  await row(page, "conv-invite").click();
  await page.getByTestId("rsvp-decline").click();
  await expect(page.getByTestId("invite-status")).toHaveText("You declined");
  await expect.poll(() => serverResponse(fake), { timeout: 10_000 }).toBe("declined");
  await page.keyboard.press("m");
  await expect(page.getByTestId("invite-status")).toHaveText("You said maybe");
  await expect.poll(() => serverResponse(fake), { timeout: 10_000 }).toBe("tentativelyAccepted");
});

test("a queued RSVP survives a stale calendar delta and goes out once the server recovers", async ({ inbox: page, fake }) => {
  await fake.control("config", { failWrites: 503 });
  await row(page, "conv-invite").click();
  await expect(page.getByTestId("invite-card")).toBeVisible(); // y needs the invite loaded
  await page.keyboard.press("y");
  await expect(page.getByTestId("invite-status")).toHaveText("You're going");

  // The server still says "not responded" and reports it through delta.
  await fake.control("event", { id: "evt-invite", response: "notResponded" });
  await syncNow(page, fake);
  await showCalendarPane(page);
  await expect(page.locator('[data-testid=cal-event][data-remote-id="evt-invite"]')).toHaveAttribute("data-response", "accepted");

  // Back online: Ctrl+R retries the queued reply.
  await fake.control("config", { failWrites: 0 });
  await page.waitForTimeout(1200); // first retry backoff is 1s
  await page.keyboard.press("Control+r");
  await expect.poll(() => serverResponse(fake), { timeout: 10_000 }).toBe("accepted");
});

test("Show in calendar jumps to the event in the week view", async ({ inbox: page }) => {
  await row(page, "conv-invite").click();
  await page.getByTestId("invite-show").click();
  await expect(page.getByTestId("week-view")).toBeVisible();
  await expect(page.getByTestId("event-title")).toHaveText("Design review");
});

test("ordinary mail has no RSVP card, and y does nothing there", async ({ inbox: page, fake }) => {
  await row(page, "conv-plain").click();
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("invite-card")).toHaveCount(0);
  await page.keyboard.press("y");
  await page.waitForTimeout(300);
  expect(fake.state.sent.filter((s) => s.kind === "rsvp")).toEqual([]);
});
