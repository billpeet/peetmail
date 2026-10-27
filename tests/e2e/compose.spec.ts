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
  await page.keyboard.press("Control+Enter");

  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "new")[0];
  expect(sent.subject).toBe("Lunch?");
  expect(sent.to).toEqual([{ emailAddress: { address: "priya@fabrikam.io" } }]);
  expect(sent.html).toContain("<p>Thai on Friday?</p><p>B</p>");
});

test("r replies to the open conversation and the reply shows up in the thread", async ({ inbox: page, fake }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
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
  await expect(page.getByTestId("compose-to")).toHaveValue("jordan.lee@contoso.com, priya@fabrikam.io");
  await expect(page.getByTestId("compose-cc")).toHaveValue("sam.carter@contoso.com");
  await page.getByTestId("compose-body").fill("Count me in.");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "replyAll").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "replyAll")[0];
  expect(sent.to.map((r: any) => r.emailAddress.address)).toEqual(["jordan.lee@contoso.com", "priya@fabrikam.io"]);
  expect(sent.cc.map((r: any) => r.emailAddress.address)).toEqual(["sam.carter@contoso.com"]);
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
