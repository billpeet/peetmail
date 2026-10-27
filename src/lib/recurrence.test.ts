import { describe, expect, it } from "vitest";
import { describeRecurrence, matchPreset, nthOfMonth, presets, recurrenceProblem, sameRecurrence, weekdayOf, type Recurrence } from "./recurrence";

const r = (over: Partial<Recurrence>): Recurrence => ({
  freq: "weekly", interval: 1, days: [], ordinal: null, dayOfMonth: null, month: null, end: { type: "never" }, start: "2026-10-27", ...over,
});

describe("describeRecurrence", () => {
  it("daily and weekly", () => {
    expect(describeRecurrence(r({ freq: "daily" }))).toBe("Every day");
    expect(describeRecurrence(r({ freq: "daily", interval: 3 }))).toBe("Every 3 days");
    expect(describeRecurrence(r({ days: ["tue"] }))).toBe("Every week on Tuesday");
    expect(describeRecurrence(r({ interval: 2, days: ["thu", "tue"] }))).toBe("Every 2 weeks on Tue and Thu");
    expect(describeRecurrence(r({ days: ["mon", "tue", "wed", "thu", "fri"] }))).toBe("Every weekday");
    expect(describeRecurrence(r({ days: ["mon", "wed", "fri"] }))).toBe("Every week on Mon, Wed and Fri");
  });

  it("monthly and yearly, by date or by weekday", () => {
    expect(describeRecurrence(r({ freq: "monthly", dayOfMonth: 15 }))).toBe("Every month on day 15");
    expect(describeRecurrence(r({ freq: "monthly", ordinal: 2, days: ["tue"] }))).toBe("Every month on the second Tuesday");
    expect(describeRecurrence(r({ freq: "monthly", interval: 3, ordinal: -1, days: ["fri"] }))).toBe("Every 3 months on the last Friday");
    expect(describeRecurrence(r({ freq: "yearly", dayOfMonth: 3, month: 11 }))).toMatch(/^Every year on 3 November$/);
    expect(describeRecurrence(r({ freq: "yearly", ordinal: 1, days: ["mon"], month: 9 }))).toMatch(/^Every year on the first Monday of September$/);
  });

  it("how it ends", () => {
    expect(describeRecurrence(r({ days: ["tue"], end: { type: "count", count: 10 } }))).toBe("Every week on Tuesday, 10 times");
    expect(describeRecurrence(r({ days: ["tue"], end: { type: "count", count: 1 } }))).toBe("Every week on Tuesday, 1 time");
    expect(describeRecurrence(r({ days: ["tue"], end: { type: "until", date: "2026-12-03" } }))).toMatch(/^Every week on Tuesday, until 3 Dec(\.|) 2026$/);
  });
});

describe("editing helpers", () => {
  it("knows a date's weekday and its place in the month", () => {
    expect(weekdayOf("2026-10-27")).toBe("tue");
    expect(nthOfMonth("2026-10-27")).toEqual({ ordinal: 4, isLast: true }); // 4th and last Tuesday of October
    expect(nthOfMonth("2026-10-06")).toEqual({ ordinal: 1, isLast: false });
    expect(nthOfMonth("2026-12-29")).toEqual({ ordinal: 5, isLast: true });
  });

  it("offers presets from the start date; a fifth weekday only as 'last'", () => {
    expect(presets("2026-10-27").map((p) => p.label)).toEqual([
      "Every day",
      "Every weekday (Mon–Fri)",
      "Every week on Tuesday",
      "Every month on the fourth Tuesday",
      "Every month on the last Tuesday",
      "Every month on day 27",
      expect.stringMatching(/^Every year on 27 October$/),
    ]);
    expect(presets("2026-12-29").map((p) => p.id)).not.toContain("monthlyNth");
    expect(presets("2026-10-06").map((p) => p.id)).not.toContain("monthlyLast");
  });

  it("recognises presets whatever the end, and anything else as custom", () => {
    expect(matchPreset(r({ days: ["tue"], end: { type: "count", count: 4 } }), "2026-10-27")).toBe("weekly");
    expect(matchPreset(r({ days: ["fri", "mon", "wed", "tue", "thu"] }), "2026-10-27")).toBe("weekdays");
    expect(matchPreset(r({ days: ["tue"], interval: 2 }), "2026-10-27")).toBe("custom");
    expect(matchPreset(r({ days: ["wed"] }), "2026-10-27")).toBe("custom");
    expect(matchPreset(r({ freq: "monthly", ordinal: -1, days: ["tue"] }), "2026-10-27")).toBe("monthlyLast");
    // Fields a pattern doesn't use don't matter (Graph sends dayOfMonth 0 / month 0 on weekly ones).
    expect(matchPreset(r({ freq: "daily", days: ["tue"], dayOfMonth: 0 }), "2026-10-27")).toBe("daily");
  });

  it("compares patterns by meaning", () => {
    const a = r({ days: ["thu", "tue"] });
    expect(sameRecurrence(a, r({ days: ["tue", "thu"] }))).toBe(true);
    expect(sameRecurrence(a, r({ days: ["tue", "thu"], end: { type: "count", count: 2 } }))).toBe(false);
    expect(sameRecurrence(a, r({ days: ["tue", "thu"], start: "2026-10-28" }))).toBe(false);
    expect(sameRecurrence(null, null)).toBe(true);
    expect(sameRecurrence(a, null)).toBe(false);
  });

  it("says what's wrong with a pattern", () => {
    expect(recurrenceProblem(r({ days: [] }))).toBe("Pick at least one day to repeat on");
    expect(recurrenceProblem(r({ days: ["tue"], interval: 0 }))).toBe("Repeat every 1 to 99");
    expect(recurrenceProblem(r({ days: ["tue"], end: { type: "until", date: "2026-10-01" } }))).toBe("The repeat end is before the start");
    expect(recurrenceProblem(r({ days: ["tue"], end: { type: "count", count: 0 } }))).toBe("Repeat 1 to 999 times");
    expect(recurrenceProblem(r({ days: ["tue"] }))).toBeNull();
  });
});
