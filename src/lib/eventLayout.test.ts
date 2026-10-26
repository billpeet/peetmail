import { describe, expect, it } from "vitest";
import { layoutDay } from "./eventLayout";

const day = new Date(2026, 9, 27); // local midnight
const at = (h: number, m = 0) => new Date(2026, 9, 27, h, m);
const ev = (id: string, s: Date, e: Date) => ({ id, start: s, end: e });
const byId = <T extends { item: { id: string } }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.item.id, x]));

describe("layoutDay", () => {
  it("places events by minutes from midnight", () => {
    const [p] = layoutDay([ev("a", at(9), at(9, 30))], day);
    expect(p).toMatchObject({ top: 540, height: 30, col: 0, cols: 1 });
  });

  it("puts overlapping events side by side and reuses free columns", () => {
    const placed = byId(
      layoutDay(
        [ev("a", at(15), at(15, 45)), ev("b", at(15, 30), at(16, 30)), ev("c", at(16), at(17)), ev("d", at(18), at(19))],
        day,
      ),
    );
    // a, b, c form one cluster needing 2 columns: c reuses a's column once a has ended.
    expect([placed.a.col, placed.b.col, placed.c.col]).toEqual([0, 1, 0]);
    expect([placed.a.cols, placed.b.cols, placed.c.cols]).toEqual([2, 2, 2]);
    // d doesn't overlap anything: full width.
    expect(placed.d).toMatchObject({ col: 0, cols: 1 });
  });

  it("clips events that cross midnight and drops ones outside the day", () => {
    const placed = byId(
      layoutDay(
        [ev("late", at(23), new Date(2026, 9, 28, 1)), ev("early", new Date(2026, 9, 26, 23), at(0, 30)), ev("other", new Date(2026, 9, 28, 9), new Date(2026, 9, 28, 10))],
        day,
      ),
    );
    expect(placed.late).toMatchObject({ top: 23 * 60, height: 60 });
    expect(placed.early).toMatchObject({ top: 0, height: 30 });
    expect(placed.other).toBeUndefined();
  });

  it("gives very short events a minimum height", () => {
    expect(layoutDay([ev("a", at(10), at(10, 5))], day)[0].height).toBe(15);
  });
});
