// A fake OTLP collector (HTTP/JSON): accepts /v1/traces, /v1/metrics and /v1/logs, keeps
// every request raw and parsed, and flattens spans, metrics and log records for tests.
// Point the app at it with PEETMAIL_OTLP_ENDPOINT=`fake.url` (debug builds only).

import { createServer, type IncomingHttpHeaders } from "node:http";
import { gunzipSync } from "node:zlib";

type AnyValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number };
type KeyValue = { key: string; value: AnyValue };
type Attrs = Record<string, string | number | boolean>;

export type Span = { name: string; traceId: string; spanId: string; parentSpanId?: string; attrs: Attrs; resource: Attrs; durationMs: number };
export type LogRecord = { body: string; severity: string; traceId?: string; target?: string; resource: Attrs };
export type Metric = { name: string; unit?: string; resource: Attrs };

const plain = (v: AnyValue): string | number | boolean =>
  v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : (v.boolValue ?? v.doubleValue ?? ""));
const attrs = (list: KeyValue[] = []): Attrs => Object.fromEntries(list.map((a) => [a.key, plain(a.value)]));

export async function startFakeOtlp() {
  const requests: { signal: string; headers: IncomingHttpHeaders; raw: string; body: any }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const m = /^\/v1\/(traces|metrics|logs)$/.exec(req.url ?? "");
      if (req.method !== "POST" || !m) return void res.writeHead(404).end();
      let buf = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") buf = gunzipSync(buf);
      const raw = buf.toString("utf8");
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // Not JSON (protobuf?): keep the raw text for the leak checks.
      }
      requests.push({ signal: m[1], headers: req.headers, raw, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;

  const of = (signal: string) => requests.filter((r) => r.signal === signal && r.body);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    spans: (): Span[] =>
      of("traces").flatMap((r) =>
        (r.body.resourceSpans ?? []).flatMap((rs: any) =>
          (rs.scopeSpans ?? []).flatMap((ss: any) =>
            (ss.spans ?? []).map((s: any) => ({
              name: s.name,
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId || undefined,
              attrs: attrs(s.attributes),
              resource: attrs(rs.resource?.attributes),
              durationMs: (Number(s.endTimeUnixNano) - Number(s.startTimeUnixNano)) / 1e6,
            })),
          ),
        ),
      ),
    logs: (): LogRecord[] =>
      of("logs").flatMap((r) =>
        (r.body.resourceLogs ?? []).flatMap((rl: any) =>
          (rl.scopeLogs ?? []).flatMap((sl: any) =>
            (sl.logRecords ?? []).map((l: any) => ({
              body: String(l.body?.stringValue ?? ""),
              severity: l.severityText,
              traceId: l.traceId || undefined,
              target: l.eventName || undefined,
              resource: attrs(rl.resource?.attributes),
            })),
          ),
        ),
      ),
    metrics: (): Metric[] =>
      of("metrics").flatMap((r) =>
        (r.body.resourceMetrics ?? []).flatMap((rm: any) =>
          (rm.scopeMetrics ?? []).flatMap((sm: any) => (sm.metrics ?? []).map((x: any) => ({ name: x.name, unit: x.unit, resource: attrs(rm.resource?.attributes) }))),
        ),
      ),
    /** Everything received, as text, for "this must not appear anywhere" checks. */
    allText: () => requests.map((r) => r.raw).join("\n"),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeOtlp = Awaited<ReturnType<typeof startFakeOtlp>>;
