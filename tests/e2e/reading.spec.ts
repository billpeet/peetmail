import { test, expect, bodyRequests, messageBody, row, selectedRow, snap, syncNow, waitForQuiet } from "./fixtures";

test("j/k move the selection and Enter/Esc open and close the reader", async ({ inbox: page }) => {
  const rows = page.getByTestId("thread-row");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("k");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("reader")).toBeVisible();
  await expect(page.getByTestId("reader").locator("h1")).toHaveText("Weird formatting in this one");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thread-list")).toBeVisible();
});

test("G and g g jump to the bottom and top", async ({ inbox: page }) => {
  const list = page.getByTestId("thread-list");
  await page.keyboard.press("Shift+G");
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const last = await page.getByTestId("thread-count").innerText();
  expect(last).toMatch(/\d+ conversations/);
  await expect(selectedRow(page)).not.toHaveAttribute("data-conversation-id", "conv-hostile");

  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(selectedRow(page)).toHaveAttribute("data-conversation-id", "conv-hostile");
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
});

test("hostile HTML is sanitized before rendering", async ({ inbox: page }, testInfo) => {
  await row(page, "conv-hostile").click();
  await page.keyboard.press("Enter");
  const body = messageBody(page);
  await expect(body.locator("body")).toContainText("Had a look at the numbers");

  const frame = page.locator("[data-testid=message-body]");
  const report = await frame.evaluate((el: HTMLIFrameElement) => {
    const d = el.contentDocument!;
    return {
      scripts: d.querySelectorAll("script").length,
      iframes: d.querySelectorAll("iframe").length,
      handlers: [...d.querySelectorAll("*")].filter((e) => [...e.attributes].some((a) => a.name.startsWith("on"))).length,
      jsLinks: [...d.querySelectorAll("a")].filter((a) => /^javascript:/i.test(a.getAttribute("href") ?? "")).length,
      sandbox: el.getAttribute("sandbox"),
    };
  });
  expect(report).toEqual({ scripts: 0, iframes: 0, handlers: 0, jsLinks: 0, sandbox: "allow-same-origin" });
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  await snap(page, testInfo, "sanitized-message");
});

test("remote images are never fetched", async ({ inbox: page, fake }, testInfo) => {
  const pixel = `${fake.origin}/tracking/pixel.gif`;
  const { ids } = await fake.control("deliver", {
    subject: "Tracked newsletter",
    body: `<p>Hello from marketing</p><img src="${pixel}" width="1" height="1"><div style="background:url(${pixel}?css)">x</div>`,
  });
  await syncNow(page, fake);
  await row(page, `conv-${ids[0]}`).click();
  await page.keyboard.press("Enter");
  await expect(messageBody(page).locator("body")).toContainText("Hello from marketing");
  await page.waitForTimeout(500);
  expect(fake.state.requests.filter((r) => r.path.startsWith("/tracking"))).toEqual([]);
  await snap(page, testInfo, "tracked-newsletter");
});

test("plain-text bodies are escaped, not parsed", async ({ inbox: page }) => {
  await row(page, "conv-plain").click();
  await page.keyboard.press("Enter");
  await expect(messageBody(page).locator("pre")).toContainText("<not a tag> & see you Sunday.");
});

test("threads expand the newest message and collapse read ones", async ({ inbox: page }, testInfo) => {
  await row(page, "conv-thread-1").click();
  await page.keyboard.press("Enter");
  const messages = page.getByTestId("message");
  // Four received plus your reply from Sent Items.
  await expect(messages).toHaveCount(5);
  await expect(messages.last()).toContainText("Sent");
  // Newest (your reply) and the one unread message start expanded.
  await expect(page.locator("[data-testid=message][data-expanded=true]")).toHaveCount(2);
  await expect(messages.last()).toHaveAttribute("data-expanded", "true");

  await messages.first().getByTestId("message-header").click();
  await expect(messages.first()).toHaveAttribute("data-expanded", "true");
  await snap(page, testInfo, "thread");
});

test("shortcuts still work after clicking into a message body", async ({ inbox: page }) => {
  await page.keyboard.press("Enter");
  const frame = page.locator("[data-testid=message-body]");
  await expect(messageBody(page).locator("body")).toContainText("Had a look");
  await frame.click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thread-list")).toBeVisible();
});

test("the ? overlay lists registered shortcuts", async ({ inbox: page }, testInfo) => {
  await page.keyboard.press("?");
  const help = page.getByTestId("shortcut-help");
  await expect(help).toContainText("Next conversation");
  await expect(help).toContainText("Sync now");
  await snap(page, testInfo, "shortcut-help");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("a failed body fetch shows an error instead of hanging", async ({ inbox: page, fake }) => {
  // New mail whose body the server refuses to hand over, so prefetch can't cache it either.
  const { ids } = await fake.control("deliver", { subject: "Unlucky" });
  await fake.control("config", { failBody: true });
  await syncNow(page, fake);
  await row(page, `conv-${ids[0]}`).click();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("message-body-error")).toContainText("Body fetch failed");
});

test("bodies are prefetched after sync, so opening needs no network", async ({ inbox: page, fake }) => {
  // The first sync already pulled the newest bodies.
  expect(bodyRequests(fake, "msg-hostile")).toHaveLength(1);

  // New mail gets prefetched on the sync that brings it in.
  const { ids } = await fake.control("deliver", { subject: "Fresh off the press" });
  await syncNow(page, fake);
  await waitForQuiet(fake);
  expect(bodyRequests(fake, ids[0])).toHaveLength(1);

  const before = fake.state.requests.length;
  await row(page, `conv-${ids[0]}`).click();
  await page.keyboard.press("Enter");
  await expect(messageBody(page).locator("body")).toContainText("Just landed in your inbox.");
  expect(bodyRequests(fake, ids[0], before)).toEqual([]);
});
