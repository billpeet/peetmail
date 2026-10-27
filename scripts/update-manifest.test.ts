import { describe, expect, it } from "vitest";
import { manifest } from "./update-manifest.ts";

describe("update manifest", () => {
  it("has the shape Tauri's updater reads for Windows x64", () => {
    const m = manifest({
      version: "0.2.1-canary.42",
      url: "https://github.com/o/r/releases/download/canary-v0.2.1-canary.42/PeetMail_0.2.1-canary.42_x64-setup.exe",
      signature: "c2lnbmF0dXJl\n",
      notes: "Fix search",
      pubDate: new Date("2026-10-27T01:02:03Z"),
    });
    expect(m).toEqual({
      version: "0.2.1-canary.42",
      notes: "Fix search",
      pub_date: "2026-10-27T01:02:03.000Z",
      platforms: {
        "windows-x86_64": {
          signature: "c2lnbmF0dXJl",
          url: "https://github.com/o/r/releases/download/canary-v0.2.1-canary.42/PeetMail_0.2.1-canary.42_x64-setup.exe",
        },
      },
    });
  });

  it("refuses a missing signature or a bad version", () => {
    const base = { version: "0.2.1", url: "https://x/y.exe", signature: "sig" };
    expect(() => manifest({ ...base, signature: " \n" })).toThrow(/signature/);
    expect(() => manifest({ ...base, version: "v0.2.1" })).toThrow(/semver/);
  });
});
