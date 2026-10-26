// Calendar state for the day view (right pane) and, later, the week view.
import { api, type CalendarEvent } from "./api";

const DAY = 86_400_000;

/** Local midnight of the day containing `d`. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** YYYY-MM-DD of a local date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isAllDay(e: CalendarEvent): boolean {
  return e.isAllDay;
}

/** Start/end as Dates. All-day dates become local midnights. */
export function eventTimes(e: CalendarEvent): { start: Date; end: Date } {
  if (e.isAllDay) {
    const [ys, ms, ds] = e.startAt.split("-").map(Number);
    const [ye, me, de] = e.endAt.split("-").map(Number);
    return { start: new Date(ys, ms - 1, ds), end: new Date(ye, me - 1, de) };
  }
  return { start: new Date(e.startAt), end: new Date(e.endAt) };
}

/** Events overlapping local days `[from, to)`. */
export function fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  return api.listEvents(from.toISOString(), to.toISOString(), localDate(from), localDate(to));
}

class CalendarStore {
  /** Day shown in the day view (local midnight). */
  day = $state(startOfDay(new Date()));
  dayEvents = $state.raw<CalendarEvent[]>([]);
  #seq = 0;

  get isToday(): boolean {
    return this.day.getTime() === startOfDay(new Date()).getTime();
  }

  async load() {
    const seq = ++this.#seq;
    const events = await fetchEvents(this.day, addDays(this.day, 1));
    if (seq === this.#seq) this.dayEvents = events;
  }

  async goToDay(d: Date) {
    this.day = startOfDay(d);
    await this.load();
  }

  shiftDay(n: number) {
    return this.goToDay(addDays(this.day, n));
  }

  today() {
    return this.goToDay(new Date());
  }
}

export const calendar = new CalendarStore();
export { DAY };
