import { test, expect, row, snap, syncNow, waitForSyncIdle } from "./fixtures";
import type { Page } from "@playwright/test";
import { WORK_ACCOUNT } from "../harness/fake-pair.ts";

test.use({ secondAccount: true });

type Pair = Parameters<Parameters<typeof test>[2]>[0]["pair"];

async function addWorkAccount(page: Page, pair: Pair) {
  pair.signInAs("b");
  await page.keyboard.press("Control+,");
  await page.getByTestId("account-add").click();
  await expect(page.locator(`[data-testid=account-row][data-email="${WORK_ACCOUNT.mail}"]`)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await waitForSyncIdle(page);
  await expect(row(page, "work-conv-contract")).toBeVisible({ timeout: 15_000 });
}

const sentOf = (f: { state: { sent: Record<string, any>[] } }, kind: string) => f.state.sent.filter((s) => s.kind === kind);

test("a second account joins the unified inbox, each row marked with its account", async ({ inbox: page, pair }, testInfo) => {
  await expect(page.getByTestId("row-account")).toHaveCount(0); // one account: no markers
  await addWorkAccount(page, pair);

  await expect(row(page, "conv-plain")).toBeVisible();
  const work = row(page, "work-conv-contract");
  const home = row(page, "conv-plain");
  expect(await work.getAttribute("data-account-id")).not.toBe(await home.getAttribute("data-account-id"));
  await expect(work.getByTestId("row-account")).toHaveAttribute("title", WORK_ACCOUNT.mail);
  // The footer is a legend for the dots: one entry per account, in the same colours.
  const legend = page.getByTestId("footer-account");
  await expect(legend).toHaveCount(2);
  await expect(legend.nth(1)).toHaveAttribute("data-email", WORK_ACCOUNT.mail);
  const colour = async (l: import("@playwright/test").Locator) => (await l.getAttribute("class"))?.match(/bg-[a-z]+-\d+/)?.[0];
  expect(await colour(legend.nth(1).locator("span").first())).toBe(await colour(work.getByTestId("row-account")));
  expect(await colour(legend.nth(0).locator("span").first())).not.toBe(await colour(work.getByTestId("row-account")));
  await snap(page, testInfo, "unified-inbox");

  // Clicking an entry toggles that account's mail off and on (counts follow).
  const inboxTab = page.getByTestId("split-tab").first();
  const countBefore = await inboxTab.textContent();
  await legend.nth(1).click();
  await expect(legend.nth(1)).toHaveAttribute("data-hidden", "true");
  await expect(row(page, "work-conv-contract")).toHaveCount(0);
  await expect(row(page, "conv-plain")).toBeVisible();
  await expect(inboxTab).not.toHaveText(countBefore!);
  // Remembered across a reload.
  await page.reload();
  await expect(page.getByTestId("footer-account").nth(1)).toHaveAttribute("data-hidden", "true");
  await expect(row(page, "conv-plain")).toBeVisible();
  await expect(row(page, "work-conv-contract")).toHaveCount(0);
  // The last visible account can't be hidden.
  await page.getByTestId("footer-account").nth(0).click();
  await expect(page.getByTestId("toast")).toContainText("At least one account stays visible");
  await expect(row(page, "conv-plain")).toBeVisible();
  // And back on.
  await page.getByTestId("footer-account").nth(1).click();
  await expect(page.getByTestId("footer-account").nth(1)).toHaveAttribute("data-hidden", "false");
  await expect(row(page, "work-conv-contract")).toBeVisible();
  await expect(inboxTab).toHaveText(countBefore!);

  // account: narrows to one mailbox.
  await page.keyboard.press("/");
  await page.keyboard.type("account:work");
  await expect(page.getByTestId("thread-row")).toHaveCount(3);
  await expect(page.locator("[data-testid=thread-row][data-conversation-id^=work-]")).toHaveCount(3);
});

test("replies go from the account the mail came to; new mail can pick its From", async ({ inbox: page, pair }) => {
  await addWorkAccount(page, pair);
  await row(page, "work-conv-contract").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  const from = page.getByTestId("compose-from");
  await expect(from).toBeDisabled();
  await expect(from.locator("option:checked")).toContainText(WORK_ACCOUNT.mail);
  await expect(page.getByTestId("compose-to")).toHaveValue("legal@work.example");
  await page.keyboard.type("Signed and attached.");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOf(pair.second, "reply").length, { timeout: 10_000 }).toBe(1);
  expect(sentOf(pair.second, "reply")[0].messageId).toBe("work-1");
  expect(sentOf(pair, "reply")).toEqual([]);

  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await page.getByTestId("compose-from").selectOption({ label: `${WORK_ACCOUNT.displayName} <${WORK_ACCOUNT.mail}>` });
  await page.getByTestId("compose-to").fill("ana@work.example");
  await page.getByTestId("compose-subject").fill("Venue");
  await page.getByTestId("compose-body").fill("Booked.");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOf(pair.second, "new").length, { timeout: 10_000 }).toBe(1);
  expect(sentOf(pair, "new")).toEqual([]);
});

test("triage acts on the right mailbox, and sync pulls new mail into both", async ({ inbox: page, pair }) => {
  await addWorkAccount(page, pair);
  await row(page, "work-conv-offsite").click(); // opens it
  await expect(page.getByTestId("reader")).toHaveAttribute("data-conversation-id", "work-conv-offsite");
  await page.keyboard.press("e");
  await expect(page.getByTestId("reader")).not.toHaveAttribute("data-conversation-id", "work-conv-offsite");
  await page.keyboard.press("Escape"); // back to the list
  await expect(row(page, "work-conv-offsite")).toHaveCount(0);
  await expect.poll(async () => (await pair.second.control("message?id=work-3")).parentFolderId, { timeout: 10_000 }).toBe("AAMkAGI2-archive");

  await pair.second.control("deliver", { from: ["Ana Ruiz", "ana@work.example"], subject: "Lunch Friday?", to: [[WORK_ACCOUNT.displayName, WORK_ACCOUNT.mail]] });
  await pair.control("deliver", { subject: "Home news" });
  await syncNow(page, pair);
  await expect(page.locator("[data-testid=thread-row]", { hasText: "Lunch Friday?" })).toBeVisible();
  await expect(page.locator("[data-testid=thread-row]", { hasText: "Home news" })).toBeVisible();
});

test("signing one account out takes its mail out of the inbox and keeps the other", async ({ inbox: page, pair }) => {
  await addWorkAccount(page, pair);
  await page.keyboard.press("Control+,");
  await page.locator(`[data-testid=account-row][data-email="${WORK_ACCOUNT.mail}"]`).getByTestId("account-signout").click();
  await expect(page.getByTestId("account-row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(row(page, "work-conv-contract")).toHaveCount(0);
  await expect(row(page, "conv-plain")).toBeVisible();
  await expect(page.getByTestId("footer-account")).toHaveCount(0);
  await expect(page.getByTestId("row-account")).toHaveCount(0);
});
