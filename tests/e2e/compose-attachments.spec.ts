import { test, expect, row, snap } from "./fixtures";
import type { Page } from "@playwright/test";

type Sent = Record<string, any>;
const sentOfKind = (fake: { state: { sent: Sent[] } }, kind: string) => fake.state.sent.filter((s) => s.kind === kind);
const file = (name: string, text: string, mimeType = "text/plain") => ({ name, mimeType, buffer: Buffer.from(text) });

/** Fires a paste or a drop of these files on an element, as Windows would hand them over. */
async function handOver(page: Page, how: "paste" | "drop", testid: string, files: { name: string; type: string; text: string }[]) {
  await page.getByTestId(testid).evaluate(
    (el, { how, files }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.text], f.name, { type: f.type }));
      if (how === "paste") {
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      } else {
        el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
        el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { how, files },
  );
}

async function startNew(page: Page, to: string, subject: string) {
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill(to);
  await page.getByTestId("compose-subject").fill(subject);
  await page.getByTestId("compose-body").fill("Files attached.");
}

test("files picked, dropped and pasted are sent with a new message; a removed one isn't", async ({ inbox: page, fake }, testInfo) => {
  await startNew(page, "priya@fabrikam.io", "Q4 numbers");
  await page.getByTestId("compose-file-input").setInputFiles([file("numbers.csv", "a,b\n1,2\n", "text/csv"), file("notes.txt", "draft notes")]);
  await handOver(page, "drop", "compose-body", [{ name: "dropped.txt", type: "text/plain", text: "from Explorer" }]);
  await handOver(page, "paste", "compose-body", [{ name: "image.png", type: "image/png", text: "PNGDATA" }]);
  const chips = page.getByTestId("compose-attachment");
  await expect(chips).toHaveCount(4);
  await expect(chips.first()).toContainText("numbers.csv");
  await expect(chips.first()).toContainText("8 B");
  await snap(page, testInfo, "composer-attachments");

  await chips.filter({ hasText: "notes.txt" }).getByTestId("compose-attachment-remove").click();
  await expect(chips).toHaveCount(3);
  await page.getByTestId("compose-body").focus();
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "new")[0];
  expect(sent.subject).toBe("Q4 numbers");
  expect(sent.to).toEqual([{ emailAddress: { address: "priya@fabrikam.io" } }]);
  expect(sent.html).toContain("Files attached.");
  expect(sent.attachments.map((a: Sent) => [a.name, a.contentType, Buffer.from(a.content, "base64").toString()])).toEqual([
    ["numbers.csv", "text/csv", "a,b\n1,2\n"],
    ["dropped.txt", "text/plain", "from Explorer"],
    ["image.png", "image/png", "PNGDATA"],
  ]);
  // Built as a draft and sent; nothing left behind in Drafts.
  expect(fake.state.drafts.size).toBe(0);
  // The Sent copy shows its attachments once synced.
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.getByTestId("thread-row").filter({ hasText: "Q4 numbers" })).toBeVisible({ timeout: 10_000 });
});

test("Ctrl+Shift+A opens the file picker", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+Shift+A");
  await (await chooser).setFiles([file("picked.txt", "hello")]);
  await expect(page.getByTestId("compose-attachment")).toContainText("picked.txt");
});

test("a file over 3 MB goes up in an upload session", async ({ inbox: page, fake }) => {
  await startNew(page, "priya@fabrikam.io", "Big one");
  const big = Buffer.alloc(4 * 1024 * 1024 + 123, 7);
  await page.getByTestId("compose-file-input").setInputFiles([{ name: "big.bin", mimeType: "application/octet-stream", buffer: big }]);
  await expect(page.getByTestId("compose-attachment")).toContainText("4.0 MB");
  await page.getByTestId("compose-body").focus();
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 15_000 }).toBe(1);
  const [upload] = sentOfKind(fake, "upload");
  expect(upload.name).toBe("big.bin");
  expect(upload.chunks).toBe(2);
  const [a] = sentOfKind(fake, "new")[0].attachments;
  expect(Buffer.from(a.content, "base64").equals(big)).toBe(true);
});

test("too much in attachments is refused before it's sent", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  // Made in the page: shipping 26 MB through Playwright is slow.
  await page.getByTestId("compose-body").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(26 * 1024 * 1024)], "huge.bin"));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("toast")).toContainText("25.0 MB at most");
  await expect(page.getByTestId("compose-attachment")).toHaveCount(0);
});

test("a forward lists the original's attachments; one taken out stays behind and a pasted one goes along", async ({ inbox: page, fake }, testInfo) => {
  await row(page, "conv-attach").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("f");
  const forwarded = page.getByTestId("compose-forwarded");
  await expect(forwarded).toHaveCount(1); // the inline chart isn't listed
  await expect(forwarded).toContainText("Q4 plan.pdf");
  await page.getByTestId("compose-to").fill("sam.carter@contoso.com");
  await handOver(page, "paste", "compose-body", [{ name: "summary.txt", type: "text/plain", text: "short version" }]);
  await expect(page.getByTestId("compose-attachment")).toContainText("summary.txt");
  await forwarded.getByTestId("compose-forwarded-remove").click();
  await expect(forwarded).toHaveCount(0);
  await snap(page, testInfo, "forward-attachments");
  await page.getByTestId("compose-body").focus();
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => sentOfKind(fake, "forward").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "forward")[0];
  expect(sent.messageId).toBe("msg-attach");
  expect(sent.to.map((r: Sent) => r.emailAddress.address)).toEqual(["sam.carter@contoso.com"]);
  // The inline image keeps the quoted original whole; the PDF was taken out.
  expect(sent.attachments.map((a: Sent) => [a.name, a.isInline])).toEqual([
    ["chart.png", true],
    ["summary.txt", false],
  ]);
});

test("a forward with its attachments untouched still goes in one call", async ({ inbox: page, fake }) => {
  await row(page, "conv-attach").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("f");
  await expect(page.getByTestId("compose-forwarded")).toContainText("Q4 plan.pdf");
  await page.getByTestId("compose-to").fill("sam.carter@contoso.com");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "forward").length, { timeout: 10_000 }).toBe(1);
  expect(fake.state.requests.some((r) => r.path.endsWith("/forward"))).toBe(true);
  expect(fake.state.requests.some((r) => r.path.endsWith("/createForward"))).toBe(false);
});

test("a reply with a file threads and quotes like any reply", async ({ inbox: page, fake }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await page.keyboard.type("Itinerary attached.");
  await page.getByTestId("compose-file-input").setInputFiles([file("itinerary.txt", "Sat: beach")]);
  await expect(page.getByTestId("compose-attachment")).toContainText("itinerary.txt");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "reply").length, { timeout: 10_000 }).toBe(1);
  const sent = sentOfKind(fake, "reply")[0];
  expect(sent.messageId).toBe("msg-plain");
  expect(sent.html).toContain("Itinerary attached.");
  expect(sent.attachments.map((a: Sent) => a.name)).toEqual(["itinerary.txt"]);
});

test("a send that fails part-way doesn't leave a draft behind", async ({ inbox: page, fake }) => {
  await fake.control("config", { failAttachments: 400 });
  await startNew(page, "priya@fabrikam.io", "Will fail");
  await page.getByTestId("compose-file-input").setInputFiles([file("a.txt", "a")]);
  await expect(page.getByTestId("compose-attachment")).toHaveCount(1);
  await page.getByTestId("compose-body").focus();
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentOfKind(fake, "delete-draft").length, { timeout: 10_000 }).toBe(1);
  expect(fake.state.drafts.size).toBe(0);
  expect(sentOfKind(fake, "new")).toHaveLength(0);
});

test("a message with only a file attached is kept as a draft, file and all", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-file-input").setInputFiles([file("keep.txt", "k")]);
  await expect(page.getByTestId("compose-attachment")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Saved to Drafts");
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await page.getByTestId("draft-row").click();
  await expect(page.getByTestId("compose-attachment")).toContainText("keep.txt");
});

test.describe("undo send", () => {
  test.use({ undoSendSecs: 3 });

  test("z brings the message back with its files, and it sends with them", async ({ inbox: page, fake }) => {
    await startNew(page, "priya@fabrikam.io", "With a file");
    await page.getByTestId("compose-file-input").setInputFiles([file("plan.txt", "the plan")]);
    await expect(page.getByTestId("compose-attachment")).toHaveCount(1);
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(page.getByTestId("toast")).toContainText("Send undone");
    await expect(page.getByTestId("compose-attachment")).toContainText("plan.txt");
    await page.getByTestId("compose-body").focus();
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => sentOfKind(fake, "new").length, { timeout: 15_000 }).toBe(1);
    expect(sentOfKind(fake, "new")[0].attachments.map((a: Sent) => Buffer.from(a.content, "base64").toString())).toEqual(["the plan"]);
  });
});

test("a file dropped outside the composer is ignored, not opened in place of the app", async ({ inbox: page }) => {
  // WebView2 opens a dropped file unless the page cancels the drop; check that it's cancelled.
  const cancelled = await page.getByTestId("thread-list").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["<h1>not PeetMail</h1>"], "stray.html", { type: "text/html" }));
    const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(over);
    el.dispatchEvent(drop);
    return [over.defaultPrevented, drop.defaultPrevented];
  });
  expect(cancelled).toEqual([true, true]);
  await expect(page.getByTestId("compose-attachment")).toHaveCount(0);
});
