import type { CalendarEvent } from "./api";

/** How an event looks: whether it's settled, waiting on you, maybe, or declined. */
export type Tone = "confirmed" | "pending" | "tentative" | "declined";

/**
 * Only invitations from someone else that you haven't answered are pending. Events you
 * organise, and personal appointments, come back from Graph with response "none" or
 * "organizer": those are confirmed.
 */
export function eventTone(e: Pick<CalendarEvent, "response" | "isOrganizer">): Tone {
  if (e.isOrganizer) return "confirmed";
  switch (e.response) {
    case "declined":
      return "declined";
    case "tentativelyAccepted":
      return "tentative";
    case "notResponded":
      return "pending";
    default:
      return "confirmed"; // accepted, organizer, none (no reply needed), unknown
  }
}

export const TONE_CLASSES: Record<Tone, string> = {
  confirmed: "border border-accent/40 bg-accent/25 text-ink-100",
  pending: "border border-dashed border-accent/70 bg-accent/10 text-ink-100",
  tentative: "border border-dashed border-accent/50 bg-accent/15 text-ink-100",
  declined: "border border-ink-700 text-ink-500 line-through",
};
