// Snippets in the composer: type ";name" (or Ctrl+;) and pick one to insert its text,
// with {first_name}-style placeholders filled in. Pure helpers; the composer wires them up.

export type Snippet = { name: string; body: string };
export type Person = { name: string | null; address: string };

/** The ";query" being typed just before the caret, if any. `;` must start a word. */
export function snippetTrigger(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = before.match(/(^|\s);([\w-]*)$/);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Name matches first (prefix, then anywhere in the name), then body text. */
export function matchSnippets(snippets: Snippet[], query: string): Snippet[] {
  const q = query.toLowerCase();
  if (!q) return snippets;
  const name = (s: Snippet) => s.name.toLowerCase();
  return [
    ...snippets.filter((s) => name(s).startsWith(q)),
    ...snippets.filter((s) => !name(s).startsWith(q) && name(s).includes(q)),
    ...snippets.filter((s) => !name(s).includes(q) && s.body.toLowerCase().includes(q)),
  ];
}

/** A display name from an address when there's no real one: "priya.nair@x" -> "Priya Nair". */
function nameFromAddress(address: string): string {
  return address
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function names(p: Person | null): { full: string; first: string } {
  if (!p) return { full: "", first: "" };
  // "Nair, Priya" is how some directories send names.
  const raw = (p.name?.trim() || nameFromAddress(p.address)).replace(/^([^,]+),\s*(.+)$/, "$2 $1");
  return { full: raw, first: raw.split(/\s+/)[0] ?? "" };
}

/**
 * Fills in {first_name} / {name} (the first recipient) and {my_first_name} / {my_name}.
 * Placeholders it doesn't know are left as typed.
 */
export function expandSnippet(body: string, ctx: { to: Person | null; me: Person | null }): string {
  const to = names(ctx.to);
  const me = names(ctx.me);
  const values: Record<string, string> = { first_name: to.first, name: to.full, my_first_name: me.first, my_name: me.full };
  return body.replace(/\{(\w+)\}/g, (all, key: string) => (key.toLowerCase() in values ? values[key.toLowerCase()] : all));
}
