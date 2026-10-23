import { signIn } from "../harness/app.ts";
import { test, expect, DEFAULT_CONVERSATIONS, snap, waitForSyncIdle } from "./fixtures";

const WRONG_ID = "99999999-8888-7777-6666-555555555555";

test("first run asks for a client ID and rejects malformed ones", async ({ page }, testInfo) => {
  const input = page.getByTestId("client-id-input");
  await expect(input).toBeFocused();
  await input.fill("not-a-guid");
  await input.press("Enter");
  await expect(page.getByTestId("client-id-error")).toContainText("doesn't look like");
  await snap(page, testInfo, "malformed-client-id");
});

test("signs in with PKCE and syncs the inbox", async ({ page, fake }) => {
  await signIn(page, fake.clientId);
  await waitForSyncIdle(page);
  await expect(page.getByTestId("thread-count")).toHaveText(`${DEFAULT_CONVERSATIONS} conversations`);
  // The fake token endpoint verifies the PKCE verifier, so getting here proves the exchange.
  expect(fake.state.requests.map((r) => r.path)).toContain("/oauth/token");
});

test("a wrong client ID can be cancelled and corrected from the sign-in screen", async ({ page, fake }, testInfo) => {
  const input = page.getByTestId("client-id-input");
  await input.fill(WRONG_ID);
  await input.press("Enter");
  await expect(page.getByTestId("sign-in")).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sign-in-waiting")).toBeVisible();
  await snap(page, testInfo, "waiting-for-browser");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await expect(page.getByTestId("setup-error")).toHaveCount(0);

  await page.keyboard.press("c");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(WRONG_ID);
  await input.fill(fake.clientId);
  await input.press("Enter");
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await signIn(page, fake.clientId);
});

test("changing the client ID in settings signs out but keeps the cache", async ({ inbox: page, fake }, testInfo) => {
  await page.keyboard.press("Control+,");
  const input = page.getByTestId("settings").getByTestId("client-id-input");
  await input.fill(WRONG_ID);
  await expect(page.getByTestId("settings")).toContainText("signs you out");
  await snap(page, testInfo, "settings-change-warning");
  await input.press("Enter");

  await expect(page.getByTestId("sign-in")).toContainText("Sign in again as boris@peetmail.test");

  // Back to the right ID; the cached delta link means no full resync is needed.
  await page.keyboard.press("c");
  await page.getByTestId("client-id-input").fill(fake.clientId);
  await page.getByTestId("client-id-input").press("Enter");
  await expect(page.getByTestId("sign-in")).toBeVisible();
  const before = fake.state.requests.length;
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-count")).toHaveText(`${DEFAULT_CONVERSATIONS} conversations`);
  await waitForSyncIdle(page);
  const deltas = fake.requestsSince(before).filter((r) => r.path.endsWith("/delta"));
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.every((r) => r.query.includes("deltatoken"))).toBe(true);
});
