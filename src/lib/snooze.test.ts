import { describe, expect, it } from "vitest";
import { snoozePresets } from "./snooze";

const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m); // October 2026; the 26th is a Monday
const presets = (now: Date) => Object.fromEntries(snoozePresets(now).map((p) => [p.id, p.at]));

describe("snoozePresets", () => {
  it("on a weekday morning offers the full set", () => {
    expect(presets(at(26, 9, 40))).toEqual({
      later: at(26, 12),
      evening: at(26, 18),
      tomorrow: at(27, 8),
      weekend: at(31, 8),
      nextweek: new Date(2026, 10, 2, 8),
    });
  });

  it("drops later today and this evening once the day is nearly over", () => {
    const p = presets(at(28, 17, 10));
    expect(p.later).toBeUndefined();
    expect(p.evening).toBeUndefined();
    expect(p.tomorrow).toEqual(at(29, 8));
  });

  it("on the weekend, the weekend preset is next weekend's Saturday", () => {
    expect(snoozePresets(at(31, 10)).find((p) => p.id === "weekend")).toMatchObject({ label: "Next weekend", at: new Date(2026, 10, 7, 8) });
    expect(presets(new Date(2026, 10, 1, 10)).weekend).toEqual(new Date(2026, 10, 7, 8)); // Sunday
    expect(presets(new Date(2026, 10, 1, 10)).nextweek).toEqual(new Date(2026, 10, 2, 8)); // Sunday -> tomorrow, Monday
    expect(presets(at(30, 10)).weekend).toEqual(at(31, 8)); // Friday -> tomorrow
  });
});
