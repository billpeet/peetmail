// Benchmark: time from Enter keydown to the message body being visible, for large emails,
// in the real app against the fake Graph server.
//
//   pnpm bench:open [runs] [cold|warm] [graphLatencyMs]
//
// warm: bodies already prefetched into SQLite (the normal case for recent mail).
// cold: prefetch is blocked, so the body is fetched and sanitised on open (older mail).
// Exits non-zero if the worst time, minus simulated network latency, exceeds the budget.
import { deflateSync, crc32 } from "node:zlib";
import { randomBytes } from "node:crypto";
import { startFakeGraph } from "../harness/fake-graph.ts";
import { ensureBuilt, launchApp, signIn } from "../harness/app.ts";

const RUNS = Number(process.argv[2] ?? 3);
/** Budget for app-side work (excludes simulated network latency). */
const THRESHOLD_MS = 300;

/** Valid RGBA PNG of noise (incompressible, so it's genuinely large). */
function noisePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = randomBytes((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function newsletter(): string {
  const rows = Array.from({ length: 900 }, (_, i) => `
    <tr><td style="padding:12px;border-bottom:1px solid #eee;font-family:Georgia,serif">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="120" valign="top"><img src="https://cdn.example-news.com/img/${i}.jpg" width="120" height="80" alt="story ${i}"></td>
        <td style="padding-left:12px;font-size:15px;color:#333;line-height:1.5">
          <a href="https://example-news.com/story/${i}" style="color:#7a1f3d;font-weight:bold;text-decoration:none">Story ${i}: beetroot markets move again</a>
          <p style="margin:6px 0 0">${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}</p>
        </td></tr></table>
    </td></tr>`).join("");
  return `<style>.x{color:red} td{font-size:14px}</style><table width="100%" bgcolor="#f4efe6"><tr><td align="center"><table width="640">${rows}</table></td></tr></table>`;
}

function embedded(): string {
  const img = noisePng(500, 400).toString("base64"); // ~800 KB each
  return `<p>Photos inline:</p>` + Array.from({ length: 4 }, () => `<img src="data:image/png;base64,${img}" width="500">`).join("");
}

const MODE = process.argv[3] ?? "cold"; // cold: fetched on open; warm: prefetched
const LATENCY = Number(process.argv[4] ?? 300);

const variants = [
  { name: "newsletter (840KB HTML, 900 remote imgs)", body: newsletter() },
  { name: "embedded base64 images (4MB)", body: embedded() },
  { name: "newsletter without images", body: newsletter().replace(/<img [^>]+>/g, "") },
];

ensureBuilt();
const fake = await startFakeGraph();
const app = await launchApp({ fake });
const page = app.page;
try {
  await signIn(page, fake.clientId);
  for (const v of variants) {
    console.log(`body bytes ${v.name}: ${(v.body.length / 1024).toFixed(0)} KB`);
    const { ids } = await fake.control("deliver", { subject: v.name, body: v.body });
    (v as any).conv = `conv-${ids[0]}`;
  }
  // Cold: block body fetches during sync so prefetch can't cache them; they load on open.
  if (MODE === "cold") await fake.control("config", { failBody: true });
  await page.keyboard.press("Control+r");
  await page.waitForTimeout(6000); // sync + background prefetch
  await fake.control("config", { failBody: false, latencyMs: LATENCY });
  console.log(`mode ${MODE}, graph latency ${LATENCY} ms`);

  let worst = 0;
  for (let run = 0; run < (MODE === "cold" ? 1 : RUNS); run++) {
    for (const v of variants) {
      await page.locator(`[data-testid=thread-row][data-conversation-id="${(v as any).conv}"]`).click();
      await page.evaluate(() => {
        const w = window as any;
        w.__t = { down: 0, visible: 0 };
        window.addEventListener("keydown", (e) => { if (e.key === "Enter" && !w.__t.down) w.__t.down = performance.now(); }, { capture: true, once: true });
        const loop = () => {
          const f = document.querySelector<HTMLIFrameElement>("[data-testid=message-body][data-ready=true]");
          if (f && getComputedStyle(f).visibility === "visible") { w.__t.visible = performance.now(); return; }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => (window as any).__t.visible > 0, null, { timeout: 15000 });
      const t = await page.evaluate(() => (window as any).__t);
      const ms = Math.round(t.visible - t.down);
      worst = Math.max(worst, ms);
      console.log(`run ${run + 1} ${v.name}: ${ms} ms`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  }
  // Cold opens also fetch, parse, sanitise and store a fresh body: allow for that on top of
  // the simulated network latency.
  const budget = MODE === "cold" ? LATENCY + 400 : THRESHOLD_MS;
  console.log(worst > budget ? `OVER BUDGET: worst ${worst} ms > ${budget} ms` : `ok: worst ${worst} ms (budget ${budget} ms)`);
  process.exitCode = worst > budget ? 1 : 0;
} finally {
  await app.close();
  await fake.close();
}
