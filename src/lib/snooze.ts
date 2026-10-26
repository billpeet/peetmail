// Snooze presets, like Superhuman's: later today, this evening, tomorrow, the weekend,
// next week. Pure: pass `now` in tests.

export type SnoozePreset = { id: string; label: string; at: Date };

const MORNING = 8;
const EVENING = 18;

const day = (now: Date, plusDays: number, hour: number) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + plusDays, hour);

export function snoozePresets(now = new Date()): SnoozePreset[] {
  const list: SnoozePreset[] = [];
  // Three hours on, to the hour; only while that's still the working day.
  const later = new Date(now.getTime() + 3 * 3_600_000);
  later.setMinutes(0, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() <= EVENING) list.push({ id: "later", label: "Later today", at: later });
  if (now.getHours() < EVENING - 2) list.push({ id: "evening", label: "This evening", at: day(now, 0, EVENING) });
  list.push({ id: "tomorrow", label: "Tomorrow", at: day(now, 1, MORNING) });
  const dow = now.getDay(); // 0 Sun ... 6 Sat
  // Saturday morning, unless it's already the weekend (then next Saturday).
  if (dow >= 1 && dow <= 5) list.push({ id: "weekend", label: "This weekend", at: day(now, 6 - dow, MORNING) });
  else list.push({ id: "weekend", label: "Next weekend", at: day(now, dow === 6 ? 7 : 6, MORNING) });
  list.push({ id: "nextweek", label: "Next week", at: day(now, ((8 - dow) % 7) || 7, MORNING) });
  return list;
}
