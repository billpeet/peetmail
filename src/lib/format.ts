const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const full = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const long = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Compact list date: time today, "12 Oct" this year, full date otherwise. */
export function listDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return time.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayMonth.format(d);
  return full.format(d);
}

export function longDate(iso: string): string {
  return long.format(new Date(iso));
}

export function senderName(name: string | null, address: string | null): string {
  return name?.trim() || address || "(unknown sender)";
}

/** "1 conversation", "3 conversations". `plural` defaults to `singular + "s"`. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
