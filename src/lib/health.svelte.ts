// Startup health checks' findings (health.rs), for the banner. Dismissing one hides it
// for this session; the checks run again at the next start (and every few hours).

import { api, onHealthChanged, type HealthIssue } from "./api";

class Health {
  issues = $state<HealthIssue[]>([]);
  dismissed = $state<string[]>([]);

  get visible() {
    return this.issues.filter((i) => !this.dismissed.includes(i.id));
  }

  /** Loads what's been found so far and follows changes. Returns the unlisten function. */
  async init() {
    const unlisten = await onHealthChanged((issues) => (this.issues = issues));
    this.issues = await api.healthIssues();
    return unlisten;
  }

  dismiss(id?: string) {
    this.dismissed = [...this.dismissed, ...(id ? [id] : this.visible.map((i) => i.id))];
  }
}

export const health = new Health();
