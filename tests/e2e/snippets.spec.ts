import { test, expect, snap, openSettings } from "./fixtures";
import type { Page } from "@playwright/test";

type Fake = Parameters<Parameters<typeof test>[2]>[0]["fake"];
const sentNew = (fake: Fake) => fake.state.sent.filter((s: Record<string, any>) => s.kind === "new");

async function addSnippet(page: Page, name: string, body: string) {
  await page.getByTestId("snippet-add").click();
  await page.getByTestId("snippet-name").last().fill(name);
  await page.getByTestId("snippet-body").last().fill(body);
}

async function saveSnippets(page: Page, list: [string, string][]) {
  await openSettings(page, "mail");
  for (const [name, body] of list) await addSnippet(page, name, body);
  await page.getByTestId("snippet-save").click();
  await expect(page.getByTestId("snippet-editor")).toContainText("Saved");
  await page.keyboard.press("Escape");
}

test("snippets are made in Settings; duplicate names are refused", async ({ inbox: page }, testInfo) => {
  await openSettings(page, "mail");
  await addSnippet(page, "thanks", "Thanks!");
  await addSnippet(page, "Thanks", "Again");
  await page.getByTestId("snippet-save").click();
  await expect(page.getByTestId("snippet-error")).toContainText("already a snippet called");
  await page.getByTestId("snippet-name").last().fill("thanks2");
  await page.getByTestId("snippet-save").click();
  await expect(page.getByTestId("snippet-editor")).toContainText("Saved");
  await snap(page, testInfo, "snippet-settings");

  // Saved for good: they're there after reopening Settings.
  await page.keyboard.press("Escape");
  await openSettings(page, "mail");
  await expect(page.getByTestId("snippet-name")).toHaveCount(2);
  await expect(page.getByTestId("snippet-name").first()).toHaveValue("thanks");
});

test(";name in the body inserts a snippet with the recipient's and your names filled in", async ({ inbox: page, fake }, testInfo) => {
  await saveSnippets(page, [
    ["thanks", "Hi {first_name},\n\nThanks for this!\n\n{my_first_name}"],
    ["intro", "Meet {name}."],
  ]);
  await page.keyboard.press("c");
  await page.getByTestId("compose-to").fill("priya@fabrikam.io");
  await page.getByTestId("compose-subject").fill("Re: numbers");
  const body = page.getByTestId("compose-body");
  await body.click();
  await page.keyboard.type(";th");
  await expect(page.getByTestId("snippet-option")).toHaveCount(1);
  await expect(page.getByTestId("snippet-option")).toContainText(";thanks");
  await snap(page, testInfo, "snippet-list");
  await page.keyboard.press("Enter");
  await expect(body).toHaveAttribute("data-text", "Hi Priya,\n\nThanks for this!\n\nBoris");
  await expect(page.getByTestId("snippet-list")).toHaveCount(0);

  // Typing carries on after the inserted text.
  await page.keyboard.type(" (sent from PeetMail)");
  await expect(body).toHaveAttribute("data-text", "Hi Priya,\n\nThanks for this!\n\nBoris (sent from PeetMail)");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sentNew(fake).length, { timeout: 10_000 }).toBe(1);
  expect(sentNew(fake)[0].html).toContain("Thanks for this!");
});

test("Esc dismisses the list without closing the composer; plain semicolons stay text; Ctrl+; lists everything", async ({ inbox: page }) => {
  await saveSnippets(page, [
    ["thanks", "Thanks!"],
    ["intro", "Meet my colleague"],
  ]);
  await page.keyboard.press("c");
  const body = page.getByTestId("compose-body");
  await body.click();
  await page.keyboard.type("one;two ");
  await expect(page.getByTestId("snippet-list")).toHaveCount(0);

  await page.keyboard.type(";in");
  await expect(page.getByTestId("snippet-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("snippet-list")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(body).toHaveAttribute("data-text", "one;two ;in");

  // No match: no list, so Enter is just a new line.
  await page.keyboard.type("x");
  await expect(page.getByTestId("snippet-list")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(body).toHaveAttribute("data-text", "one;two ;inx\n");

  await page.keyboard.press("Control+;");
  await expect(page.getByTestId("snippet-option")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(body).toHaveAttribute("data-text", "one;two ;inx\nMeet my colleague");
});

test("Ctrl+; with no snippets says where to make them", async ({ inbox: page }) => {
  await page.keyboard.press("c");
  await page.getByTestId("compose-body").click();
  await page.keyboard.press("Control+;");
  await expect(page.getByTestId("snippet-none")).toContainText("Settings");
});

test("the list opens next to the caret, wherever it is in the body", async ({ inbox: page }) => {
  await saveSnippets(page, [["thanks", "Thanks!"]]);
  await page.keyboard.press("c");
  const body = page.getByTestId("compose-body");
  await body.click();
  const box = (await body.boundingBox())!;

  // First line: the list starts just under it, not at the bottom of the body.
  await page.keyboard.type("Hi Sam, ;th");
  let list = (await page.getByTestId("snippet-list").boundingBox())!;
  expect(list.y).toBeGreaterThan(box.y);
  expect(list.y).toBeLessThan(box.y + 60);
  expect(list.x).toBeGreaterThan(box.x + 40); // follows the caret across, too

  // Lower down: it moves with the caret.
  await page.keyboard.press("Escape");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Enter");
  await page.keyboard.type(";th");
  const lower = (await page.getByTestId("snippet-list").boundingBox())!;
  expect(lower.y).toBeGreaterThan(list.y + 80);
  expect(lower.y).toBeLessThan(box.y + box.height);
});
