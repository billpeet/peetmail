// Natural-language event entry: "lunch with Sam fri 1pm @ Café Beetroot".
// Pure: pass `now` in tests. Unrecognised words become the title.

export type QuickEvent = { title: string; start: Date; end: Date; allDay: boolean; location: string | null };
export type QuickResult = { ok: true; event: QuickEvent } | { ok: false; reason: string };

const DEFAULT_MINUTES = 30;

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const WD = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
const MO = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
// 1pm, 1:30pm, 9.30, 13:00, noon, midnight (captures: hour, minute, meridiem | word)
const TIME = String.raw`(?:(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a|p)?|(noon|midday|midnight))`;

type Time = { h: number; m: number; meridiem: "am" | "pm" | null };

function readTime(h?: string, m?: string, mer?: string, word?: string): Time | null {
  if (word) return word === "midnight" ? { h: 0, m: 0, meridiem: "am" } : { h: 12, m: 0, meridiem: "pm" };
  if (h === undefined) return null;
  const hour = Number(h);
  const minute = m ? Number(m) : 0;
  if (hour > 23 || minute > 59) return null;
  const meridiem = mer ? (mer.startsWith("a") ? "am" : "pm") : null;
  if (meridiem && (hour < 1 || hour > 12)) return null;
  return { h: hour, m: minute, meridiem };
}

/** 24h hour. Without am/pm, small numbers are afternoon (a meeting "at 4" is 4pm). */
function to24(t: Time, fallback: "am" | "pm" | null = null): number {
  const mer = t.meridiem ?? fallback;
  if (mer === "am") return t.h % 12;
  if (mer === "pm") return (t.h % 12) + 12;
  if (t.h >= 13 || t.h === 0) return t.h; // already 24h
  return t.h >= 1 && t.h <= 7 ? t.h + 12 : t.h; // 8–12 morning/noon, 1–7 afternoon
}

/** Day/month order of the user's locale, for numeric dates like 3/11. */
function dayFirst(): boolean {
  const parts = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "numeric" }).formatToParts(new Date(2024, 10, 3));
  return parts.findIndex((p) => p.type === "day") < parts.findIndex((p) => p.type === "month");
}

const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function parseQuickEvent(input: string, now = new Date()): QuickResult {
  let text = ` ${input.trim()} `;
  const take = (re: RegExp): RegExpMatchArray | null => {
    const m = text.match(re);
    if (m) text = text.replace(m[0], " ");
    return m;
  };

  // Location: everything after " @ ".
  let location: string | null = null;
  const loc = take(/\s@\s*(.+?)\s*$/);
  if (loc) location = loc[1].trim() || null;

  const allDay = !!take(/\ball[- ]day\b/i);

  // Duration: "for 45m", "2h", "1.5 hours", "90 mins".
  let minutes: number | null = null;
  const dur =
    take(/\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i) ??
    take(/\b(?:for\s+)?(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (dur) minutes = /h/i.test(dur[0].replace(/^.*?\d/, "")) ? Math.round(Number(dur[1]) * 60) : Number(dur[1]);

  // Time range: "1-2pm", "10:30 to 11:15", "from 2 to 4pm".
  let start: Time | null = null;
  let end: Time | null = null;
  const range = take(new RegExp(String.raw`\b(?:from\s+)?${TIME}\s*(?:-|–|to|until|till)\s*${TIME}(?=\s)`, "i"));
  if (range) {
    start = readTime(range[1], range[2], range[3]?.toLowerCase(), range[4]?.toLowerCase());
    end = readTime(range[5], range[6], range[7]?.toLowerCase(), range[8]?.toLowerCase());
  }
  if (!start) {
    // A single time needs am/pm, minutes, "at", or a word, so "3 nov" isn't read as 3 o'clock.
    const single =
      take(new RegExp(String.raw`\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b`, "i")) ??
      take(new RegExp(String.raw`\b(?:at\s+)?(\d{1,2})[:.](\d{2})()\b`, "i")) ??
      take(/\bat\s+(\d{1,2})()()(?=\s)/i);
    if (single) start = readTime(single[1], single[2] || undefined, single[3]?.toLowerCase() || undefined);
    else {
      const word = take(/\b(?:at\s+)?(noon|midday|midnight)\b/i);
      if (word) start = readTime(undefined, undefined, undefined, word[1].toLowerCase());
    }
  }
  if (take(/\btonight\b/i)) {
    start ??= { h: 7, m: 0, meridiem: "pm" };
    text = ` today ${text}`;
  }

  // Date.
  let day: Date | null = null;
  const today = atMidnight(now);
  let m: RegExpMatchArray | null;
  if (take(/\btoday\b/i)) day = today;
  else if (take(/\b(?:tomorrow|tmrw|tmr)\b/i)) day = addDays(today, 1);
  else if ((m = take(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/i))) day = addDays(today, Number(m[1]) * (m[2].startsWith("w") ? 7 : 1));
  else if ((m = take(new RegExp(String.raw`\b(?:on\s+)?(next\s+)?(${WD})\b`, "i")))) {
    const target = WEEKDAYS[m[2].toLowerCase()];
    let diff = (target - today.getDay() + 7) % 7;
    if (m[1] && diff === 0) diff = 7; // "next fri" on a Friday is a week away
    day = addDays(today, diff);
  } else if ((m = take(new RegExp(String.raw`\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(${MO})(?:\s+(\d{4}))?\b`, "i")))) {
    day = dateFor(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3], today);
  } else if ((m = take(new RegExp(String.raw`\b(?:on\s+)?(${MO})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "i")))) {
    day = dateFor(Number(m[2]), MONTHS[m[1].toLowerCase()], m[3], today);
  } else if ((m = take(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [d, mo] = dayFirst() ? [a, b - 1] : [b, a - 1];
    day = dateFor(d, mo, m[3] && m[3].length === 2 ? `20${m[3]}` : m[3], today);
  } else if ((m = take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i))) {
    const n = Number(m[1]);
    day = new Date(today.getFullYear(), today.getMonth(), n);
    if (day < today) day = new Date(today.getFullYear(), today.getMonth() + 1, n);
  }
  if (day === undefined) day = null;

  const title = cleanTitle(text);
  if (!title) return { ok: false, reason: "Add a title" };

  if (allDay || (day && !start)) {
    const d = day ?? today;
    return { ok: true, event: { title, start: d, end: addDays(d, 1), allDay: true, location } };
  }
  if (!start) return { ok: false, reason: "Add a time or a day, e.g. \"fri 1pm\"" };

  // A range like "11-1pm": the end's am/pm decides the start's when it's missing.
  const endMer = end?.meridiem ?? null;
  let startH = to24(start, start.meridiem ?? endMer);
  let base = day ?? today;
  let startAt = new Date(base.getFullYear(), base.getMonth(), base.getDate(), startH, start.m);
  if (end && !start.meridiem && endMer) {
    const endH = to24(end);
    if (startH > endH) {
      startH -= 12; // "11-1pm" → 11am to 1pm
      startAt = new Date(base.getFullYear(), base.getMonth(), base.getDate(), startH, start.m);
    }
  }
  // Only a time: the next time it comes round.
  if (!day && startAt.getTime() < now.getTime()) {
    base = addDays(base, 1);
    startAt = addDays(startAt, 1);
    startAt.setHours(startH, start.m);
  }

  let endAt: Date;
  if (end) {
    endAt = new Date(base.getFullYear(), base.getMonth(), base.getDate(), to24(end, end.meridiem ?? (startH >= 12 ? "pm" : null)), end.m);
    if (endAt <= startAt) endAt = new Date(endAt.getTime() + 12 * 3_600_000);
    if (endAt <= startAt) endAt = new Date(endAt.getTime() + 12 * 3_600_000);
  } else {
    endAt = new Date(startAt.getTime() + (minutes ?? DEFAULT_MINUTES) * 60_000);
  }
  return { ok: true, event: { title, start: startAt, end: endAt, allDay: false, location } };
}

function dateFor(day: number, month: number, year: string | undefined, today: Date): Date | null {
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  if (year) return new Date(Number(year), month, day);
  const d = new Date(today.getFullYear(), month, day);
  return d < addDays(today, -1) ? new Date(today.getFullYear() + 1, month, day) : d;
}

function cleanTitle(rest: string): string {
  const t = rest
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:on|at|for|from|to|by)\s+/i, "")
    .replace(/\s+(?:on|at|for|from|to|by|in)$/i, "")
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}
