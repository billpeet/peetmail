import { describe, expect, it } from "vitest";
import { parseQuickEvent, parseSendTime, type QuickEvent } from "./quickAdd";

// Monday 26 Oct 2026, 11:30 local.
const now = new Date(2026, 9, 26, 11, 30);
const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m);

function ok(input: string): QuickEvent {
  const r = parseQuickEvent(input, now);
  if (!r.ok) throw new Error(`"${input}" failed: ${r.reason}`);
  return r.event;
}

describe("parseQuickEvent", () => {
  it("lunch with Sam fri 1pm @ Café Beetroot", () => {
    const e = ok("lunch with Sam fri 1pm @ Café Beetroot");
    expect(e).toEqual({ title: "Lunch with Sam", start: at(30, 13), end: at(30, 13, 30), allDay: false, location: "Café Beetroot" });
  });

  it("durations and ranges", () => {
    expect(ok("standup tomorrow 9:30 15m")).toMatchObject({ title: "Standup", start: at(27, 9, 30), end: at(27, 9, 45) });
    expect(ok("planning wed 2pm for 2h")).toMatchObject({ start: at(28, 14), end: at(28, 16) });
    expect(ok("review thu 1-2pm")).toMatchObject({ start: at(29, 13), end: at(29, 14) });
    expect(ok("workshop fri 11-1pm")).toMatchObject({ start: at(30, 11), end: at(30, 13) });
    expect(ok("call from 10:30 to 11:15 tomorrow")).toMatchObject({ title: "Call", start: at(27, 10, 30), end: at(27, 11, 15) });
    expect(ok("deep work tomorrow 9am 1.5 hours")).toMatchObject({ start: at(27, 9), end: at(27, 10, 30) });
  });

  it("times without am/pm follow working hours", () => {
    expect(ok("call priya tomorrow at 4")).toMatchObject({ title: "Call priya", start: at(27, 16) });
    expect(ok("coffee tomorrow at 9")).toMatchObject({ start: at(27, 9) });
    expect(ok("sync tomorrow 13:00")).toMatchObject({ start: at(27, 13) });
    expect(ok("lunch tomorrow noon")).toMatchObject({ start: at(27, 12) });
  });

  it("a time on its own is the next time it comes round", () => {
    expect(ok("pick up parcel 3pm")).toMatchObject({ start: at(26, 15) }); // later today
    expect(ok("gym 7am")).toMatchObject({ start: at(27, 7) }); // already passed today
  });

  it("dates in several forms", () => {
    expect(ok("dentist 3 nov 2pm").start).toEqual(new Date(2026, 10, 3, 14));
    expect(ok("dentist nov 3rd 2pm").start).toEqual(new Date(2026, 10, 3, 14));
    expect(ok("dentist in 2 days 10am").start).toEqual(at(28, 10));
    expect(ok("standup next mon 9am").start).toEqual(new Date(2026, 10, 2, 9)); // today is Monday
    expect(ok("standup mon 9am").start).toEqual(at(26, 9)); // this Monday (today)
    expect(ok("party the 31st 7pm").start).toEqual(at(31, 19));
    expect(ok("tax return 1 jul").start).toEqual(new Date(2027, 6, 1)); // already past this year
  });

  it("all-day events", () => {
    expect(ok("offsite planning fri all day")).toEqual({ title: "Offsite planning", start: at(30), end: at(31), allDay: true, location: null });
    expect(ok("Mum's birthday 14 nov")).toMatchObject({ title: "Mum's birthday", allDay: true, start: new Date(2026, 10, 14) });
  });

  it("tonight means this evening", () => {
    expect(ok("movie tonight")).toMatchObject({ title: "Movie", start: at(26, 19) });
    expect(ok("movie tonight 8:30pm")).toMatchObject({ start: at(26, 20, 30) });
  });

  it("explains what's missing", () => {
    expect(parseQuickEvent("just some words", now)).toEqual({ ok: false, reason: expect.stringContaining("time or a day") });
    expect(parseQuickEvent("fri 1pm", now)).toEqual({ ok: false, reason: "Add a title" });
  });
});

describe("parseSendTime", () => {
  const send = (s: string) => {
    const r = parseSendTime(s, now);
    if (!r.ok) throw new Error(`"${s}" failed: ${r.reason}`);
    return r.at;
  };

  it("reads times, days and relative offsets", () => {
    expect(send("tomorrow 9am")).toEqual(at(27, 9));
    expect(send("3pm")).toEqual(at(26, 15));
    expect(send("fri")).toEqual(at(30, 8)); // a day alone: 8am
    expect(send("tomorrow")).toEqual(at(27, 8));
    expect(send("in 2 hours")).toEqual(at(26, 13, 30));
    expect(send("in 45 min")).toEqual(at(26, 12, 15));
    expect(send("3 nov 14:00")).toEqual(new Date(2026, 10, 3, 14));
    expect(send("mon 9am")).toEqual(new Date(2026, 10, 2, 9)); // today is Monday, 9am has gone: next week
    expect(send("mon 3pm")).toEqual(at(26, 15)); // still to come today
  });

  it("rejects the past and leftovers", () => {
    expect(parseSendTime("today", now)).toEqual({ ok: false, reason: "That time has already passed" }); // 8am today
    expect(parseSendTime("tomorrow 9am please", now)).toEqual({ ok: false, reason: 'Didn\'t understand "please"' });
    expect(parseSendTime("whenever", now)).toMatchObject({ ok: false });
    expect(parseSendTime("", now)).toMatchObject({ ok: false });
  });
});
