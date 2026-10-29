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

const DAY = 86_400_000;
const weekdayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
const weekdayDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const monthName = new Intl.DateTimeFormat(undefined, { month: "long" });
const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** Section for a Recent Opens entry, like Superhuman: "Last 7 days", "Earlier this month", "September", "September 2025". */
export function recentGroup(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (now.getTime() - d.getTime() < 7 * DAY) return "Last 7 days";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "Earlier this month";
  return d.getFullYear() === now.getFullYear() ? monthName.format(d) : monthYear.format(d);
}

/** Time label for a Recent Opens entry: "Fri 7:45 pm" within a week, else "Thu 15 Oct". */
export function recentTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return now.getTime() - d.getTime() < 7 * DAY ? weekdayTime.format(d) : weekdayDate.format(d);
}

/** "68 B", "12 KB", "3.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The most a message's attached files may add up to (Rust enforces it too: draft_files.rs). */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

/**
 * Whether files of these sizes still fit beside what's already attached; if not, a sentence
 * saying why, for a toast.
 */
export function attachmentRoom(attached: number[], adding: number[]): string | null {
  const total = [...attached, ...adding].reduce((a, b) => a + b, 0);
  if (total <= MAX_ATTACHMENTS_BYTES) return null;
  return `That would make ${fileSize(total)} of attachments; a message can carry ${fileSize(MAX_ATTACHMENTS_BYTES)} at most.`;
}
