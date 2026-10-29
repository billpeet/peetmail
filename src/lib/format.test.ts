import { describe, expect, it } from "vitest";
import { attachmentRoom, count, fileSize, listDate, recentGroup, recentTime, senderName } from "./format";

describe("listDate", () => {
  const now = new Date("2026-10-23T15:00:00");
  it("shows the time for today", () => {
    expect(listDate(new Date("2026-10-23T09:05:00").toISOString(), now)).toMatch(/9:05/);
  });
  it("shows day and month earlier this year", () => {
    expect(listDate(new Date("2026-03-04T10:00:00").toISOString(), now)).toMatch(/4.*Mar|Mar.*4/);
  });
  it("includes the year for older mail", () => {
    expect(listDate(new Date("2024-12-31T10:00:00").toISOString(), now)).toMatch(/2024/);
  });
});

describe("senderName", () => {
  it("prefers the display name, then the address", () => {
    expect(senderName("Sam", "sam@x.com")).toBe("Sam");
    expect(senderName("  ", "sam@x.com")).toBe("sam@x.com");
    expect(senderName(null, null)).toBe("(unknown sender)");
  });
});

describe("count", () => {
  it("pluralises everything except exactly one", () => {
    expect(count(1, "conversation")).toBe("1 conversation");
    expect(count(0, "conversation")).toBe("0 conversations");
    expect(count(3, "change")).toBe("3 changes");
    expect(count(2, "reply", "replies")).toBe("2 replies");
  });
});

describe("recent opens labels", () => {
  const now = new Date("2026-10-26T12:00:00");
  it("groups by last 7 days, rest of this month, then month (with year if older)", () => {
    expect(recentGroup(new Date("2026-10-25T09:00:00").toISOString(), now)).toBe("Last 7 days");
    expect(recentGroup(new Date("2026-10-15T09:00:00").toISOString(), now)).toBe("Earlier this month");
    expect(recentGroup(new Date("2026-09-30T09:00:00").toISOString(), now)).toMatch(/September/);
    expect(recentGroup(new Date("2025-09-30T09:00:00").toISOString(), now)).toMatch(/September.*2025|2025.*September/);
  });
  it("shows weekday and time within a week, weekday and date before that", () => {
    expect(recentTime(new Date("2026-10-23T19:45:00").toISOString(), now)).toMatch(/Fri.*7:45/);
    expect(recentTime(new Date("2026-10-15T19:45:00").toISOString(), now)).toMatch(/Thu.*15.*Oct|Thu.*Oct.*15/);
  });
});

describe("fileSize", () => {
  it("picks a unit that reads well", () => {
    expect(fileSize(68)).toBe("68 B");
    expect(fileSize(12 * 1024 + 300)).toBe("12 KB");
    expect(fileSize(3.44 * 1024 * 1024)).toBe("3.4 MB");
  });
});

describe("attachmentRoom", () => {
  const MB = 1024 * 1024;
  it("allows files up to 25 MB in all", () => {
    expect(attachmentRoom([10 * MB], [15 * MB])).toBeNull();
  });
  it("says how big it would get when it's too much", () => {
    expect(attachmentRoom([10 * MB], [10 * MB, 6 * MB])).toBe("That would make 26.0 MB of attachments; a message can carry 25.0 MB at most.");
  });
});
