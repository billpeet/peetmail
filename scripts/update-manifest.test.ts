import { describe, expect, it } from "vitest";
import { manifest } from "./update-manifest.ts";

const exe = "https://github.com/o/r/releases/download/canary-v0.2.1-canary.42/PeetMail_0.2.1-canary.42_x64-setup.exe";
const appImage = "https://github.com/o/r/releases/download/canary-v0.2.1-canary.42/PeetMail_0.2.1-canary.42_amd64.AppImage";

describe("update manifest", () => {
  it("has the shape Tauri's updater reads, for Windows and Linux", () => {
    const m = manifest({
      version: "0.2.1-canary.42",
      windows: { url: exe, signature: "c2lnbmF0dXJl\n" },
      linux: { url: appImage, signature: "bGludXg=\n" },
      notes: "Fix search",
      pubDate: new Date("2026-10-27T01:02:03Z"),
    });
    expect(m).toEqual({
      version: "0.2.1-canary.42",
      notes: "Fix search",
      pub_date: "2026-10-27T01:02:03.000Z",
      platforms: {
        "windows-x86_64": { signature: "c2lnbmF0dXJl", url: exe },
        // The bundle-specific key first in the updater's lookup, the plain one as fallback.
        "linux-x86_64-appimage": { signature: "bGludXg=", url: appImage },
        "linux-x86_64": { signature: "bGludXg=", url: appImage },
      },
    });
  });

  it("takes one platform on its own", () => {
    expect(Object.keys(manifest({ version: "0.2.1", windows: { url: exe, signature: "s" } }).platforms)).toEqual(["windows-x86_64"]);
    expect(Object.keys(manifest({ version: "0.2.1", linux: { url: appImage, signature: "s" } }).platforms).sort()).toEqual([
      "linux-x86_64",
      "linux-x86_64-appimage",
    ]);
  });

  it("refuses a missing signature, a bad version or no platform", () => {
    const windows = { url: "https://x/y.exe", signature: "sig" };
    expect(() => manifest({ version: "0.2.1", windows: { ...windows, signature: " \n" } })).toThrow(/signature/);
    expect(() => manifest({ version: "0.2.1", linux: { url: "file:///x", signature: "s" } })).toThrow(/URL/);
    expect(() => manifest({ version: "v0.2.1", windows })).toThrow(/semver/);
    expect(() => manifest({ version: "0.2.1" })).toThrow(/no platforms/);
  });
});
