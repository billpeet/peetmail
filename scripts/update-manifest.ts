// Writes the updater manifest (latest.json) that the app reads from a release. The fake
// update server in tests/harness serves the same shape through `manifest()`.
//
//   node scripts/update-manifest.ts --version 0.2.1 --url <installer url> --sig <installer .sig file> [--notes <text>] --out latest.json

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ManifestInput = {
  version: string;
  /** Download URL of the NSIS installer. */
  url: string;
  /** Contents of the installer's .sig file (base64 minisign signature, from `tauri build`). */
  signature: string;
  notes?: string;
  pubDate?: Date;
};

/** Tauri's static update manifest, Windows x64 only. */
export function manifest({ version, url, signature, notes = "", pubDate = new Date() }: ManifestInput) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`"${version}" isn't a semver version`);
  if (!/^https?:\/\//.test(url)) throw new Error(`"${url}" isn't a URL`);
  if (!signature.trim()) throw new Error("empty signature");
  return {
    version,
    notes,
    pub_date: pubDate.toISOString(),
    platforms: { "windows-x86_64": { signature: signature.trim(), url } },
  };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const need = (name: string) => arg(name) ?? (console.error(`missing --${name}`), process.exit(2));
  const out = manifest({ version: need("version"), url: need("url"), signature: readFileSync(need("sig"), "utf8"), notes: arg("notes") });
  writeFileSync(need("out"), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${arg("out")} for ${out.version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
