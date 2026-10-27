import { describe, expect, it } from "vitest";
import { readIco, replaceSizes, writeIco } from "./ico.ts";

const img = (size: number, tag: string) => ({ size, data: Buffer.from(`png-${tag}-${size}`) });

describe("ico", () => {
  it("round-trips images, smallest first, with 256 stored as 0", () => {
    const buf = writeIco([img(256, "a"), img(16, "a"), img(48, "a")]);
    expect(buf[6]).toBe(16);
    expect(buf[6 + 32]).toBe(0); // the 256 entry
    expect(readIco(buf).map((i) => [i.size, i.data.toString()])).toEqual([
      [16, "png-a-16"],
      [48, "png-a-48"],
      [256, "png-a-256"],
    ]);
  });

  it("swaps in hand-tuned sizes and adds missing ones", () => {
    const merged = replaceSizes([img(16, "gen"), img(32, "gen"), img(256, "gen")], [img(16, "hand"), img(24, "hand")]);
    expect(merged.map((i) => i.data.toString())).toEqual(["png-hand-16", "png-hand-24", "png-gen-32", "png-gen-256"]);
  });

  it("refuses something that isn't an ICO", () => {
    expect(() => readIco(Buffer.from("not an icon at all"))).toThrow(/ICO/);
  });
});
