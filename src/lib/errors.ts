// Uncaught errors in the webview go to the Rust side, which scrubs them and sends them to
// Sentry (src-tauri/src/crash.rs). The webview itself never talks to the network.

export type ErrorReport = { name: string; message: string; stack: string | null; mechanism: string };

/** Whatever was thrown (an Error, a string, anything) as a report. */
export function toReport(thrown: unknown, mechanism: string): ErrorReport {
  if (thrown instanceof Error) {
    return { name: thrown.name || "Error", message: thrown.message, stack: thrown.stack ?? null, mechanism };
  }
  let message: string;
  try {
    message = typeof thrown === "string" ? thrown : JSON.stringify(thrown) ?? String(thrown);
  } catch {
    message = String(thrown);
  }
  return { name: "Error", message, stack: null, mechanism };
}

/**
 * Keeps one broken render loop from sending hundreds of reports: at most `max` per
 * session, and the same message again only after `quietMs`.
 */
export class ReportLimiter {
  #sent = 0;
  #last = new Map<string, number>();
  constructor(
    private max = 20,
    private quietMs = 60_000,
  ) {}

  allow(r: ErrorReport, now = Date.now()): boolean {
    if (this.#sent >= this.max) return false;
    const key = `${r.name}: ${r.message}`;
    const last = this.#last.get(key);
    if (last !== undefined && now - last < this.quietMs) return false;
    this.#last.set(key, now);
    this.#sent++;
    return true;
  }
}

/** Hooks window errors and unhandled promise rejections up to `send`. */
export function installErrorReporting(send: (r: ErrorReport) => Promise<unknown>, target: Pick<Window, "addEventListener"> = window) {
  const limiter = new ReportLimiter();
  const report = (r: ErrorReport) => {
    // A failed report must never raise another one.
    if (limiter.allow(r)) send(r).catch(() => {});
  };
  target.addEventListener("error", (e: ErrorEvent) => report(toReport(e.error ?? e.message, "onerror")));
  target.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => report(toReport(e.reason, "onunhandledrejection")));
}
