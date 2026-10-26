import { describe, expect, it } from "vitest";
import { describeRecurrence, type Recurrence } from "./recurrence";

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
