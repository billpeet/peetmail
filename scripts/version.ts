// The app version lives in package.json. tauri.conf.json reads it from there; Cargo.toml and
// Cargo.lock carry a copy (cargo can't read it from anywhere else), kept in step by this script.
//
//   node scripts/version.ts check               all copies agree (CI runs this)
//   node scripts/version.ts check --tag v1.2.3  ...and match the release tag
//   node scripts/version.ts set 1.2.3           write the version everywhere

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The contents of the four files that carry the version. */
export type Texts = { packageJson: string; tauriConf: string; cargoToml: string; cargoLock: string };

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// The first `version = ` in Cargo.toml after [package]; in Cargo.lock, the one after our crate's name.
const CARGO_TOML = /^(\[package\][\s\S]*?^version = ")([^"]+)(")/m;
const CARGO_LOCK = /^(name = "peetmail"\r?\nversion = ")([^"]+)(")/m;
const PACKAGE_JSON = /("version":\s*")([^"]+)(")/;

export function problems(t: Texts, tag?: string): string[] {
  const want: string = JSON.parse(t.packageJson).version;
  const tauri = JSON.parse(t.tauriConf).version;
  const out: string[] = [];
  if (!SEMVER.test(want)) out.push(`package.json version "${want}" isn't semver`);
  if (tauri !== "../package.json") out.push(`tauri.conf.json version is "${tauri}", should be "../package.json"`);
  for (const [name, text, re] of [["Cargo.toml", t.cargoToml, CARGO_TOML], ["Cargo.lock", t.cargoLock, CARGO_LOCK]] as const) {
    const got = text.match(re)?.[2] ?? "(not found)";
    if (got !== want) out.push(`${name} has ${got}, package.json has ${want}`);
  }
  if (tag !== undefined && tag !== `v${want}`) out.push(`tag "${tag}" doesn't match version ${want} (expected v${want})`);
  return out;
}

export function withVersion(t: Texts, version: string): Texts {
  if (!SEMVER.test(version)) throw new Error(`"${version}" isn't a semver version like 1.2.3 or 1.3.0-beta.1`);
  const swap = (text: string, re: RegExp, file: string) => {
    if (!re.test(text)) throw new Error(`no version found in ${file}`);
    return text.replace(re, `$1${version}$3`);
  };
  return {
    ...t,
    packageJson: swap(t.packageJson, PACKAGE_JSON, "package.json"),
    cargoToml: swap(t.cargoToml, CARGO_TOML, "Cargo.toml"),
    cargoLock: swap(t.cargoLock, CARGO_LOCK, "Cargo.lock"),
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const paths: Texts = {
    packageJson: join(root, "package.json"),
    tauriConf: join(root, "src-tauri/tauri.conf.json"),
    cargoToml: join(root, "src-tauri/Cargo.toml"),
    cargoLock: join(root, "src-tauri/Cargo.lock"),
  };
  const keys = Object.keys(paths) as (keyof Texts)[];
  const texts = Object.fromEntries(keys.map((k) => [k, readFileSync(paths[k], "utf8")])) as Texts;

  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "check") {
    const tagAt = args.indexOf("--tag");
    const found = problems(texts, tagAt >= 0 ? (args[tagAt + 1] ?? "") : undefined);
    if (found.length) {
      for (const p of found) console.error(`version mismatch: ${p}`);
      console.error("Fix with: pnpm version:set <version>");
      process.exit(1);
    }
    console.log(`version ${JSON.parse(texts.packageJson).version} is consistent`);
  } else if (cmd === "set" && args[0]) {
    const next = withVersion(texts, args[0]);
    for (const k of keys) if (next[k] !== texts[k]) writeFileSync(paths[k], next[k]);
    console.log(`version set to ${args[0]}`);
  } else {
    console.error("usage: node scripts/version.ts check [--tag vX.Y.Z] | set <version>");
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
