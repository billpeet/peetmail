import { afterEach, describe, expect, it, vi } from "vitest";
import { UiTimings, type UiEvent } from "./perf";

describe("UiTimings", () => {
  afterEach(() => vi.useRealTimers());

  it("sends a full batch at once and the rest after a delay", () => {
    vi.useFakeTimers();
    const sent: UiEvent[][] = [];
    const t = new UiTimings((b) => (sent.push(b), Promise.resolve()), 2, 1000);
    t.add({ kind: "action", binding: "list.down", ms: 3.14159 });
    expect(sent).toEqual([]);
    t.add({ kind: "action", binding: "list.up", ms: 2 });
    expect(sent).toEqual([[{ kind: "action", binding: "list.down", ms: 3.1 }, { kind: "action", binding: "list.up", ms: 2 }]]);

    t.add({ kind: "longTask", ms: 80 });
    vi.advanceTimersByTime(999);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent[1]).toEqual([{ kind: "longTask", ms: 80 }]);
  });

  it("drops nonsense and survives a failing send", async () => {
    const t = new UiTimings(() => Promise.reject(new Error("IPC down")), 1, 10);
    t.add({ kind: "action", ms: NaN });
    t.add({ kind: "action", ms: -1 });
    expect(() => t.add({ kind: "firstPaint", ms: 120 })).not.toThrow();
  });
});
