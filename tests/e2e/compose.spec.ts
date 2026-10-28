import { test, expect, row, snap } from "./fixtures";

const sentOfKind = (fake: { state: { sent: Record<string, any>[] } }, kind: string) => fake.state.sent.filter((s) => s.kind === kind);

test("c composes a new message with contact suggestions and Ctrl+Enter sends it", async ({ inbox: page, fake }, testInfo) => {
  await page.keyboard.press("c");
  const to = page.getByTestId("compose-to");
  await expect(to).toBeFocused();
  await to.pressSequentially("priya");
  await expect(page.getByTestId("contact-suggestions")).toContainText("priya@fabrikam.io");
  await to.press("Enter");
  await expect(to).toHaveValue("priya@fabrikam.io, ");
  await page.getByTestId("compose-subject").fill("Lunch?");
  await page.getByTestId("compose-body").fill("Thai on Friday?\n\nB");
  await snap(page, testInfo, "composer");
  // New mail has no conversation to sit under: it's a dialog.
  await expect(page.getByTestId("composer")).toHaveAttribute("data-inline", "false");
  await page.keyboard.press("Control+Enter");

  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "new")[0];
  expect(sent.subject).toBe("Lunch?");
  expect(sent.to).toEqual([{ emailAddress: { address: "priya@fabrikam.io" } }]);
  expect(sent.html).toContain("<div>Thai on Friday?</div><div><br></div><div>B</div>");
});

test("r replies to the open conversation and the reply shows up in the thread", async ({ inbox: page, fake }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  // Written in the reader, under the message it answers, not in a dialog over it.
  const composer = page.getByTestId("reader").getByTestId("composer");
  await expect(composer).toHaveAttribute("data-inline", "true");
  await expect(page.getByTestId("message").last()).toBeVisible();
  await expect(page.getByTestId("compose-to")).toHaveValue("mum@outlook.com");
  await expect(page.getByTestId("compose-subject")).toHaveValue("RE: Weekend plans");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Sunday works!");
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => sentOfKind(fake, "reply").length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "reply")[0].messageId).toBe("msg-plain");
  // After sending, the app syncs and the Sent copy joins the conversation.
  await expect(page.getByTestId("message").last()).toContainText("Sent", { timeout: 10_000 });
});

test("a reply all goes to everyone except you", async ({ inbox: page, fake }) => {
  await fake.control("deliver", {
    subject: "Planning sync",
    from: ["Jordan Lee", "jordan.lee@contoso.com"],
    to: [["Boris Dragon", "boris@peetmail.test"], ["Priya Nair", "priya@fabrikam.io"]],
    cc: [["Sam Carter", "sam.carter@contoso.com"]],
  });
  await page.keyboard.press("Control+r");
  await expect(page.getByTestId("thread-row").first()).toContainText("Planning sync");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  // From the list alone the conversation isn't on screen, so it's a dialog.
  await expect(page.getByTestId("composer")).toHaveAttribute("data-inline", "false");
  await expect(page.getByTestId("compose-to")).toHaveValue("jordan.lee@contoso.com, priya@fabrikam.io");
  await expect(page.getByTestId("compose-cc")).toHaveValue("sam.carter@contoso.com");
  await page.getByTestId("compose-body").fill("Count me in.");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "replyAll").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "replyAll")[0];
  expect(sent.to.map((r: any) => r.emailAddress.address)).toEqual(["jordan.lee@contoso.com", "priya@fabrikam.io"]);
  expect(sent.cc.map((r: any) => r.emailAddress.address)).toEqual(["sam.carter@contoso.com"]);
});

test("in the reading pane, a reply is written under the conversation, with the messages above it", async ({ inbox: page }, testInfo) => {
  await page.keyboard.press("v");
  await row(page, "conv-plain").click();
  await expect(page.getByTestId("preview-pane").getByTestId("message").first()).toBeVisible();
  await page.keyboard.press("r");

  const pane = page.getByTestId("preview-pane");
  const composer = pane.getByTestId("composer");
  await expect(composer).toHaveAttribute("data-inline", "true");
  await expect(page.getByTestId("composer")).toHaveCount(1); // no dialog as well
  await expect(page.getByTestId("compose-body")).toBeFocused();
  // The conversation stays readable, above the reply.
  const last = await pane.getByTestId("message").last().boundingBox();
  const box = await composer.boundingBox();
  expect(last && box && last.y + last.height <= box.y).toBe(true);
  await snap(page, testInfo, "reply-inline");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(pane.getByTestId("message").first()).toBeVisible();
});

test("f forwards to the address you type", async ({ inbox: page, fake }) => {
  await row(page, "conv-attach").click();
  await page.keyboard.press("f");
  await expect(page.getByTestId("compose-subject")).toHaveValue("FW: Q4 plan attached");
  await page.getByTestId("compose-to").fill("hannah@northwind.dev");
  await page.getByTestId("compose-body").fill("FYI");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "forward").length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "forward")[0].to).toEqual([{ emailAddress: { address: "hannah@northwind.dev" } }]);
});

test("Esc closes an empty composer, and needs a second press once there's text", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);

  await page.keyboard.press("c");
  await page.getByTestId("compose-body").fill("half a thought");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("compose-hint")).toHaveText("Press Esc again to discard");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
});

test("sending without a recipient explains why", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-body").fill("hello?");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("toast")).toContainText("add at least one recipient");
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("Ctrl+Enter sends even while address suggestions are showing", async ({ inbox: page, fake }) => {
  await page.keyboard.press("c");
  const to = page.getByTestId("compose-to");
  await to.pressSequentially("priya@fabrikam.io");
  await expect(page.getByTestId("contact-suggestions")).toBeVisible(); // the moment a quick Ctrl+Enter lands in
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "new")[0].to).toEqual([{ emailAddress: { address: "priya@fabrikam.io" } }]);
});
