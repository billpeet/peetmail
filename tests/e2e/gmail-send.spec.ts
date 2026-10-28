import { test, expect, row, selectWithKeys, selectedRow, snap, waitForSyncIdle, openSettings, showSettingsPage } from "./fixtures";
import type { Page } from "@playwright/test";
import { GMAIL_ACCOUNT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, leaves, parseMime, type MimeEntity } from "../harness/fake-gmail.ts";

test.use({ withGmail: true });

type Gmail = Parameters<Parameters<typeof test>[2]>[0]["gmail"];

async function addGmail(page: Page) {
  await openSettings(page, "apps");
  await page.getByTestId("google-client-id").fill(GOOGLE_CLIENT_ID);
  await page.getByTestId("google-client-secret").fill(GOOGLE_CLIENT_SECRET);
  await page.getByTestId("google-client-save").click();
  await showSettingsPage(page, "accounts");
  await page.getByTestId("account-add-google").click();
  await expect(page.locator(`[data-testid=account-row][data-email="${GMAIL_ACCOUNT.email}"]`)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await waitForSyncIdle(page);
  await expect(row(page, "g-thread-trip")).toBeVisible({ timeout: 15_000 });
}

/** The last message the app sent through the fake, parsed. */
async function sent(gmail: Gmail): Promise<{ threadId?: string; upload?: boolean; raw: string; mime: MimeEntity }> {
  await expect.poll(() => gmail.state.sent.filter((s) => s.kind === "send").length, { timeout: 15_000 }).toBeGreaterThan(0);
  const s = gmail.state.sent.filter((s) => s.kind === "send").at(-1)!;
  return { threadId: s.threadId, upload: s.upload, raw: s.raw, mime: parseMime(s.raw) };
}

const textPart = (m: ReturnType<typeof parseMime>, type: string) => leaves(m).find((l) => l.contentType === type)?.body.toString("utf8") ?? "";
const decodeWord = (h: string) => h.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b) => Buffer.from(b, "base64").toString("utf8"));

test("a new message from the Gmail account is a proper MIME message", async ({ inbox: page, gmail }) => {
  await addGmail(page);
  await page.keyboard.press("c");
  await page.getByTestId("compose-from").selectOption({ label: `${GMAIL_ACCOUNT.name} <${GMAIL_ACCOUNT.email}>` });
  await page.getByTestId("compose-to").fill("kim@friends.example");
  await page.getByTestId("compose-subject").fill("Café on Friday ☕");
  await page.getByTestId("compose-body").fill("Shall we?\n\nB");
  await page.keyboard.press("Control+Enter");

  const s = await sent(gmail);
  expect(s.threadId).toBeUndefined();
  expect(s.mime.headers["from"]).toBe(`${GMAIL_ACCOUNT.name} <${GMAIL_ACCOUNT.email}>`);
  expect(s.mime.headers["to"]).toBe("kim@friends.example");
  expect(s.mime.headers["subject"]).toMatch(/^=\?UTF-8\?B\?/);
  expect(decodeWord(s.mime.headers["subject"])).toBe("Café on Friday ☕");
  expect(textPart(s.mime, "text/plain")).toBe("Shall we?\n\nB");
  expect(textPart(s.mime, "text/html")).toContain("<p>Shall we?</p><p>B</p>");
});

test("a reply threads in Gmail, quotes the original, and shows up in the conversation", async ({ inbox: page, gmail }, testInfo) => {
  await addGmail(page);
  await selectWithKeys(page, "g-thread-trip");
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "g-thread-trip");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("message")).toHaveCount(3);
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-to")).toHaveValue("lee@friends.example"); // the newest message not from me
  await expect(page.getByTestId("compose-from")).toBeDisabled();
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Great, booking it.");
  await snap(page, testInfo, "gmail-reply");
  await page.keyboard.press("Control+Enter");

  const s = await sent(gmail);
  expect(s.threadId).toBe("g-thread-trip");
  expect(s.mime.headers["in-reply-to"]).toBe("<g-2@mail.example>");
  expect(s.mime.headers["references"]).toContain("<g-2@mail.example>");
  const text = textPart(s.mime, "text/plain");
  expect(text).toMatch(/^Great, booking it\.\r\n\r\nOn .+, Lee Wong <lee@friends\.example> wrote:\r\n> Count me in\./);
  expect(textPart(s.mime, "text/html")).toMatch(/<blockquote[^>]*>.*Count me in\./s);

  // The sent reply comes back through history into the same conversation.
  await expect(page.getByTestId("message")).toHaveCount(4, { timeout: 15_000 });
});

test("a forward carries the original's attachments and inline image, in a new thread", async ({ inbox: page, gmail }) => {
  await addGmail(page);
  await selectWithKeys(page, "g-thread-photos");
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "g-thread-photos");
  await page.keyboard.press("f");
  await page.getByTestId("compose-to").fill("lee@friends.example");
  await page.getByTestId("compose-body").fill("See below");
  await page.keyboard.press("Control+Enter");

  const s = await sent(gmail);
  expect(s.threadId).toBeUndefined();
  expect(s.mime.headers["in-reply-to"]).toBeUndefined();
  expect(s.mime.headers["subject"]).toBe("FW: Photos from Sunday");
  const html = textPart(s.mime, "text/html");
  expect(html).toContain("Forwarded message");
  expect(html).toContain('src="cid:pixel@mum"');
  const files = leaves(s.mime).filter((l) => l.filename);
  expect(files.map((f) => [f.filename, f.headers["content-id"] ?? null])).toEqual([
    ["pixel@mum", "<pixel@mum>"],
    ["plan.pdf", null],
  ]);
  expect(files[1].body.toString()).toBe("%PDF-1.4 fake plan");
});

test("a reply to Latin-1 mail quotes it correctly in UTF-8", async ({ inbox: page, gmail }) => {
  await addGmail(page);
  await selectWithKeys(page, "g-thread-latin");
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "g-thread-latin");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Obrigado!");
  await page.keyboard.press("Control+Enter");
  const s = await sent(gmail);
  expect(textPart(s.mime, "text/plain")).toContain("> Café confirmado");
});

test("big forwards go through Gmail's upload endpoint", async ({ inbox: page, gmail }) => {
  await addGmail(page);
  const { id } = await gmail.control("deliver", { subject: "Big file", attachmentBytes: 4_500_000 });
  await page.keyboard.press("Control+r");
  await expect(row(page, "g-thread-new-1")).toBeAttached({ timeout: 15_000 });
  await selectWithKeys(page, `g-thread-new-1`);
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "g-thread-new-1");
  await page.keyboard.press("f");
  await page.getByTestId("compose-to").fill("lee@friends.example");
  await page.keyboard.press("Control+Enter");
  const s = await sent(gmail);
  expect(s.upload).toBe(true);
  const big = leaves(s.mime).find((l) => l.filename === "big.bin")!;
  expect(big.body.length).toBe(4_500_000);
  expect(id).toBe("g-new-1");
});

test("a forward from Gmail leaves out a removed attachment and carries an attached file", async ({ inbox: page, gmail }) => {
  await addGmail(page);
  await selectWithKeys(page, "g-thread-photos");
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "g-thread-photos");
  await page.keyboard.press("f");
  const forwarded = page.getByTestId("compose-forwarded");
  await expect(forwarded).toContainText("plan.pdf");
  await forwarded.getByTestId("compose-forwarded-remove").click();
  await page.getByTestId("compose-file-input").setInputFiles([{ name: "Résumé.txt", mimeType: "text/plain", buffer: Buffer.from("my cv") }]);
  await expect(page.getByTestId("compose-attachment")).toContainText("Résumé.txt");
  await page.getByTestId("compose-to").fill("lee@friends.example");
  await page.keyboard.press("Control+Enter");

  const s = await sent(gmail);
  const files = leaves(s.mime).filter((l) => l.filename);
  // The inline image stays with the quote; plan.pdf was taken out; the new file is attached.
  expect(files.map((f) => decodeWord(f.filename!))).toEqual(["pixel@mum", "Résumé.txt"]);
  expect(files[1].body.toString()).toBe("my cv");
  expect(files[1].contentType).toMatch(/^text\/plain/);
});
