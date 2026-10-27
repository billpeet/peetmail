// A fake update server: serves a manifest per channel (/stable/latest.json,
// /canary/latest.json), built by scripts/update-manifest.ts as release.yml's are, and a
// small payload signed with the test key in tests/harness/updater. The harness build
// trusts that key (src-tauri/tauri.harness.conf.json), so the app's real
// download-and-verify path runs.
//
// The payload is signed for version SIGNED_VERSION; the app's updater has
// requireSignedVersion on, so a manifest announcing any other version is rejected.
// Regenerate with: pnpm tauri signer sign -f <abs>/test.key -p "" --app-version 9.9.0 <abs>/payload.bin

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../../scripts/update-manifest.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "updater");
export const SIGNED_VERSION = "9.9.0";

export type Release = {
  version: string;
  notes?: string;
  /** Serve the payload with one byte changed, so its signature no longer matches. */
  tampered?: boolean;
  /** Answer the manifest request this much later (to catch the app mid-check). */
  delayMs?: number;
};

export async function startFakeUpdates() {
  const payload = readFileSync(join(DIR, "payload.bin"));
  const tampered = Buffer.from(payload);
  tampered[0] ^= 0xff;
  const signature = readFileSync(join(DIR, "payload.bin.sig"), "utf8").trim();
  const feeds: Record<string, Release | null> = { stable: null, canary: null };
  const requests: string[] = [];

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requests.push(path);
    const feed = /^\/(stable|canary)\/latest\.json$/.exec(path);
    if (feed) {
      const release = feeds[feed[1]];
      // The updater reads 204 as "no update".
      if (!release) return void res.writeHead(204).end();
      const url = `${origin}/${release.tampered ? "tampered" : "payload"}.bin`;
      const body = JSON.stringify(manifest({ version: release.version, url, signature, notes: release.notes }));
      return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(body), release.delayMs ?? 0);
    }
    if (path === "/payload.bin" || path === "/tampered.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void res.end(path === "/payload.bin" ? payload : tampered);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    requests,
    /** Puts a release on a channel's feed (null: the feed says "no update"). */
    publish(channel: "stable" | "canary", release: Release | null) {
      feeds[channel] = release;
    },
    feedRequests: (channel: "stable" | "canary") => requests.filter((p) => p === `/${channel}/latest.json`).length,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeUpdates = Awaited<ReturnType<typeof startFakeUpdates>>;
