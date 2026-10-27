import { test, expect } from "./fixtures";
import { hostname, userInfo } from "node:os";
import type { Page } from "@playwright/test";
import type { FakeSentry, SentryEvent } from "../harness/fake-sentry.ts";

const invoke = (page: Page, cmd: string, args?: Record<string, unknown>) =>
  page.evaluate(([cmd, args]) => (window as any).__TAURI_INTERNALS__.invoke(cmd, args), [cmd, args] as const);

/** Throws in the webview outside any handler, as a real bug would. */
const throwInWebview = (page: Page, message: string) =>
  page.evaluate((message) => {
    setTimeout(() => {
      throw new TypeError(message);
    });
  }, message);

const breadcrumbsOf = (e: SentryEvent) => (Array.isArray(e.breadcrumbs) ? e.breadcrumbs : (e.breadcrumbs?.values ?? []));

async function eventMatching(sentry: FakeSentry, pred: (e: SentryEvent) => boolean) {
  await expect.poll(() => sentry.events().some(pred), { timeout: 15_000 }).toBe(true);
  return sentry.events().find(pred)!;
}

/** Things that identify the person or the PC, none of which may leave it. */
function personal(): string[] {
  const user = userInfo().username;
  return [
    "boris@peetmail.test", // the signed-in account
    "Boris Dragon", // its display name
    "priya@fabrikam.io", // a correspondent
    hostname(),
    `Users\\${user}`,
    `Users\\\\${user}`,
    `Users/${user}`,
  ];
}

test("without a DSN nothing is sent, there's no notice, and the setting says so", async ({ inbox: page }) => {
  await expect(page.getByTestId("privacy-notice")).toHaveCount(0);
  await page.keyboard.press("Control+,");
  await expect(page.getByTestId("crash-reports")).toBeDisabled();
  await expect(page.getByTestId("crash-reports-off")).toBeVisible();
});

test.describe("with crash reports going to a fake Sentry", () => {
  test.use({ withSentry: true });

  test("a webview error arrives scrubbed, tagged with the release and the install ID", async ({ inbox: page, sentry }) => {
    await throwInWebview(page, "Couldn't render a message from priya@fabrikam.io to Boris Dragon <boris@peetmail.test>");
    const e = await eventMatching(sentry, (e) => e.platform === "javascript");

    const ex = e.exception!.values[0];
    expect(ex.type).toBe("TypeError");
    expect(ex.value).toBe("Couldn't render a message from [email] to [redacted] <[redacted]>");
    expect(ex.mechanism?.type).toBe("onerror");
    expect(ex.stacktrace?.frames.length).toBeGreaterThan(0);
    expect(e.release).toMatch(/^peetmail@\d+\.\d+\.\d+/);
    expect(e.environment).toBe("dev");
    expect(e.tags?.source).toBe("webview");
    expect(e.server_name).toBeUndefined();

    const { installId } = await invoke(page, "privacy");
    expect(e.user).toEqual({ id: installId });

    // Log lines from the session ride along as breadcrumbs (scrubbed like the rest).
    expect(breadcrumbsOf(e).length).toBeGreaterThan(0);

    const sent = sentry.allText();
    for (const p of personal()) expect(sent, `"${p}" must not leave the PC`).not.toContain(p);
  });

  test("a Rust panic arrives with its message and no local paths", async ({ inbox: page, sentry }) => {
    await invoke(page, "debug_panic");
    const e = await eventMatching(sentry, (e) => (e.exception?.values ?? []).some((x) => x.value?.includes("deliberate test panic")));
    expect(e.exception!.values.at(-1)!.mechanism?.type).toBe("panic");
    // The panic is on its own thread; the trail and install ID still come with it.
    expect(breadcrumbsOf(e).length).toBeGreaterThan(0);
    expect(e.user).toEqual({ id: (await invoke(page, "privacy")).installId });
    for (const p of personal()) expect(sentry.allText(), `"${p}" must not leave the PC`).not.toContain(p);
  });

  test("turning crash reports off stops them straight away", async ({ inbox: page, sentry }) => {
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("crash-reports")).toBeChecked();
    await page.getByTestId("crash-reports").uncheck();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await invoke(page, "privacy")).crashReports).toBe(false);

    await throwInWebview(page, "after opting out");
    await invoke(page, "debug_panic");
    await page.waitForTimeout(2000);
    expect(sentry.events()).toEqual([]);

    // And back on.
    await page.keyboard.press("Control+,");
    await page.getByTestId("crash-reports").check();
    await page.keyboard.press("Escape");
    await throwInWebview(page, "after opting back in");
    await eventMatching(sentry, (e) => e.exception?.values[0].value === "after opting back in");
  });

  test("the first-run notice says reports are on, once", async ({ inbox: page }) => {
    const notice = page.getByTestId("privacy-notice");
    await expect(notice).toContainText("crash reports");
    await page.getByTestId("privacy-notice-settings").click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId("crash-reports")).toBeVisible();
    expect((await invoke(page, "privacy")).noticeSeen).toBe(true);
  });

  test("a native crash is caught by the crash reporter and sent as a minidump", async ({ inbox: page, sentry, app }) => {
    await invoke(page, "debug_crash").catch(() => {}); // the app dies mid-call
    await expect.poll(() => app.proc.exitCode !== null, { timeout: 10_000 }).toBe(true);
    await expect
      .poll(() => sentry.attachments().some((a) => a.header.attachment_type === "event.minidump"), { timeout: 30_000 })
      .toBe(true);
    const dump = sentry.attachments().find((a) => a.header.attachment_type === "event.minidump")!;
    expect(dump.payload.subarray(0, 4).toString("latin1")).toBe("MDMP");
  });
});
