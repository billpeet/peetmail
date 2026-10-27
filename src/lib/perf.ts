// Webview timings for telemetry: each keyboard action until the next frame is painted,
// long tasks (main thread blocked > 50 ms) and the first paint. Batched and sent to Rust,
// which validates them and exports them (src-tauri/src/telemetry.rs). Only binding ids
// and view names go out, never content.

export type UiEvent = { kind: "action" | "longTask" | "firstPaint"; binding?: string; view?: string; ms: number };

/** Collects events and hands them to `send` in batches. */
export class UiTimings {
  #queue: UiEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private send: (events: UiEvent[]) => Promise<unknown>,
    private maxBatch = 20,
    private delayMs = 5000,
  ) {}

  add(e: UiEvent) {
    if (!Number.isFinite(e.ms) || e.ms < 0) return;
    this.#queue.push({ ...e, ms: Math.round(e.ms * 10) / 10 });
    if (this.#queue.length >= this.maxBatch) this.flush();
    else this.#timer ??= setTimeout(() => this.flush(), this.delayMs);
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#queue.length) return;
    const batch = this.#queue;
    this.#queue = [];
    this.send(batch).catch(() => {});
  }
}

/** Calls `cb` once the browser has painted the frame after now (two animation frames). */
export function afterNextPaint(cb: () => void) {
  if (typeof requestAnimationFrame === "undefined") return cb();
  requestAnimationFrame(() => requestAnimationFrame(cb));
}

/** Starts reporting long tasks and the first paint to `timings`. */
export function observePage(timings: UiTimings) {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) timings.add({ kind: "longTask", ms: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // Not supported here; nothing to report.
  }
  afterNextPaint(() => timings.add({ kind: "firstPaint", ms: performance.now() }));
}
