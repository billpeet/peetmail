import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, showCalendarPane, snap } from "./fixtures";

const TEAMS = "https://teams.microsoft.com/meet/497178154226638?p=q8OarGuMU3YgdVWxcF";

/** Links the app opened (recorded by the harness instead of launching a browser). */
function opened(app: { dataDir: string }) {
  return () => readFile(join(app.dataDir, "opened.txt"), "utf8").then((t) => t.split("\n").filter(Boolean), () => [] as string[]);
}

test("a Teams link in the location is a join link: the calendar shows Join, and it opens without the popup", async ({ inbox: page, app }, testInfo) => {
  const links = opened(app);
  await showCalendarPane(page);
  const block = page.locator('[data-testid=cal-event][data-remote-id="evt-helpdesk"]');
  await block.scrollIntoViewIfNeeded();
  const chip = block.getByTestId("cal-join");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-live", "true"); // on now: a "Join" pill
  await expect(chip).toHaveText("Join");
  await expect(chip).toHaveAttribute("title", "Join Microsoft Teams");
  await snap(page, testInfo, "calendar-join");
  await chip.click();
  await expect.poll(links).toEqual([TEAMS]);
  await expect(page.getByTestId("event-details")).toHaveCount(0); // didn't open the event

  // The popup offers it too.
  await block.click();
  await expect(page.getByTestId("event-join-link")).toHaveText("Microsoft Teams meeting");
  await page.keyboard.press("j");
  await expect.poll(async () => (await links()).length).toBe(2);
  await page.keyboard.press("Escape");

  // And the week view.
  await page.keyboard.press("2");
  await expect(page.locator('[data-testid=week-event][data-remote-id="evt-helpdesk"]').getByTestId("week-join")).toBeVisible();
});

test("events without a meeting link get no Join; a link only in the description shows in the popup", async ({ inbox: page }) => {
  await showCalendarPane(page);
  await expect(page.locator('[data-testid=cal-event][data-remote-id="evt-lunch"]').getByTestId("cal-join")).toHaveCount(0);
  // evt-1on1's Teams link is only in its description: no chip on the block, but the popup finds it.
  const oneOnOne = page.locator('[data-testid=cal-event][data-remote-id="evt-1on1"]');
  await expect(oneOnOne.getByTestId("cal-join")).toHaveCount(0);
  await oneOnOne.click();
  await expect(page.getByTestId("event-join-link")).toHaveText("Microsoft Teams meeting");
  await expect(page.getByTestId("event-join")).toBeVisible();
});
