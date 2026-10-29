import { test, expect, row, syncNow } from "./fixtures";
import type { Page } from "@playwright/test";

type Sent = Record<string, any>;
type Fake = Parameters<Parameters<typeof test>[2]>[0]["fake"];
const sentOfKind = (fake: Fake, kind: string) => fake.state.sent.filter((s: Sent) => s.kind === kind);
const serverDrafts = (fake: Fake) => [...fake.state.drafts.values()];
const draftRows = (page: Page) => page.getByTestId("draft-row");
const addresses = (list: Sent[]) => list.map((r) => r.emailAddress.address);

async function goToDrafts(page: Page) {
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(page.getByTestId("drafts")).toBeVisible();
}

test("a draft written here goes to Outlook's Drafts, follows its edits, and leaves when discarded", async ({ inbox: page, fake }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("priya@fabrikam.io");
  await page.getByTestId("compose-show-bcc").click();
  await page.getByTestId("compose-bcc").fill("sam.carter@contoso.com");
  await page.getByTestId("compose-subject").fill("Budget");
  await page.getByTestId("compose-file-input").setInputFiles([{ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("the plan") }]);
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("First go");

  // One push for the burst of typing, a few seconds later.
  await expect.poll(() => serverDrafts(fake).length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => serverDrafts(fake)[0].html, { timeout: 10_000 }).toContain("First go");
  const d = serverDrafts(fake)[0];
  expect(d.subject).toBe("Budget");
  expect(addresses(d.to)).toEqual(["priya@fabrikam.io"]);
  expect(addresses(d.bcc)).toEqual(["sam.carter@contoso.com"]);
  expect(d.attachments.map((a: Sent) => a.name)).toEqual(["plan.txt"]);
  expect(sentOfKind(fake, "draft-create")).toHaveLength(1);

  await page.keyboard.type(", then better");
  await expect.poll(() => serverDrafts(fake)[0]?.html, { timeout: 10_000 }).toContain("First go, then better");
  expect(sentOfKind(fake, "draft-create")).toHaveLength(1); // updated, not made again

  await page.keyboard.press("Control+Shift+D");
  await expect.poll(() => serverDrafts(fake).length, { timeout: 10_000 }).toBe(0);
});

test("sending a draft takes it out of Outlook's Drafts too", async ({ inbox: page, fake }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("priya@fabrikam.io");
  await page.getByTestId("compose-subject").fill("Soon");
  await expect.poll(() => serverDrafts(fake).length, { timeout: 10_000 }).toBe(1);
  await page.getByTestId("compose-body").click();
  await page.keyboard.type("Sent from a draft");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => serverDrafts(fake).length, { timeout: 10_000 }).toBe(0);
  await syncNow(page, fake);
  await goToDrafts(page);
  await expect(page.getByTestId("drafts-empty")).toBeVisible();
});

test("a reply drafted here is Outlook's own reply draft, in the conversation", async ({ inbox: page, fake }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Thinking about it");
  await expect.poll(() => serverDrafts(fake).length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "draft-create")[0].from).toBe("createReply");
  expect(serverDrafts(fake)[0].messageId).toBe("msg-plain");
  await expect.poll(() => serverDrafts(fake)[0].html, { timeout: 10_000 }).toContain("Thinking about it");
});

test("drafts written in Outlook come in, follow Outlook's edits and deletes, attachments included", async ({ inbox: page, fake }) => {
  const { id } = await fake.control("draft", {
    subject: "From Outlook", html: "<div><p class=MsoNormal>Started on my <b>laptop</b></p></div>", to: ["priya@fabrikam.io"],
    attachments: [{ name: "agenda.txt", text: "1. budget" }],
  });
  await syncNow(page, fake);
  await goToDrafts(page);
  await expect(draftRows(page)).toHaveCount(1);
  await expect(draftRows(page)).toContainText("From Outlook");
  await expect(draftRows(page)).toContainText("Started on my laptop");

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("compose-to")).toHaveValue("priya@fabrikam.io");
  await expect(page.getByTestId("compose-body").locator("b, strong")).toHaveText("laptop");
  await expect(page.getByTestId("compose-attachment")).toContainText("agenda.txt");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);

  await fake.control("draft-update", { id, subject: "From Outlook, edited" });
  await syncNow(page, fake);
  await expect(draftRows(page)).toContainText("From Outlook, edited");

  await fake.control("draft-remove", { id });
  await syncNow(page, fake);
  await expect(page.getByTestId("drafts-empty")).toBeVisible();
});

test("closing a draft without changing it doesn't save over a newer edit from Outlook", async ({ inbox: page, fake }) => {
  const { id } = await fake.control("draft", { subject: "Shared", html: "<div>v1</div>", to: ["priya@fabrikam.io"] });
  await syncNow(page, fake);
  await goToDrafts(page);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("compose-subject")).toHaveValue("Shared");
  await fake.control("draft-update", { id, html: "<div>v2 from Outlook</div>" });
  await page.keyboard.press("Escape");
  await syncNow(page, fake);
  await expect(draftRows(page)).toContainText("v2 from Outlook");
  await page.waitForTimeout(4000); // past any push
  expect(fake.state.drafts.get(id)?.html).toContain("v2 from Outlook");
});

test("the last save wins: an edit here beats an older edit in Outlook", async ({ inbox: page, fake }) => {
  const { id } = await fake.control("draft", { subject: "Race", html: "<div>start</div>", to: ["priya@fabrikam.io"] });
  await syncNow(page, fake);
  await goToDrafts(page);
  await page.keyboard.press("Enter");
  await fake.control("draft-update", { id, html: "<div>outlook's edit</div>" });
  await page.getByTestId("compose-body").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and mine");
  await expect(page.getByTestId("compose-hint")).toHaveText("Draft saved");
  // A sync before the push: the local edit stays.
  await syncNow(page, fake);
  await expect(page.getByTestId("compose-body")).toHaveAttribute("data-text", "start and mine");
  await expect.poll(() => fake.state.drafts.get(id)?.html, { timeout: 10_000 }).toContain("start and mine");
});

test("a draft from Outlook is sent through Outlook's copy", async ({ inbox: page, fake }) => {
  const { id } = await fake.control("draft", { subject: "Outlook started this", html: "<div>Hi Priya</div>", to: ["priya@fabrikam.io"] });
  await syncNow(page, fake);
  await goToDrafts(page);
  await page.keyboard.press("Enter");
  await page.getByTestId("compose-body").click();
  await page.keyboard.press("End");
  await page.keyboard.type(", see you then");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  expect(sentOfKind(fake, "new")[0].html).toContain("Hi Priya, see you then");
  expect(fake.state.requests.some((r) => r.method === "POST" && r.path.endsWith(`/messages/${id}/send`))).toBe(true);
  expect(fake.state.drafts.size).toBe(0);
});

test.describe("undo send", () => {
  test.use({ undoSendSecs: 3 });

  test("a draft taken back from sending is back in Drafts, with the same Outlook copy", async ({ inbox: page, fake }) => {
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("priya@fabrikam.io");
    await page.getByTestId("compose-subject").fill("Wait");
    await expect.poll(() => serverDrafts(fake).length, { timeout: 10_000 }).toBe(1);
    await page.getByTestId("compose-body").click();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await goToDrafts(page);
    await expect(page.getByTestId("drafts-empty")).toBeVisible(); // being sent
    await page.keyboard.press("z");
    await expect(page.getByTestId("toast")).toContainText("Send undone");
    await page.keyboard.press("Escape");
    await expect(draftRows(page)).toHaveCount(1);
    await syncNow(page, fake);
    await expect(draftRows(page)).toHaveCount(1);
    expect(fake.state.drafts.size).toBe(1);
    expect(sentOfKind(fake, "draft-create")).toHaveLength(1);
  });
});
