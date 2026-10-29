import { test, expect, row, waitForSyncIdle } from "./fixtures";
import type { Page } from "@playwright/test";
import { killTree, launchApp } from "../harness/app.ts";

type Sent = Record<string, any>;
const sentOfKind = (fake: { state: { sent: Sent[] } }, kind: string) => fake.state.sent.filter((s) => s.kind === kind);
const draftRows = (page: Page) => page.getByTestId("draft-row");

async function goToDrafts(page: Page) {
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(page.getByTestId("drafts")).toBeVisible();
}

test("Esc keeps the message in Drafts; Enter reopens it as it was, and sending it clears the draft", async ({ inbox: page, fake }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("priya@fabrikam.io");
  await page.getByTestId("compose-show-bcc").click();
  await page.getByTestId("compose-bcc").fill("sam.carter@contoso.com");
  await page.getByTestId("compose-subject").fill("Offsite venue");
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("Shortlist: ");
  await page.keyboard.press("Control+B");
  await page.keyboard.type("the boathouse");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Saved to Drafts");

  await goToDrafts(page);
  await expect(draftRows(page)).toHaveCount(1);
  await expect(page.getByTestId("thread-count")).toHaveText("1 draft");
  await expect(draftRows(page)).toContainText("priya@fabrikam.io");
  await expect(draftRows(page)).toContainText("Offsite venue");
  await expect(draftRows(page)).toContainText("Shortlist: the boathouse");

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("compose-to")).toHaveValue("priya@fabrikam.io");
  await expect(page.getByTestId("compose-bcc")).toHaveValue("sam.carter@contoso.com");
  await expect(page.getByTestId("compose-subject")).toHaveValue("Offsite venue");
  await expect(page.getByTestId("compose-body").locator("strong")).toHaveText("the boathouse");
  await expect(page.getByTestId("compose-hint")).toHaveText("Draft saved");
  await page.getByTestId("compose-body").click();
  await page.keyboard.press("End");
  await page.keyboard.type(", or the barn");
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  const html: string = sentOfKind(fake, "new")[0].html;
  expect(html).toContain("Shortlist: <strong>the boathouse");
  expect(html).toContain(", or the barn");
  await expect(page.getByTestId("drafts-empty")).toBeVisible();
});

test("an empty composer closes without leaving a draft", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  // A reply you haven't written anything in isn't a draft either.
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await goToDrafts(page);
  await expect(page.getByTestId("drafts-empty")).toBeVisible();
});

test("Ctrl+Shift+D discards; # discards from the list", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-subject").fill("Never mind");
  await expect(page.getByTestId("compose-hint")).toHaveText("Draft saved"); // saved as you type
  await page.keyboard.press("Control+Shift+D");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Draft discarded");
  await goToDrafts(page);
  await expect(page.getByTestId("drafts-empty")).toBeVisible();

  await page.keyboard.press("c");
  await page.getByTestId("compose-subject").fill("Also never mind");
  await page.keyboard.press("Escape");
  await expect(draftRows(page)).toHaveCount(1);
  await page.keyboard.press("#");
  await expect(page.getByTestId("drafts-empty")).toBeVisible();
});

test("starting another message keeps the one you were writing", async ({ inbox: page }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("First thought");
  // Forward instead, from the toolbar: the reply is kept.
  await page.getByTestId("reader-forward").click();
  await expect(page.getByTestId("compose-subject")).toHaveValue("FW: Weekend plans");
  await expect(page.getByTestId("toast")).toContainText("Saved to Drafts");
  await page.getByTestId("compose-to").fill("sam.carter@contoso.com");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await goToDrafts(page);
  await expect(draftRows(page)).toHaveCount(2);
  await expect(draftRows(page).first()).toContainText("Forward");
  await expect(draftRows(page).nth(1)).toContainText("First thought");
});

test("a reply kept as a draft reopens as a reply and threads when sent", async ({ inbox: page, fake }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Let me check the calendar");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await goToDrafts(page);
  await expect(draftRows(page)).toContainText("Reply");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("compose-to")).toHaveValue("mum@outlook.com");
  await expect(page.getByTestId("compose-subject")).toHaveValue("RE: Weekend plans");
  await page.getByTestId("compose-body").click();
  await page.keyboard.press("End");
  await page.keyboard.type(": Sunday works");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "reply").length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "reply")[0].messageId).toBe("msg-plain");
  expect(sentOfKind(fake, "reply")[0].html).toContain("Let me check the calendar: Sunday works");
});

test("what you were writing survives PeetMail being killed, attachment included", async ({ inbox: page, app, fake }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("priya@fabrikam.io");
  await page.getByTestId("compose-subject").fill("Before the crash");
  await page.getByTestId("compose-file-input").setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("keep me") }]);
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("Nearly done");
  await expect(page.getByTestId("compose-hint")).toHaveText("Draft saved");
  await page.waitForTimeout(1200); // the last keystrokes' save

  // No chance to close anything: the process just ends.
  await app.browser.close().catch(() => {});
  killTree(app.proc.pid);
  const again = await launchApp({ fake, dataDir: app.dataDir });
  try {
    const p = again.page;
    await expect(p.getByTestId("inbox")).toBeVisible({ timeout: 15_000 });
    await waitForSyncIdle(p);
    await goToDrafts(p);
    await expect(draftRows(p)).toHaveCount(1);
    await p.keyboard.press("Enter");
    await expect(p.getByTestId("compose-body")).toHaveAttribute("data-text", "Nearly done");
    await expect(p.getByTestId("compose-attachment")).toContainText("notes.txt");
    await p.getByTestId("compose-body").click();
    await p.keyboard.press("Control+Enter");
    await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
    const [a] = sentOfKind(fake, "new")[0].attachments;
    expect(Buffer.from(a.content, "base64").toString()).toBe("keep me");
  } finally {
    await again.browser.close().catch(() => {});
    killTree(again.proc.pid);
  }
});
