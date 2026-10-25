import type { Contact } from "./api";

/** Same rule as the SQL lookup (`LIKE %prefix%` on address or name), case-insensitive. */
export function matchesContact(c: Contact, text: string): boolean {
  const t = text.trim().toLowerCase();
  return !t || c.address.toLowerCase().includes(t) || (c.name ?? "").toLowerCase().includes(t);
}

/**
 * Suggestions still valid for what's typed now. Applied on every keystroke while the
 * fresh lookup is in flight, so Enter can never pick someone who no longer matches.
 */
export function narrow(list: Contact[], text: string): Contact[] {
  return list.filter((c) => matchesContact(c, text));
}
