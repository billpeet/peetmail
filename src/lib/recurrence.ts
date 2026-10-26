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
