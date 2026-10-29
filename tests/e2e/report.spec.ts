import { test, expect } from "./fixtures";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/** Things from the signed-in account's mailbox that must never be in diagnostics. */
const PERSONAL = ["boris@peetmail.test", "Boris Dragon", "priya@fabrikam.io", "sam.carter@contoso.com", "Q4 planning doc", "Beetroot supplier"];

/** Unzips with PowerShell (no zip library in the tests) and returns every file's text by name. */
function unzip(zip: Buffer | string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "peetmail-diag-"));
  try {
    const file = typeof zip === "string" ? zip : join(dir, "in.zip");
    if (typeof zip !== "string") writeFileSync(file, zip);
    const out = join(dir, "out");
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${file}' -DestinationPath '${out}'`]);
    const files: Record<string, string> = {};
    for (const name of readdirSync(out, { recursive: true }) as string[]) {
      try {
        files[name.replaceAll("\\", "/")] = readFileSync(join(out, name), "utf8");
      } catch {
        // a directory
      }
    }
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function openReport(page: Page) {
  await page.keyboard.press("F1");
  await page.getByTestId("help-nav-report").click();
  await expect(page.getByTestId("report")).toBeVisible();
}

function expectNothingPersonal(files: Record<string, string>) {
  const all = Object.values(files).join("\n");
  for (const p of PERSONAL) expect(all, `${p} is in the diagnostics`).not.toContain(p);
}

test("exported diagnostics describe the install without anything personal in them", async ({ inbox: page, app }) => {
  await openReport(page);
  // This build has no DSN: there's no form, only the export.
  await expect(page.getByTestId("feedback-message")).toHaveCount(0);
  await expect(page.getByTestId("report-fallback")).toBeVisible();
  await page.getByTestId("diagnostics-export").click();
  await expect(page.getByTestId("diagnostics-status")).toHaveAttribute("data-kind", "saved");

  const dir = join(app.dataDir, "downloads");
  const zips = readdirSync(dir).filter((f) => /^PeetMail-diagnostics-.*\.zip$/.test(f));
  expect(zips).toHaveLength(1);
  const files = unzip(join(dir, zips[0]));

  expect(Object.keys(files)).toEqual(expect.arrayContaining(["README.txt", "summary.json"]));
  expect(Object.keys(files).some((f) => f.startsWith("logs/"))).toBe(true);
  const summary = JSON.parse(files["summary.json"]);
  expect(summary.app.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(summary.app.installId).toBe(await page.getByTestId("report-install-id").textContent());
  expect(summary.system.windows).toMatch(/^Windows/);
  expect(summary.database.integrity).toBe("ok");
  expect(summary.database.accounts).toEqual([{ provider: "microsoft", app: expect.any(String), signedIn: true }]);
  expect(summary.database.rows.messages).toBeGreaterThan(0);
  expectNothingPersonal(files);
});

test.describe("with a fake Sentry", () => {
  test.use({ withSentry: true });

  test("feedback arrives with the install ID and the diagnostics attached", async ({ inbox: page, sentry }) => {
    await openReport(page);
    await expect(page.getByTestId("feedback-send")).toBeDisabled();
    await page.getByTestId("feedback-message").fill("The inbox stopped refreshing after lunch");
    await page.getByTestId("feedback-contact").fill("tester@example.com");
    await page.getByTestId("feedback-send").click();
    await expect(page.getByTestId("feedback-status")).toHaveAttribute("data-kind", "sent");
    await expect(page.getByTestId("feedback-message")).toHaveValue("");

    const installId = await page.getByTestId("report-install-id").textContent();
    const env = sentry.envelopes.find((e) => e.items.some((i) => i.header.type === "feedback"))!;
    expect(env).toBeTruthy();
    const event = JSON.parse(env.items.find((i) => i.header.type === "feedback")!.payload.toString("utf8"));
    expect(event.contexts.feedback.message).toBe("The inbox stopped refreshing after lunch");
    expect(event.contexts.feedback.contact_email).toBe("tester@example.com");
    expect(event.user.id).toBe(installId);
    expect(event.release).toMatch(/^peetmail@/);

    const zip = env.items.find((i) => i.header.type === "attachment")!;
    expect(zip.header.filename).toBe("peetmail-diagnostics.zip");
    expectNothingPersonal(unzip(zip.payload));
  });

  test("unticking diagnostics sends the words alone", async ({ inbox: page, sentry }) => {
    await openReport(page);
    await page.getByTestId("feedback-message").fill("Just a thought");
    await page.getByTestId("feedback-diagnostics").uncheck();
    await page.getByTestId("feedback-message").press("Control+Enter");
    await expect(page.getByTestId("feedback-status")).toHaveAttribute("data-kind", "sent");
    const env = sentry.envelopes.find((e) => e.items.some((i) => i.header.type === "feedback"))!;
    expect(env.items.map((i) => i.header.type)).toEqual(["feedback"]);
  });
});

test.describe("with a feedback address", () => {
  test.use({ feedbackEmail: "dev@peetsoftware.test" });

  test("Prefer email? starts a message to the developers with the version filled in", async ({ inbox: page }) => {
    await openReport(page);
    await page.getByTestId("feedback-email").click();
    await expect(page.getByTestId("help")).toHaveCount(0);
    await expect(page.getByTestId("compose-to")).toHaveValue("dev@peetsoftware.test");
    await expect(page.getByTestId("compose-subject")).toHaveValue("PeetMail feedback");
    await expect(page.getByTestId("compose-body")).toHaveAttribute("data-text", /PeetMail \d+\.\d+\.\d+, install ID [0-9a-f]{32}/);
  });
});

test("Report a problem is in the command palette", async ({ inbox: page }) => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Report a problem");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("help")).toHaveAttribute("data-page", "report");
});
