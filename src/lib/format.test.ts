import { describe, expect, it } from "vitest";
import { listDate, senderName } from "./format";

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
