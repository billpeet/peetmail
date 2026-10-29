import { test, expect, row } from "./fixtures";
import type { Page } from "@playwright/test";

type Sent = Record<string, any>;
const sentOfKind = (fake: { state: { sent: Sent[] } }, kind: string) => fake.state.sent.filter((s) => s.kind === kind);
const addresses = (list: Sent[]) => list.map((r) => r.emailAddress.address);

async function newMessage(page: Page, to: string, subject: string) {
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill(to);
  await page.getByTestId("compose-subject").fill(subject);
  await page.getByTestId("compose-body").click();
  // Keys sent the instant after the click can beat the editor's focus.
  await expect(page.getByTestId("compose-body")).toBeFocused();
}

test("Ctrl+Shift+B adds Bcc; the blind copies go out but not to the visible recipients' fields", async ({ inbox: page, fake }) => {
  await newMessage(page, "priya@fabrikam.io", "Offer");
  await expect(page.getByTestId("compose-bcc")).toHaveCount(0);
  // From an address field too, not only the text.
  await page.getByTestId("compose-to").focus();
  await page.keyboard.press("Control+Shift+B");
  const bcc = page.getByTestId("compose-bcc");
  await expect(bcc).toBeFocused();
  await bcc.pressSequentially("sam");
  await expect(page.getByTestId("contact-suggestions")).toContainText("sam.carter@contoso.com");
  await bcc.press("Enter");
  await expect(bcc).toHaveValue("sam.carter@contoso.com, ");
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("Details below.");
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "new")[0];
  expect(addresses(sent.to)).toEqual(["priya@fabrikam.io"]);
  expect(sent.cc).toEqual([]);
  expect(addresses(sent.bcc)).toEqual(["sam.carter@contoso.com"]);
});

test("a message can go to Bcc alone", async ({ inbox: page, fake }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-show-bcc").click();
  await page.getByTestId("compose-bcc").fill("team@contoso.com");
  await page.getByTestId("compose-subject").fill("Quiet announcement");
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("Hello all");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "new")[0].to).toEqual([]);
  expect(addresses(sentOfKind(fake, "new")[0].bcc)).toEqual(["team@contoso.com"]);
});

test("replies and forwards carry Bcc (and a forward its Cc)", async ({ inbox: page, fake }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.press("Control+Shift+B");
  await page.keyboard.type("dad@outlook.com");
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("See you Sunday");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "reply").length, { timeout: 10_000 }).toBe(1);
  expect(addresses(sentOfKind(fake, "reply")[0].bcc)).toEqual(["dad@outlook.com"]);

  await page.keyboard.press("f");
  await page.getByTestId("compose-to").fill("sam.carter@contoso.com");
  await page.keyboard.press("Control+Shift+C");
  await page.getByTestId("compose-cc").fill("priya@fabrikam.io");
  await page.getByTestId("compose-show-bcc").click();
  await page.getByTestId("compose-bcc").fill("archive@contoso.com");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "forward").length, { timeout: 10_000 }).toBe(1);
  const fwd = sentOfKind(fake, "forward")[0];
  expect(addresses(fwd.to)).toEqual(["sam.carter@contoso.com"]);
  expect(addresses(fwd.cc)).toEqual(["priya@fabrikam.io"]);
  expect(addresses(fwd.bcc)).toEqual(["archive@contoso.com"]);
});

test("formatting from the keyboard, Markdown shortcuts and links are sent as HTML", async ({ inbox: page, fake }) => {
  await newMessage(page, "priya@fabrikam.io", "Formatted");
  const body = page.getByTestId("compose-body");
  await page.keyboard.type("Hi ");
  await page.keyboard.press("Control+B");
  await expect(page.getByTestId("compose-format-bold")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("Priya");
  await page.keyboard.press("Control+B");
  await page.keyboard.type(", ");
  await page.keyboard.press("Control+I");
  await page.keyboard.type("quick");
  await page.keyboard.press("Control+I");
  await page.keyboard.type(" update:");
  await page.keyboard.press("Enter");
  // "- " starts a list, like Markdown.
  await page.keyboard.type("- budget");
  await page.keyboard.press("Enter");
  await page.keyboard.type("hiring");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // an empty item ends the list
  await page.keyboard.type("Plan: ");
  // Ctrl+K in the text makes a link (the command palette stays shut).
  await page.keyboard.press("Control+K");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await page.getByTestId("compose-link-input").fill("example.com/plan");
  await page.keyboard.press("Enter");
  await expect(body).toBeFocused();
  await expect(body.locator("a")).toHaveAttribute("href", "https://example.com/plan");
  await expect(body).toHaveAttribute("data-text", "Hi Priya, quick update:\n- budget\n- hiring\nPlan: example.com/plan <https://example.com/plan>");
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  const html: string = sentOfKind(fake, "new")[0].html;
  expect(html).toContain("<div>Hi <strong>Priya</strong>, <em>quick</em> update:</div>");
  expect(html).toContain("<ul><li><div>budget</div></li><li><div>hiring</div></li></ul>");
  expect(html).toContain('<a href="https://example.com/plan" rel="noopener noreferrer">example.com/plan</a>');
});

test("the toolbar formats the selection; a link can be set on selected words", async ({ inbox: page, fake }) => {
  await newMessage(page, "priya@fabrikam.io", "Toolbar");
  const body = page.getByTestId("compose-body");
  await page.keyboard.type("read the plan");
  // Select "the plan" (two words back).
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await page.getByTestId("compose-format-underline").click();
  await expect(body.locator("u")).toHaveText("the plan");
  await page.getByTestId("compose-format-link").click();
  await page.getByTestId("compose-link-input").fill("https://example.com/p");
  await page.getByTestId("compose-link-apply").click();
  await expect(body.locator("a")).toHaveText("the plan");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "new")[0].html).toMatch(/<div>read <a href="https:\/\/example\.com\/p"[^>]*><u>the plan<\/u><\/a><\/div>/);
});

test("pasted formatted text keeps its formatting but nothing unsafe", async ({ inbox: page, fake }) => {
  await newMessage(page, "priya@fabrikam.io", "Pasted");
  await page.getByTestId("compose-body").evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/html", `<p>From the doc: <b>bold</b> and <span style="color:red" onclick="alert(1)">red</span></p><script>alert(2)</script><img src="https://t.example/p.gif">`);
    dt.setData("text/plain", "From the doc: bold and red");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("compose-body").locator("strong")).toHaveText("bold");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  const html: string = sentOfKind(fake, "new")[0].html;
  expect(html).toContain("From the doc: <strong>bold</strong> and red");
  for (const bad of ["script", "alert", "onclick", "<img", "color:red"]) expect(html).not.toContain(bad);
});

test.describe("undo send", () => {
  test.use({ undoSendSecs: 3 });

  test("z brings back the formatting and the Bcc", async ({ inbox: page, fake }) => {
    await newMessage(page, "priya@fabrikam.io", "Undo me");
    await page.keyboard.press("Control+B");
    await page.keyboard.type("Important");
    await page.keyboard.press("Control+Shift+B");
    await page.keyboard.type("sam.carter@contoso.com");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(page.getByTestId("toast")).toContainText("Send undone");
    await expect(page.getByTestId("compose-body").locator("strong")).toHaveText("Important");
    await expect(page.getByTestId("compose-bcc")).toHaveValue("sam.carter@contoso.com");
    await page.getByTestId("compose-body").click();
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 15_000 }).toBe(1);
    expect(sentOfKind(fake, "new")[0].html).toContain("<strong>Important</strong>");
    expect(addresses(sentOfKind(fake, "new")[0].bcc)).toEqual(["sam.carter@contoso.com"]);
  });
});
