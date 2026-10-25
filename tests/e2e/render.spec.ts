import type { Page } from "@playwright/test";
import { test, expect, selectWithKeys, syncNow, waitForQuiet } from "./fixtures";

/** Records the message iframe's visibility and height on every animation frame. */
async function startSampling(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: { visible: boolean; h: number }[] };
    w.__frames = [];
    const t0 = performance.now();
    const loop = () => {
      const f = document.querySelector<HTMLIFrameElement>("[data-testid=message-body]");
      if (f) w.__frames.push({ visible: getComputedStyle(f).visibility === "visible", h: Math.round(f.getBoundingClientRect().height) });
      if (performance.now() - t0 < 1500) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function visibleHeights(page: Page) {
  await page.waitForTimeout(1600);
  const frames = await page.evaluate(() => (window as unknown as { __frames: { visible: boolean; h: number }[] }).__frames);
  return frames.filter((f) => f.visible).map((f) => f.h);
}

const LONG_BODY = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i + 1} of a long update with enough words to wrap.</p>`).join("");

test("a long message appears at full height in one step", async ({ inbox: page, fake }) => {
  const { ids } = await fake.control("deliver", { subject: "The long one", body: LONG_BODY });
  await syncNow(page, fake);
  await waitForQuiet(fake);

  // Cold open: body is in SQLite (prefetched) but not yet in memory or measured.
  await selectWithKeys(page, `conv-${ids[0]}`);
  await startSampling(page);
  await page.keyboard.press("Enter");
  const first = await visibleHeights(page);
  expect(first.length).toBeGreaterThan(0);
  const final = first.at(-1)!;
  expect(final).toBeGreaterThan(600);
  expect(first.filter((h) => h < final - 2)).toEqual([]);

  // Reopen: the measured height is reused, so it's right from the first visible frame too.
  await page.keyboard.press("Escape");
  await startSampling(page);
  await page.keyboard.press("Enter");
  const again = await visibleHeights(page);
  expect(again.filter((h) => h < final - 2)).toEqual([]);
});
