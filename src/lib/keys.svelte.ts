import { afterNextPaint } from "./perf";

// Single keymap registry. Every action is registered here once; the shortcut overlay
// and (in Phase 1) the command palette read from the same list.

export type Binding = {
  id: string;
  /** Space-separated sequence, e.g. "j", "g i", "ctrl+k", "?", "Escape". Empty: palette only. */
  keys: string;
  label: string;
  group: string;
  /** Binding is active only while this returns true. */
  when?: () => boolean;
  run: (e: KeyboardEvent) => void;
};

const SEQUENCE_TIMEOUT_MS = 1200;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

export function normalizeKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key = e.key === " " ? "Space" : e.key;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  // Printable keys already encode shift ("J", "?", "#"); named keys and chords spell it out.
  if (e.shiftKey && (key.length > 1 || mods.length)) mods.push("shift");
  if (mods.length && key.length === 1) key = key.toLowerCase();
  return [...mods, key].join("+");
}

function isTypingTarget(t: EventTarget | null) {
  if (typeof Element === "undefined" || !(t instanceof Element)) return false;
  const el = t as HTMLElement;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

class Keymap {
  bindings = $state.raw<Binding[]>([]);
  /** Told how long each action took, from the key press to the next painted frame (telemetry). */
  onAction: ((id: string, ms: number) => void) | null = null;
  pending = $state<string[]>([]);
  #timer: ReturnType<typeof setTimeout> | undefined;

  register(list: Binding[]) {
    const ids = new Set(list.map((b) => b.id));
    this.bindings = [...this.bindings.filter((b) => !ids.has(b.id)), ...list];
    return () => {
      this.bindings = this.bindings.filter((b) => !ids.has(b.id));
    };
  }

  active() {
    return this.bindings.filter((b) => !b.when || b.when());
  }

  #reset() {
    clearTimeout(this.#timer);
    this.pending = [];
  }

  handle = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return;
    const key = normalizeKey(e);
    if (!key) return;
    // In text fields only Escape and ctrl chords are shortcuts.
    if (isTypingTarget(e.target) && key !== "Escape" && !key.startsWith("ctrl+")) return;

    const seq = [...this.pending, key].join(" ");
    const candidates = this.active();
    const exact = candidates.find((b) => b.keys === seq);
    const isPrefix = candidates.some((b) => b.keys.startsWith(seq + " "));

    if (exact && !isPrefix) {
      e.preventDefault();
      this.#reset();
      const started = performance.now();
      exact.run(e);
      const onAction = this.onAction;
      if (onAction) afterNextPaint(() => onAction(exact.id, performance.now() - started));
      return;
    }
    if (isPrefix) {
      e.preventDefault();
      clearTimeout(this.#timer);
      this.pending = [...this.pending, key];
      this.#timer = setTimeout(() => this.#reset(), SEQUENCE_TIMEOUT_MS);
      return;
    }
    if (this.pending.length) {
      // Dead sequence: drop it and treat this key as a fresh start.
      this.#reset();
      this.handle(e);
    }
  };
}

export const keymap = new Keymap();

/** "g i" -> ["g", "i"], "ctrl+k" -> ["Ctrl", "K"] for display. */
export function displayKeys(keys: string): string[][] {
  const names: Record<string, string> = {
    Escape: "Esc",
    ArrowDown: "↓",
    ArrowUp: "↑",
    ArrowLeft: "←",
    ArrowRight: "→",
    PageUp: "PgUp",
    PageDown: "PgDn",
    Enter: "Enter",
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
    Space: "Space",
  };
  if (!keys) return [];
  return keys.split(" ").map((step) => step.split("+").map((k) => names[k] ?? k));
}
