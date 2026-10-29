import { test, expect, row, syncNow } from "./fixtures";
import type { Page } from "@playwright/test";

type Sent = Record<string, any>;
const sentOfKind = (fake: { state: { sent: Sent[] } }, kind: string) => fake.state.sent.filter((s) => s.kind === kind);
const draftRowsInList = (page: Page) => page.locator('[data-testid=thread-row][data-draft=true]');

test("a new draft is its own row at the top of the Inbox; Enter carries on with it, # discards it", async ({ inbox: page, fake }, testInfo) => {
  const count = await page.getByTestId("thread-count").textContent();
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("priya@fabrikam.io");
  await page.getByTestId("compose-subject").fill("Half-written");
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("To be continued");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);

  // Newest first, so it's the top row, marked Draft.
  const first = page.getByTestId("thread-row").first();
  await expect(first).toHaveAttribute("data-draft", "true");
  await expect(first).toContainText("Draft");
  await expect(first).toContainText("priya@fabrikam.io");
  await expect(first).toContainText("Half-written");
  await expect(first).toContainText("To be continued");
  // Still a count of conversations.
  await expect(page.getByTestId("thread-count")).toHaveText(count!);
  await testInfo.attach("inbox-draft.png", { body: await page.screenshot(), contentType: "image/png" });

  // The keys reach it like any row; e and the like don't apply to it.
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("e");
  await expect(page.getByTestId("toast")).toContainText("That's a draft");
  await expect(draftRowsInList(page)).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("compose-subject")).toHaveValue("Half-written");
  await page.getByTestId("compose-body").click();
  await page.keyboard.press("End");
  await page.keyboard.type(", and done");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  await expect(draftRowsInList(page)).toHaveCount(0);

  await page.keyboard.press("c");
  await page.getByTestId("compose-subject").fill("Throwaway");
  await page.keyboard.press("Escape");
  await expect(draftRowsInList(page)).toHaveCount(1);
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await page.keyboard.press("#");
  await expect(page.getByTestId("toast")).toContainText("Draft discarded");
  await expect(draftRowsInList(page)).toHaveCount(0);
});

test("drafts only show in the Inbox itself, not in a split or another mailbox", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-subject").fill("Only in the Inbox");
  await page.keyboard.press("Escape");
  await expect(draftRowsInList(page)).toHaveCount(1);
  await page.keyboard.press("Tab"); // the Other split
  await expect(draftRowsInList(page)).toHaveCount(0);
  await page.keyboard.press("g");
  await page.keyboard.press("e");
  await expect(page.getByTestId("mailbox-title")).toHaveText("Done");
  await expect(draftRowsInList(page)).toHaveCount(0);
});

test("a drafted reply stays with its conversation: marked in the list, shown under the messages, r carries on with it", async ({ inbox: page, fake }, testInfo) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Let me check");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);

  // Not a row of its own; under the conversation instead.
  await expect(page.getByTestId("thread-draft")).toContainText("Let me check");
  await testInfo.attach("thread-draft.png", { body: await page.screenshot(), contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(draftRowsInList(page)).toHaveCount(0);
  await expect(row(page, "conv-plain").getByTestId("thread-draft-badge")).toBeVisible();

  // r (or a, or f) carries on with the draft rather than starting another reply.
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("a");
  const composer = page.getByTestId("reader").getByTestId("composer");
  await expect(composer).toHaveAttribute("data-inline", "true");
  await expect(page.getByTestId("compose-body")).toHaveAttribute("data-text", "Let me check");
  await expect(page.getByTestId("thread-draft")).toHaveCount(0);
  await page.getByTestId("compose-body").click();
  await page.keyboard.press("End");
  await page.keyboard.type(": Sunday's fine");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "reply").length, { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId("thread-draft")).toHaveCount(0);
});

test("a reply drafted in Outlook shows with its conversation too", async ({ inbox: page, fake }) => {
  await fake.control("draft", { subject: "RE: Weekend plans", html: "<div>Drafted on my phone</div>", to: ["mum@outlook.com"], conversationId: "conv-plain" });
  await syncNow(page, fake);
  await expect(row(page, "conv-plain").getByTestId("thread-draft-badge")).toBeVisible();
  await expect(draftRowsInList(page)).toHaveCount(0);
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  // There under the messages, ready to carry on with.
  await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("compose-body")).toHaveAttribute("data-text", "Drafted on my phone");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
});

test("a reply being written stays with its conversation when you move to another, and is there when you come back", async ({ inbox: page }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Half a reply");
  // To the next conversation, from the toolbar.
  await page.getByTestId("reader-next").click();
  await expect(page.getByTestId("reader")).not.toHaveAttribute("data-conversation-id", "conv-plain");
  // Not popped out over everything: put away with its conversation.
  await expect(page.getByTestId("composer")).toHaveCount(0);

  await page.keyboard.press("k"); // back
  await expect(page.getByTestId("reader")).toHaveAttribute("data-conversation-id", "conv-plain");
  const composer = page.getByTestId("reader").getByTestId("composer");
  await expect(composer).toHaveAttribute("data-inline", "true");
  await expect(page.getByTestId("compose-body")).toHaveAttribute("data-text", "Half a reply");
  // It doesn't take the keyboard: j and k still move through conversations.
  await expect(composer).toHaveAttribute("data-active", "false");
  await page.keyboard.press("j");
  await expect(page.getByTestId("reader")).not.toHaveAttribute("data-conversation-id", "conv-plain");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await page.keyboard.press("k");
  await expect(composer).toBeVisible();
  // r puts the cursor in it, to carry on.
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await expect(composer).toHaveAttribute("data-active", "true");
  await page.keyboard.press("End");
  await page.keyboard.type(", finished");
  await expect(page.getByTestId("compose-body")).toHaveAttribute("data-text", "Half a reply, finished");
  // Esc (from inside it) closes it; it stays a card here, and Esc again goes back to the list.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("thread-draft")).toContainText("Half a reply, finished");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("reader")).toHaveCount(0);
});

test("in the reading pane too, a reply stays with its conversation", async ({ inbox: page }) => {
  await page.keyboard.press("v");
  await row(page, "conv-plain").click();
  await expect(page.getByTestId("preview-pane").getByTestId("message").first()).toBeVisible();
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Pane reply");
  await row(page, "conv-hostile").click();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await row(page, "conv-plain").click();
  const composer = page.getByTestId("preview-pane").getByTestId("composer");
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("compose-body")).toHaveAttribute("data-text", "Pane reply");
});
