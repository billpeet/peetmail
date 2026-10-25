// Guards readability: every text colour must contrast with every surface it's used on.
// Values are read from src/app.css, so a palette tweak that hurts legibility fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const color = (name: string) => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`--color-${name} not found in app.css`);
  return m[1];
};

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const surfaces = ["chrome", "ink-950", "ink-900", "ink-800"];

describe("theme contrast", () => {
  // WCAG: 4.5 is AA for body text, 7 is AAA.
  const minimums: Record<string, number> = { "ink-500": 4.5, "ink-300": 7, "ink-100": 10, accent: 4.5 };
  for (const [text, min] of Object.entries(minimums)) {
    for (const surface of surfaces) {
      it(`${text} on ${surface} is at least ${min}:1`, () => {
        expect(contrast(color(text), color(surface))).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("the old palette's secondary text would fail (the reported problem)", () => {
    expect(contrast("#6b6b78", "#0e0e11")).toBeLessThan(4.5);
  });
});
