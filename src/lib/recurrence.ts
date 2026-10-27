// How a series repeats, in words: "Every 2 weeks on Tue and Thu, until 3 Dec 2026".
// Mirrors src-tauri/src/recurrence.rs.

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type RecurrenceEnd = { type: "never" } | { type: "until"; date: string } | { type: "count"; count: number };
export type Recurrence = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  days: Weekday[];
  /** 1..4, or -1 for the last ("the last Friday"). Set for monthly/yearly by weekday. */
  ordinal: number | null;
  dayOfMonth: number | null;
  /** 1..12 */
  month: number | null;
  end: RecurrenceEnd;
  /** First day of the series, YYYY-MM-DD. */
  start: string;
};

export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const ORDINALS: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "-1": "last" };

const short = (d: Weekday) => DAY_NAMES[d].slice(0, 3);
const monthName = (m: number) => new Date(2024, m - 1, 1).toLocaleDateString(undefined, { month: "long" });

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function every(n: number, unit: string): string {
  return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}

/** "3 Dec 2026" from YYYY-MM-DD. */
function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function describeRecurrence(r: Recurrence): string {
  let base: string;
  const days = WEEKDAYS.filter((d) => r.days.includes(d));
  switch (r.freq) {
    case "daily":
      base = every(r.interval, "day");
      break;
    case "weekly": {
      const weekdays = days.length === 5 && !days.includes("sat") && !days.includes("sun");
      if (weekdays && r.interval === 1) base = "Every weekday";
      else if (days.length === 7 && r.interval === 1) base = "Every day";
      else base = `${every(r.interval, "week")} on ${list(days.length === 1 ? [DAY_NAMES[days[0]]] : days.map(short))}`;
      break;
    }
    case "monthly":
      base = r.ordinal !== null && days[0]
        ? `${every(r.interval, "month")} on the ${ORDINALS[String(r.ordinal)]} ${DAY_NAMES[days[0]]}`
        : `${every(r.interval, "month")} on day ${r.dayOfMonth ?? 1}`;
      break;
    case "yearly":
      base = r.ordinal !== null && days[0]
        ? `${every(r.interval, "year")} on the ${ORDINALS[String(r.ordinal)]} ${DAY_NAMES[days[0]]} of ${monthName(r.month ?? 1)}`
        : `${every(r.interval, "year")} on ${r.dayOfMonth ?? 1} ${monthName(r.month ?? 1)}`;
      break;
  }
  if (r.end.type === "until") return `${base}, until ${dateLabel(r.end.date)}`;
  if (r.end.type === "count") return `${base}, ${r.end.count} ${r.end.count === 1 ? "time" : "times"}`;
  return base;
}

// ---------- editing ----------

const JS_DAY: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d, date: new Date(y, m - 1, d) };
}

export function weekdayOf(iso: string): Weekday {
  return JS_DAY[parts(iso).date.getDay()];
}

/** Which of its weekday in the month a date is: "the 4th Tuesday", and whether it's also the last. */
export function nthOfMonth(iso: string): { ordinal: number; isLast: boolean } {
  const { y, m, d } = parts(iso);
  const daysInMonth = new Date(y, m, 0).getDate();
  return { ordinal: Math.ceil(d / 7), isLast: d + 7 > daysInMonth };
}

export function dayName(d: Weekday): string {
  return DAY_NAMES[d];
}

export function ordinalName(o: number): string {
  return ORDINALS[String(o)];
}

export type PresetId = "daily" | "weekdays" | "weekly" | "monthlyNth" | "monthlyLast" | "monthlyDay" | "yearly";
export type Preset = { id: PresetId; label: string; rule: Recurrence };

const base = (start: string, over: Partial<Recurrence>): Recurrence => ({
  freq: "weekly", interval: 1, days: [], ordinal: null, dayOfMonth: null, month: null, end: { type: "never" }, start, ...over,
});

/** The usual choices for a series starting on `start` (as Outlook and Google offer them). */
export function presets(start: string): Preset[] {
  const { m, d } = parts(start);
  const day = weekdayOf(start);
  const { ordinal, isLast } = nthOfMonth(start);
  const list: Preset[] = [
    { id: "daily", label: "Every day", rule: base(start, { freq: "daily" }) },
    { id: "weekdays", label: "Every weekday (Mon–Fri)", rule: base(start, { days: ["mon", "tue", "wed", "thu", "fri"] }) },
    { id: "weekly", label: `Every week on ${dayName(day)}`, rule: base(start, { days: [day] }) },
  ];
  // A fifth weekday only exists in some months: offer "last" instead.
  if (ordinal <= 4) list.push({ id: "monthlyNth", label: `Every month on the ${ordinalName(ordinal)} ${dayName(day)}`, rule: base(start, { freq: "monthly", ordinal, days: [day] }) });
  if (isLast) list.push({ id: "monthlyLast", label: `Every month on the last ${dayName(day)}`, rule: base(start, { freq: "monthly", ordinal: -1, days: [day] }) });
  list.push({ id: "monthlyDay", label: `Every month on day ${d}`, rule: base(start, { freq: "monthly", dayOfMonth: d }) });
  list.push({ id: "yearly", label: `Every year on ${d} ${monthName(m)}`, rule: base(start, { freq: "yearly", dayOfMonth: d, month: m }) });
  return list;
}

/** The pattern without its start and end, in a fixed form (for comparing). */
function shape(r: Recurrence) {
  const days = WEEKDAYS.filter((d) => r.days.includes(d));
  const weeklyOrRelative = r.freq === "weekly" || r.ordinal !== null;
  return JSON.stringify([
    r.freq,
    Math.max(1, r.interval),
    weeklyOrRelative ? days : [],
    r.freq === "monthly" || r.freq === "yearly" ? r.ordinal : null,
    r.ordinal === null && (r.freq === "monthly" || r.freq === "yearly") ? r.dayOfMonth : null,
    r.freq === "yearly" ? r.month : null,
  ]);
}

/** Which preset a pattern is for a series starting on `start`, or "custom". */
export function matchPreset(r: Recurrence, start: string): PresetId | "custom" {
  return presets(start).find((p) => shape(p.rule) === shape(r))?.id ?? "custom";
}

function endKey(e: RecurrenceEnd) {
  return e.type === "until" ? `until:${e.date}` : e.type === "count" ? `count:${e.count}` : "never";
}

/** Same series pattern, however the objects were built. */
export function sameRecurrence(a: Recurrence | null, b: Recurrence | null): boolean {
  if (!a || !b) return a === b;
  return shape(a) === shape(b) && endKey(a.end) === endKey(b.end) && a.start === b.start;
}

/** What's wrong with a pattern, if anything (the editor won't save it). */
export function recurrenceProblem(r: Recurrence): string | null {
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 99) return "Repeat every 1 to 99";
  if (r.freq === "weekly" && r.days.length === 0) return "Pick at least one day to repeat on";
  if (r.end.type === "count" && (!Number.isInteger(r.end.count) || r.end.count < 1 || r.end.count > 999)) return "Repeat 1 to 999 times";
  if (r.end.type === "until" && (!r.end.date || r.end.date < r.start)) return "The repeat end is before the start";
  return null;
}
