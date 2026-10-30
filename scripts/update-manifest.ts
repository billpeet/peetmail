// Writes the updater manifest (latest.json) that the app reads from a release. The fake
// update server in tests/harness serves the same shape through `manifest()`.
//
//   node scripts/update-manifest.ts --version 0.2.1 \
//     --windows-url <setup.exe url> --windows-sig <setup.exe.sig file> \
//     --linux-url <AppImage url> --linux-sig <AppImage.sig file> \
//     [--notes <text>] --out latest.json
//
// Either platform may be left out (a build that only made one), but not both.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Artifact = {
  /** Download URL of the installer (NSIS setup exe) or the AppImage. */
  url: string;
  /** Contents of its .sig file (base64 minisign signature, from `tauri build`). */
  signature: string;
};

export type ManifestInput = {
  version: string;
  windows?: Artifact;
  linux?: Artifact;
  notes?: string;
  pubDate?: Date;
};

/**
 * Tauri's static update manifest. The updater looks up `{os}-{arch}-{bundle}` first, then
 * `{os}-{arch}`. Linux lists the AppImage under both: `linux-x86_64-appimage` for builds
 * that know their bundle type, `linux-x86_64` as the fallback. (The app only checks for
 * updates when it runs as an AppImage, so a distro package never gets offered one.)
 */
export function manifest({ version, windows, linux, notes = "", pubDate = new Date() }: ManifestInput) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`"${version}" isn't a semver version`);
  const entry = ({ url, signature }: Artifact) => {
    if (!/^https?:\/\//.test(url)) throw new Error(`"${url}" isn't a URL`);
    if (!signature.trim()) throw new Error(`empty signature for ${url}`);
    return { signature: signature.trim(), url };
  };
  const platforms: Record<string, { signature: string; url: string }> = {};
  if (windows) platforms["windows-x86_64"] = entry(windows);
  if (linux) platforms["linux-x86_64-appimage"] = platforms["linux-x86_64"] = entry(linux);
  if (!Object.keys(platforms).length) throw new Error("no platforms: give a Windows installer, a Linux AppImage or both");
  return { version, notes, pub_date: pubDate.toISOString(), platforms };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const need = (name: string) => arg(name) ?? (console.error(`missing --${name}`), process.exit(2));
  const artifact = (os: string): Artifact | undefined => {
    const url = arg(`${os}-url`);
    return url ? { url, signature: readFileSync(need(`${os}-sig`), "utf8") } : undefined;
  };
  const out = manifest({ version: need("version"), windows: artifact("windows"), linux: artifact("linux"), notes: arg("notes") });
  writeFileSync(need("out"), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${arg("out")} for ${out.version}: ${Object.keys(out.platforms).join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
