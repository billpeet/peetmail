// "What's new": CHANGELOG.md is compiled into the app; the lines already shown are
// remembered (by id) in the app's settings. After an update, the lines not seen yet open
// in a panel; Help shows the whole changelog.

import changelogMd from "../../CHANGELOG.md?raw";
import { api } from "./api";
import { allIds, parseChangelog, unseen, type Section } from "./changelog";

class WhatsNew {
  readonly sections: Section[] = parseChangelog(changelogMd);
  /** Ids already shown; null until loaded. */
  seen = $state<string[] | null>(null);

  /** Lines not shown yet, by section. */
  get fresh(): Section[] {
    return unseen(this.sections, this.seen);
  }

  isNew(id: string) {
    return this.seen !== null && !this.seen.includes(id);
  }

  /** Loads what's been seen. A first run records everything as seen: nothing to announce. */
  async init() {
    const seen = await api.changelogSeen();
    if (seen === null) {
      this.seen = allIds(this.sections);
      await api.setChangelogSeen(this.seen);
    } else {
      this.seen = seen;
    }
  }

  async markAllSeen() {
    const ids = allIds(this.sections);
    if (this.seen && ids.every((id) => this.seen!.includes(id))) return;
    // Keep ids of lines that have since been reworded or removed: harmless, and a line
    // that comes back isn't announced twice.
    this.seen = [...new Set([...(this.seen ?? []), ...ids])];
    await api.setChangelogSeen(this.seen);
  }
}

export const whatsNew = new WhatsNew();

/** "Unreleased" means not in a stable release yet: on canary, "this build". */
export function sectionLabel(s: Section): string {
  if (s.title === "Unreleased") return "Since the last release";
  const date = s.date ? ` · ${new Date(`${s.date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : "";
  return `Version ${s.title}${date}`;
}
