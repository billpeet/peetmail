// A fake Sentry ingest server: accepts envelopes at /api/<project>/envelope/ and keeps them,
// raw and parsed, so tests can assert what was reported and that nothing personal was in
// it. Point the app at it with PEETMAIL_SENTRY_DSN=`fake.dsn` (debug builds only).

import { createServer } from "node:http";
import { gunzipSync, inflateSync } from "node:zlib";

export type EnvelopeItem = { header: Record<string, unknown>; payload: Buffer };
export type Envelope = { header: Record<string, unknown>; items: EnvelopeItem[]; raw: Buffer };

/** Splits a Sentry envelope: a header line, then items of a header line and a payload. */
export function parseEnvelope(raw: Buffer): Envelope {
  let pos = 0;
  const line = () => {
    const end = raw.indexOf(0x0a, pos);
    const text = raw.subarray(pos, end < 0 ? raw.length : end).toString("utf8");
    pos = end < 0 ? raw.length : end + 1;
    return text;
  };
  const header = JSON.parse(line() || "{}");
  const items: EnvelopeItem[] = [];
  while (pos < raw.length) {
    const h = line();
    if (!h.trim()) continue;
    const itemHeader = JSON.parse(h) as Record<string, unknown>;
    let payload: Buffer;
    if (typeof itemHeader.length === "number") {
      payload = raw.subarray(pos, pos + itemHeader.length);
      pos += itemHeader.length;
      if (raw[pos] === 0x0a) pos++;
    } else {
      payload = Buffer.from(line(), "utf8");
    }
    items.push({ header: itemHeader, payload });
  }
  return { header, items, raw };
}

export async function startFakeSentry() {
  const envelopes: Envelope[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || !/^\/api\/\d+\/envelope\/?/.test(req.url ?? "")) return void res.writeHead(404).end();
      let body = Buffer.concat(chunks);
      const enc = req.headers["content-encoding"];
      if (enc === "gzip") body = gunzipSync(body);
      else if (enc === "deflate") body = inflateSync(body);
      try {
        envelopes.push(parseEnvelope(body));
      } catch (e) {
        console.error("fake sentry: unparseable envelope", e);
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "0".repeat(32) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;

  const itemsOf = (type: string) => envelopes.flatMap((e) => e.items.filter((i) => i.header.type === type));
  return {
    dsn: `http://fakepublickey@127.0.0.1:${port}/1`,
    envelopes,
    /** Events received so far (parsed). */
    events: () => itemsOf("event").map((i) => JSON.parse(i.payload.toString("utf8")) as SentryEvent),
    attachments: () => itemsOf("attachment"),
    /** Everything received, as text, for "this must not appear anywhere" checks. */
    allText: () => envelopes.map((e) => e.raw.toString("latin1")).join("\n"),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeSentry = Awaited<ReturnType<typeof startFakeSentry>>;

/** The parts of a Sentry event the tests look at. */
export type SentryEvent = {
  event_id: string;
  level?: string;
  platform?: string;
  release?: string;
  environment?: string;
  server_name?: string;
  message?: string;
  user?: Record<string, unknown>;
  tags?: Record<string, string>;
  exception?: { values: { type: string; value?: string; mechanism?: { type: string }; stacktrace?: { frames: { abs_path?: string; function?: string; lineno?: number }[] } }[] };
  breadcrumbs?: { values: { message?: string; category?: string; level?: string }[] } | { message?: string }[];
};
