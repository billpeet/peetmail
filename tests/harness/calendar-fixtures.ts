// Calendar fixtures for the fake Graph server, laid out around "today" in the local time
// zone (the app and the fake run on the same machine), returned in UTC like Graph does
// under `Prefer: outlook.timezone="UTC"`.
import { ACCOUNT } from "./fixtures.ts";

export type GraphEvent = {
  id: string;
  subject: string;
  isAllDay: boolean;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location: { displayName: string };
  organizer: { emailAddress: { name: string; address: string } };
  attendees: { emailAddress: { name: string; address: string }; status: { response: string }; type: string }[];
  responseStatus: { response: string; time?: string };
  isOrganizer: boolean;
  isCancelled: boolean;
  showAs: string;
  onlineMeeting: { joinUrl: string } | null;
  webLink: string;
  bodyPreview: string;
  type: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string;
  /** Fake-only: delta sends this event bare (id, type, seriesMasterId, start, end), like Graph does for occurrences. */
  bare?: boolean;
  /** Fake-only: a series master that delta doesn't list (the app must GET it by id). */
  hiddenFromDelta?: boolean;
};

/** Graph's UTC dateTime form: "2026-10-27T03:00:00.0000000". */
const graphUtc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, ".0000000");
/** All-day events: midnight of the local date, no conversion. */
const graphDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00:00.0000000`;

/** A local time `dayOffset` days from today. */
export function localAt(dayOffset: number, hour: number, minute = 0, now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute);
  return d;
}

const ME = { name: ACCOUNT.displayName, address: ACCOUNT.mail };
const SAM = { name: "Sam Carter", address: "sam.carter@contoso.com" };
const PRIYA = { name: "Priya Nair", address: "priya@fabrikam.io" };

type Spec = {
  id: string;
  subject: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  location?: string;
  organizer?: { name: string; address: string };
  attendees?: { name: string; address: string }[];
  response?: string;
  join?: boolean;
  showAs?: string;
  type?: GraphEvent["type"];
  seriesMasterId?: string;
  bare?: boolean;
  hiddenFromDelta?: boolean;
};

export function makeEvent(s: Spec): GraphEvent {
  const organizer = s.organizer ?? ME;
  const isOrganizer = organizer.address === ME.address;
  return {
    id: s.id,
    subject: s.subject,
    isAllDay: !!s.allDay,
    start: { dateTime: s.allDay ? graphDate(s.start) : graphUtc(s.start), timeZone: "UTC" },
    end: { dateTime: s.allDay ? graphDate(s.end) : graphUtc(s.end), timeZone: "UTC" },
    location: { displayName: s.location ?? "" },
    organizer: { emailAddress: organizer },
    attendees: (s.attendees ?? []).map((a) => ({ emailAddress: a, status: { response: "none" }, type: "required" })),
    responseStatus: { response: s.response ?? (isOrganizer ? "organizer" : "accepted") },
    isOrganizer,
    isCancelled: false,
    showAs: s.showAs ?? "busy",
    onlineMeeting: s.join ? { joinUrl: `https://teams.example/join/${s.id}` } : null,
    webLink: `https://outlook.office.com/calendar/item/${s.id}`,
    bodyPreview: "",
    type: s.type ?? (s.seriesMasterId ? "occurrence" : "singleInstance"),
    ...(s.seriesMasterId ? { seriesMasterId: s.seriesMasterId } : {}),
    ...(s.bare ? { bare: true } : {}),
    ...(s.hiddenFromDelta ? { hiddenFromDelta: true } : {}),
  };
}

/**
 * Default calendar:
 *   evt-standup-N   daily 9:00–9:15 standup, 10 days either side of today: bare occurrences of
 *                   evt-standup-series (a master delta does list)
 *   evt-sync-N      weekly Wed 14:00 "Team sync": bare occurrences of evt-sync-series, a master
 *                   delta doesn't list (fetched by id)
 *   evt-bare        tomorrow 16:00 "Quarterly planning": a bare single event (fetched by id)
 *   evt-invite      today 11:00–12:00 "Design review", not yet answered (linked to msg-invite)
 *   evt-lunch       today 13:00–14:00
 *   evt-1on1 / evt-focus   today 15:00–15:45 and 15:30–16:30 (overlap)
 *   evt-dentist     tomorrow 10:00–11:00
 *   evt-offsite     all day, two days from now
 */
export function defaultCalendar(now = new Date()): GraphEvent[] {
  const events: GraphEvent[] = [];
  // Recurring series, the way calendarView delta delivers them: occurrences carry only
  // their times; subject, organiser and attendees live on the master.
  events.push(makeEvent({
    id: "evt-standup-series", type: "seriesMaster", subject: "Standup", start: localAt(-10, 9, 0, now), end: localAt(-10, 9, 15, now),
    organizer: SAM, attendees: [ME, PRIYA], join: true,
  }));
  for (let d = -10; d <= 10; d++) {
    events.push(makeEvent({
      id: `evt-standup-${d + 10}`, subject: "", start: localAt(d, 9, 0, now), end: localAt(d, 9, 15, now),
      seriesMasterId: "evt-standup-series", bare: true,
    }));
  }
  const wed = (week: number) => localAt(((3 - now.getDay() + 7) % 7) + 7 * week, 14, 0, now);
  events.push(makeEvent({
    id: "evt-sync-series", type: "seriesMaster", subject: "Team sync", start: wed(-8), end: new Date(wed(-8).getTime() + 30 * 60_000),
    location: "Room 2", organizer: PRIYA, attendees: [ME, SAM], hiddenFromDelta: true,
  }));
  for (let w = -2; w <= 2; w++) {
    events.push(makeEvent({
      id: `evt-sync-${w + 2}`, subject: "", start: wed(w), end: new Date(wed(w).getTime() + 30 * 60_000),
      seriesMasterId: "evt-sync-series", bare: true,
    }));
  }
  // Moved after you accepted (see msg-update-*): new time, and Graph resets your response.
  events.push(makeEvent({
    id: "evt-update", subject: "Team health: conflict & commitment", start: localAt(3, 10, 0, now), end: localAt(3, 10, 45, now),
    location: "Room 3", organizer: SAM, attendees: [ME, PRIYA], response: "notResponded",
  }));
  // Clashes with the moved meeting's new time, so the invite shows in context.
  events.push(makeEvent({ id: "evt-clash", subject: "Client call", start: localAt(3, 10, 30, now), end: localAt(3, 11, 15, now), organizer: PRIYA, attendees: [ME] }));
  events.push(makeEvent({ id: "evt-bare", subject: "Quarterly planning", start: localAt(1, 16, 0, now), end: localAt(1, 17, 0, now), location: "Board room", bare: true }));
  events.push(makeEvent({
    id: "evt-invite", subject: "Design review", start: localAt(0, 11, 0, now), end: localAt(0, 12, 0, now),
    location: "Room 4 / Teams", organizer: { name: "Calendar", address: "calendar-noreply@contoso.com" },
    attendees: [ME, SAM, PRIYA], response: "notResponded", join: true, showAs: "tentative",
  }));
  events.push(makeEvent({ id: "evt-lunch", subject: "Lunch with Sam", start: localAt(0, 13, 0, now), end: localAt(0, 14, 0, now), location: "Café Beetroot" }));
  events.push(makeEvent({ id: "evt-1on1", subject: "1:1 Priya", start: localAt(0, 15, 0, now), end: localAt(0, 15, 45, now), organizer: PRIYA, attendees: [ME] }));
  events.push(makeEvent({ id: "evt-focus", subject: "Focus time", start: localAt(0, 15, 30, now), end: localAt(0, 16, 30, now), showAs: "busy" }));
  events.push(makeEvent({ id: "evt-dentist", subject: "Dentist", start: localAt(1, 10, 0, now), end: localAt(1, 11, 0, now), location: "12 Smile St" }));
  events.push(makeEvent({ id: "evt-offsite", subject: "Team offsite", start: localAt(2, 0, 0, now), end: localAt(3, 0, 0, now), allDay: true }));
  return events;
}
