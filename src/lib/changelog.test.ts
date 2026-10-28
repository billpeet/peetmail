import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { entryId, parseChangelog, releaseUnreleased, sectionMarkdown, unseen } from "./changelog";

const md = `# What's new

Intro text that isn't a section.

<!-- A note for editors.
- not an entry -->

## Unreleased

- New **thing**
- Another thing that wraps
  onto a second line

## 0.2.0 — 2026-11-03

- Older thing
`;

describe("parseChangelog", () => {
  it("reads sections, dates and lines, skipping comments and the intro", () => {
    const s = parseChangelog(md);
    expect(s.map((x) => [x.title, x.date, x.entries.map((e) => e.text)])).toEqual([
      ["Unreleased", null, ["New **thing**", "Another thing that wraps onto a second line"]],
      ["0.2.0", "2026-11-03", ["Older thing"]],
    ]);
  });

  it("gives a line the same id until its text changes", () => {
    expect(entryId("Older thing")).toBe(entryId("  Older   thing "));
    expect(entryId("Older thing")).not.toBe(entryId("Older things"));
    expect(parseChangelog(md)[1].entries[0].id).toBe(entryId("Older thing"));
  });
});

describe("unseen", () => {
  const sections = parseChangelog(md);

  it("shows nothing on a first run", () => {
    expect(unseen(sections, null)).toEqual([]);
  });

  it("shows only lines not seen, by section", () => {
    const seen = [entryId("New **thing**"), entryId("Older thing")];
    expect(unseen(sections, seen).map((s) => [s.title, s.entries.map((e) => e.text)])).toEqual([["Unreleased", ["Another thing that wraps onto a second line"]]]);
  });
});

describe("releasing", () => {
  it("turns Unreleased into the version's section, leaving an empty Unreleased", () => {
    const out = releaseUnreleased(md.replace(/## 0\.2\.0[\s\S]*/, ""), "0.3.0", "2026-12-01");
    const s = parseChangelog(out);
    expect(s.map((x) => [x.title, x.entries.length])).toEqual([
      ["Unreleased", 0],
      ["0.3.0", 2],
    ]);
    expect(s[1].date).toBe("2026-12-01");
    // Ids don't change when a line moves into a release, so nobody sees it twice.
    expect(s[1].entries[0].id).toBe(entryId("New **thing**"));
  });

  it("refuses an empty Unreleased or a version that's already there", () => {
    expect(() => releaseUnreleased("## Unreleased\n\n## 0.1.0\n- x\n", "0.2.0", "2026-12-01")).toThrow(/nothing under/);
    expect(() => releaseUnreleased(md, "0.2.0", "2026-12-01")).toThrow(/already has/);
  });

  it("gives a section's lines as release notes", () => {
    expect(sectionMarkdown(md, "0.2.0")).toBe("- Older thing");
    expect(sectionMarkdown(md, "9.9.9")).toBeNull();
  });
});

describe("the real CHANGELOG.md", () => {
  it("parses, has an Unreleased section, and has no repeated lines", () => {
    const s = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
    expect(s[0]?.title).toBe("Unreleased");
    const ids = s.flatMap((x) => x.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
