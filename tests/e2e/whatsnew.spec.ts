import { test, expect, openSettings } from "./fixtures";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { allIds, parseChangelog } from "../../src/lib/changelog.ts";

const sections = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
const ids = allIds(sections);
const first = sections.find((s) => s.entries.length)!.entries[0];

const invoke = (page: Page, cmd: string, args?: Record<string, unknown>) =>
  page.evaluate(([cmd, args]) => (window as any).__TAURI_INTERNALS__.invoke(cmd, args), [cmd, args] as const);

/** As if the app had just updated: everything seen except `unseenIds`. */
async function afterUpdate(page: Page, unseenIds: string[]) {
  await invoke(page, "set_changelog_seen", { ids: ids.filter((id) => !unseenIds.includes(id)) });
  await page.reload();
  await expect(page.getByTestId("inbox")).toBeVisible({ timeout: 15_000 });
}

test("a first run announces nothing, and remembers the whole changelog as seen", async ({ inbox: page }) => {
  await expect(page.getByTestId("whats-new")).toHaveCount(0);
  expect(await invoke(page, "changelog_seen")).toEqual(ids);
});

test("after an update, the lines not seen yet show once", async ({ inbox: page }) => {
  await afterUpdate(page, [first.id]);
  const panel = page.getByTestId("whats-new");
  await expect(panel).toHaveAttribute("data-mode", "new");
  await expect(panel.getByTestId("whats-new-entry")).toHaveCount(1);
  // Markdown is rendered (the changelog uses **bold**), not shown raw.
  await expect(panel.getByTestId("whats-new-entry")).not.toContainText("**");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await expect.poll(async () => (await invoke(page, "changelog_seen")).length).toBe(ids.length);
  await page.reload();
  await expect(page.getByTestId("inbox")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(page.getByTestId("whats-new")).toHaveCount(0);
});

test("the whole changelog opens from the palette and from Settings, new lines marked", async ({ inbox: page }) => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("What's new");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("whats-new");
  await expect(panel).toHaveAttribute("data-mode", "all");
  await expect(panel.getByTestId("whats-new-entry")).toHaveCount(ids.length);
  await expect(panel.locator('[data-testid=whats-new-entry][data-new="true"]')).toHaveCount(0);
  await page.getByTestId("whats-new-ok").click();

  await openSettings(page, "updates");
  await page.getByTestId("settings-whats-new").click();
  await expect(page.getByTestId("whats-new")).toHaveAttribute("data-mode", "all");
});
