// Accounts hidden from view (toggled in the footer legend): their mail leaves the inbox,
// split counts and search, and their events leave the calendar. Remembered on this PC.

const KEY = "peetmail.hiddenAccounts";

function load(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

class Visibility {
  hidden = $state<number[]>(load());

  isHidden(id: number): boolean {
    return this.hidden.includes(id);
  }

  /** Hides or shows an account. Won't hide the last visible one of `all`. Returns whether anything changed. */
  toggle(id: number, all: number[]): boolean {
    if (this.isHidden(id)) {
      this.hidden = this.hidden.filter((x) => x !== id);
    } else {
      const visible = all.filter((a) => !this.isHidden(a));
      if (visible.length <= 1) return false;
      this.hidden = [...this.hidden, id];
    }
    localStorage.setItem(KEY, JSON.stringify(this.hidden));
    return true;
  }

  /** Hidden ids that are still accounts (drops ones that were signed out). */
  among(all: number[]): number[] {
    return this.hidden.filter((h) => all.includes(h));
  }
}

export const visibility = new Visibility();
