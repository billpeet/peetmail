import { describe, expect, it } from "vitest";
import { installErrorReporting, ReportLimiter, toReport, type ErrorReport } from "./errors";

describe("toReport", () => {
  it("keeps an Error's name, message and stack", () => {
    const e = new TypeError("x is undefined");
    const r = toReport(e, "onerror");
    expect(r).toMatchObject({ name: "TypeError", message: "x is undefined", mechanism: "onerror" });
    expect(r.stack).toContain("TypeError");
  });

  it("copes with things that aren't Errors", () => {
    expect(toReport("plain string", "onunhandledrejection")).toEqual({ name: "Error", message: "plain string", stack: null, mechanism: "onunhandledrejection" });
    expect(toReport({ code: 4 }, "x").message).toBe('{"code":4}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toReport(cyclic, "x").message).toBe("[object Object]");
  });
});

describe("ReportLimiter", () => {
  const r = (message: string): ErrorReport => ({ name: "Error", message, stack: null, mechanism: "onerror" });

  it("drops a repeat within the quiet period, and lets it through after", () => {
    const l = new ReportLimiter(20, 1000);
    expect(l.allow(r("a"), 0)).toBe(true);
    expect(l.allow(r("a"), 500)).toBe(false);
    expect(l.allow(r("b"), 500)).toBe(true);
    expect(l.allow(r("a"), 1500)).toBe(true);
  });

  it("stops after the session cap", () => {
    const l = new ReportLimiter(2, 0);
    expect([l.allow(r("1")), l.allow(r("2")), l.allow(r("3"))]).toEqual([true, true, false]);
  });
});

describe("installErrorReporting", () => {
  it("sends window errors and rejections, and survives a failing send", async () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const sent: ErrorReport[] = [];
    installErrorReporting(
      (rep) => {
        sent.push(rep);
        return Promise.reject(new Error("IPC down"));
      },
      { addEventListener: ((type: string, h: (e: unknown) => void) => (handlers[type] = h)) as Window["addEventListener"] },
    );
    handlers.error({ error: new RangeError("bad index"), message: "bad index" });
    handlers.unhandledrejection({ reason: "nope" });
    await Promise.resolve();
    expect(sent.map((s) => [s.name, s.message, s.mechanism])).toEqual([
      ["RangeError", "bad index", "onerror"],
      ["Error", "nope", "onunhandledrejection"],
    ]);
  });
});
