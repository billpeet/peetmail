// CHANGELOG.md, parsed. Shared by the app ("What's new", Help) and scripts/version.ts
// (which turns Unreleased into a version's section). Plain TypeScript: no Svelte, no DOM.

export type Entry = {
  /** Stable while the line's text is unchanged; how "seen" is remembered. */
  id: string;
  /** The line's Markdown, without the leading "- ". */
  text: string;
};

export type Section = {
  /** "Unreleased" or a version like "0.2.0". */
  title: string;
  /** "2026-11-03", when the heading has one. */
  date: string | null;
  entries: Entry[];
};

const HEADING = /^## +(.+?)(?: +[—–-] +(\d{4}-\d{2}-\d{2}))? *$/;

/** FNV-1a over the normalised text: short, stable, and needs no crypto API. */
export function entryId(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The sections, in file order (newest first). HTML comments are ignored. */
export function parseChangelog(md: string): Section[] {
  const sections: Section[] = [];
  const text = md.replace(/<!--[\s\S]*?-->/g, "");
  let current: Section | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = HEADING.exec(line);
    if (h) {
      current = { title: h[1].trim(), date: h[2] ?? null, entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const item = /^[-*] +(.+)$/.exec(line);
    if (item) current.entries.push({ id: entryId(item[1]), text: item[1].trim() });
    else if (/^ {2,}\S/.test(line) && current.entries.length) {
      // A wrapped continuation of the previous line.
      const last = current.entries[current.entries.length - 1];
      last.text = `${last.text} ${line.trim()}`;
      last.id = entryId(last.text);
    }
  }
  return sections;
}

export function allIds(sections: Section[]): string[] {
  return sections.flatMap((s) => s.entries.map((e) => e.id));
}

/**
 * What hasn't been seen yet, by section. `seen` null means a first run: nothing is new
 * then (a fresh install shouldn't open on a wall of history).
 */
export function unseen(sections: Section[], seen: string[] | null): Section[] {
  if (seen === null) return [];
  const known = new Set(seen);
  return sections.map((s) => ({ ...s, entries: s.entries.filter((e) => !known.has(e.id)) })).filter((s) => s.entries.length);
}

/**
 * The changelog with Unreleased renamed to `version` (dated) and a fresh, empty Unreleased
 * above it. Throws if there's nothing under Unreleased, or `version` already has a section.
 */
export function releaseUnreleased(md: string, version: string, date: string): string {
  const sections = parseChangelog(md);
  if (sections.some((s) => s.title === version)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const unreleased = sections.find((s) => s.title === "Unreleased");
  if (!unreleased?.entries.length) throw new Error("CHANGELOG.md has nothing under ## Unreleased to release");
  return md.replace(/^## +Unreleased *$/m, `## Unreleased\n\n## ${version} — ${date}`);
}

/** One section's lines as Markdown (release notes), or null if there's no such section. */
export function sectionMarkdown(md: string, title: string): string | null {
  const s = parseChangelog(md).find((x) => x.title === title);
  return s ? s.entries.map((e) => `- ${e.text}`).join("\n") : null;
}
