import type { Page } from "@playwright/test";
import { test, expect, showCalendarPane, snap } from "./fixtures";

const event = (page: Page, remoteId: string) => page.locator(`[data-testid=cal-event][data-remote-id="${remoteId}"]`);
const description = (page: Page) => page.frameLocator("[data-testid=event-description]");
const rsvps = (fake: { state: { sent: Record<string, any>[] } }) => fake.state.sent.filter((s) => s.kind === "rsvp");

async function open(page: Page, remoteId: string) {
  await showCalendarPane(page);
  await event(page, remoteId).click();
  await expect(page.getByTestId("event-details")).toBeVisible();
}

test("a meeting shows its description, reminder, categories, online meeting and guests grouped by answer", async ({ inbox: page, fake }, testInfo) => {
  await open(page, "evt-invite");
  await expect(page.getByTestId("event-series")).toHaveCount(0); // a single meeting
  await expect(description(page).locator("li").first()).toHaveText("New onboarding mockups");
  await expect(page.getByTestId("event-reminder")).toHaveText("15 minutes before");
  await expect(page.getByTestId("event-categories")).toContainText("Design");
  await expect(page.getByTestId("event-show-as")).toHaveText("Tentative");
  await expect(page.getByTestId("event-join-link")).toHaveText("Microsoft Teams meeting");
  await expect(page.getByTestId("event-organizer")).toContainText("organiser");
  await expect(page.getByTestId("event-guest-count")).toContainText("3 guests");
  await expect(page.locator("[data-testid=event-attendee-group][data-group=none]")).toContainText("No response · 3");
  // Wide enough to read a long description: 820px, or the window less a margin.
  const panel = (await page.getByTestId("event-panel").boundingBox())!;
  const viewport = await page.evaluate(() => window.innerWidth);
  expect(panel.width).toBeGreaterThanOrEqual(Math.min(820, viewport - 64) - 1);
  await snap(page, testInfo, "event-details-meeting");

  // A single meeting answers at once, no scope question.
  await page.keyboard.press("y");
  await expect(page.getByTestId("event-rsvp-scope")).toHaveCount(0);
  await expect(page.getByTestId("event-response")).toContainText("Accepted");
  await expect.poll(() => rsvps(fake)).toEqual([expect.objectContaining({ eventId: "evt-invite", response: "accepted" })]);
});

test("an occurrence says it's part of a series, shows the pattern, and asks what an answer covers", async ({ inbox: page, fake }, testInfo) => {
  await open(page, "evt-standup-10"); // today's standup
  const banner = page.getByTestId("event-series");
  await expect(banner).toContainText("One occurrence of a recurring series");
  await expect(page.getByTestId("event-recurrence")).toHaveText("Every day");
  await snap(page, testInfo, "event-details-occurrence");

  // Declining asks: this occurrence or the series?
  await page.keyboard.press("n");
  await expect(page.getByTestId("event-rsvp-scope")).toBeVisible();
  await snap(page, testInfo, "event-rsvp-scope");
  await page.keyboard.press("s");
  await expect(page.getByTestId("toast")).toContainText("Declined the series");
  await expect.poll(() => rsvps(fake)).toEqual([expect.objectContaining({ eventId: "evt-standup-series", response: "declined" })]);

  // Answering just this one goes to the occurrence.
  await page.getByTestId("event-rsvp-accept").click();
  await page.getByTestId("rsvp-scope-one").click();
  await expect(page.getByTestId("toast")).toContainText("Accepted this occurrence");
  await expect.poll(() => rsvps(fake).at(-1)).toEqual(expect.objectContaining({ eventId: "evt-standup-10", response: "accepted" }));
});

test("a long description with fixed-width content never scrolls inside its frame: one scrollbar", async ({ inbox: page }, testInfo) => {
  await open(page, "evt-1on1");
  const frame = page.getByTestId("event-description");
  await expect(description(page).locator("p").first()).toHaveText("Hello All,");
  // The frame is as tall as its content (no vertical scroll inside) ...
  await expect.poll(async () => frame.evaluate((f: HTMLIFrameElement) => {
    const d = f.contentDocument!.documentElement;
    return d.scrollHeight - f.clientHeight;
  })).toBeLessThanOrEqual(1);
  // ... and nothing makes the frame itself scroll sideways: wide tables are fitted to it.
  const sideways = await frame.evaluate((f: HTMLIFrameElement) => f.contentDocument!.documentElement.scrollWidth - f.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);
  const disclaimerFits = await frame.evaluate((f: HTMLIFrameElement) => {
    const td = f.contentDocument!.querySelector("td")!;
    return td.getBoundingClientRect().right <= f.clientWidth + 1;
  });
  expect(disclaimerFits).toBe(true);
  // The popup's own area does the scrolling.
  const scroll = page.getByTestId("event-scroll");
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await snap(page, testInfo, "event-long-description");
});

test("more than 5 guests collapse to the first 5, with a link to show them all", async ({ inbox: page }) => {
  await open(page, "evt-allhands");
  await expect(page.getByTestId("event-guest-count")).toContainText("12 guests");
  const list = page.getByTestId("event-attendees");
  await expect(list).toHaveAttribute("data-collapsed", "true");
  await expect(list.locator("li")).toHaveCount(5);
  await expect(list).toContainText("No response · 12"); // the group's real size
  const expand = page.getByTestId("event-attendees-expand");
  await expect(expand).toHaveText("Show all 12 guests");
  await expand.click();
  await expect(list.locator("li")).toHaveCount(12);
  await expect(expand).toHaveText("Show fewer");

  // A short list isn't collapsed.
  await page.keyboard.press("Escape");
  await open(page, "evt-invite");
  await expect(page.getByTestId("event-attendees-expand")).toHaveCount(0);
  await expect(page.getByTestId("event-attendees").locator("li")).toHaveCount(3);
});

test("private events and ones without a reminder say so", async ({ inbox: page }) => {
  await open(page, "evt-lunch");
  await expect(page.getByTestId("event-private")).toHaveText("Private");
  await expect(page.getByTestId("event-reminder")).toHaveText("No reminder");
  await expect(page.getByTestId("event-rsvp")).toHaveCount(0); // your own event
});
