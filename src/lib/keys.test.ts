import { describe, expect, it, vi } from "vitest";
import { displayKeys, keymap, normalizeKey } from "./keys.svelte";

const ev = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "metaKey" | "shiftKey", boolean>> = {}, target: unknown = null) =>
  ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, target, preventDefault: vi.fn(), ...mods }) as unknown as KeyboardEvent;

describe("normalizeKey", () => {
  it("keeps printable keys as typed, including shifted ones", () => {
    expect(normalizeKey(ev("j"))).toBe("j");
    expect(normalizeKey(ev("G", { shiftKey: true }))).toBe("G");
    expect(normalizeKey(ev("?", { shiftKey: true }))).toBe("?");
  });
  it("prefixes modifiers and lowercases chord letters", () => {
    expect(normalizeKey(ev("R", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+r");
    expect(normalizeKey(ev(",", { ctrlKey: true }))).toBe("ctrl+,");
    expect(normalizeKey(ev("Tab", { shiftKey: true }))).toBe("shift+Tab");
  });
  it("ignores bare modifier presses", () => {
    expect(normalizeKey(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(normalizeKey(ev("Control", { ctrlKey: true }))).toBeNull();
  });
});

describe("keymap", () => {
  it("runs single keys and two-key sequences, honouring `when`", () => {
    const calls: string[] = [];
    let enabled = true;
    const off = keymap.register([
      { id: "t.j", keys: "j", label: "", group: "t", run: () => calls.push("j") },
      { id: "t.gi", keys: "g i", label: "", group: "t", run: () => calls.push("g i") },
      { id: "t.x", keys: "x", label: "", group: "t", when: () => enabled, run: () => calls.push("x") },
    ]);
    keymap.handle(ev("j"));
    keymap.handle(ev("g"));
    expect(keymap.pending).toEqual(["g"]);
    keymap.handle(ev("i"));
    enabled = false;
    keymap.handle(ev("x"));
    expect(calls).toEqual(["j", "g i"]);
    off();
    keymap.handle(ev("j"));
    expect(calls).toEqual(["j", "g i"]);
  });

  it("restarts a dead sequence with the current key", () => {
    const calls: string[] = [];
    const off = keymap.register([
      { id: "t.gi", keys: "g i", label: "", group: "t", run: () => calls.push("g i") },
      { id: "t.j", keys: "j", label: "", group: "t", run: () => calls.push("j") },
    ]);
    keymap.handle(ev("g"));
    keymap.handle(ev("j"));
    expect(calls).toEqual(["j"]);
    expect(keymap.pending).toEqual([]);
    off();
  });

  it("ignores plain keys while typing in a text field but still handles Escape", () => {
    const calls: string[] = [];
    const off = keymap.register([
      { id: "t.j", keys: "j", label: "", group: "t", run: () => calls.push("j") },
      { id: "t.esc", keys: "Escape", label: "", group: "t", run: () => calls.push("esc") },
    ]);
    // Minimal stand-in for an <input>: the registry checks `instanceof Element`.
    class FakeElement {
      tagName = "INPUT";
      isContentEditable = false;
    }
    vi.stubGlobal("Element", FakeElement);
    const input = new FakeElement();
    keymap.handle(ev("j", {}, input));
    keymap.handle(ev("Escape", {}, input));
    vi.unstubAllGlobals();
    expect(calls).toEqual(["esc"]);
    off();
  });
});

describe("displayKeys", () => {
  it("splits sequences and chords for the help overlay", () => {
    expect(displayKeys("g i")).toEqual([["g"], ["i"]]);
    expect(displayKeys("ctrl+r")).toEqual([["Ctrl", "r"]]);
    expect(displayKeys("Escape")).toEqual([["Esc"]]);
  });
});
