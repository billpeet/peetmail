// The app version lives in package.json. tauri.conf.json reads it from there; Cargo.toml and
// Cargo.lock carry a copy (cargo can't read it from anywhere else), kept in step by this script.
//
//   node scripts/version.ts check               all copies agree (CI runs this)
//   node scripts/version.ts check --tag v1.2.3  ...and match the release tag
//   node scripts/version.ts set 1.2.3           write the version everywhere; for a release
//                                               (not a canary) also turn CHANGELOG.md's
//                                               Unreleased section into 1.2.3's
//   node scripts/version.ts canary 42           print the canary version for CI run 42
//   node scripts/version.ts notes 1.2.3         print 1.2.3's changelog lines (release notes);
//                                               fails if there are none

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseUnreleased, sectionMarkdown } from "../src/lib/changelog.ts";

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

/**
 * The version of a canary build: the next patch after package.json's version, as a
 * pre-release numbered by the CI run (0.2.0 -> 0.2.1-canary.42). It sorts above the last
 * stable release and below the next one, and run numbers only grow, so every canary is
 * newer than the one before. A package.json pre-release (0.3.0-beta.1) is already ahead
 * of the last stable, so its core is kept (0.3.0-canary.42).
 */
export function canaryVersion(base: string, run: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(base);
  if (!m) throw new Error(`"${base}" isn't a semver version`);
  if (!Number.isInteger(run) || run < 1) throw new Error(`run number must be a positive integer, got ${run}`);
  const [major, minor, patch] = [m[1], m[2], Number(m[3])];
  return `${major}.${minor}.${m[4] ? patch : patch + 1}-canary.${run}`;
}

/**
 * CHANGELOG.md for a new version: a release takes over the Unreleased lines; a canary
 * build (CI sets one on every push) leaves the changelog alone.
 */
export function changelogFor(md: string, version: string, date: string): string {
  return version.includes("-canary.") ? md : releaseUnreleased(md, version, date);
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
    const changelogPath = join(root, "CHANGELOG.md");
    const changelog = readFileSync(changelogPath, "utf8");
    const nextChangelog = changelogFor(changelog, args[0], new Date().toISOString().slice(0, 10));
    for (const k of keys) if (next[k] !== texts[k]) writeFileSync(paths[k], next[k]);
    if (nextChangelog !== changelog) writeFileSync(changelogPath, nextChangelog);
    console.log(`version set to ${args[0]}${nextChangelog !== changelog ? "; CHANGELOG.md's Unreleased lines are now its section" : ""}`);
  } else if (cmd === "notes" && args[0]) {
    const notes = sectionMarkdown(readFileSync(join(root, "CHANGELOG.md"), "utf8"), args[0]);
    if (!notes) {
      console.error(`CHANGELOG.md has no lines for ${args[0]}. Run \`pnpm version:set ${args[0]}\` before tagging.`);
      process.exit(1);
    }
    console.log(notes);
  } else if (cmd === "canary" && args[0]) {
    console.log(canaryVersion(JSON.parse(texts.packageJson).version, Number(args[0])));
  } else {
    console.error("usage: node scripts/version.ts check [--tag vX.Y.Z] | set <version> | canary <run number> | notes <version>");
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
