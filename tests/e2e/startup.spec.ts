import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXE, ROOT, TEMP_PREFIX, freePort, removeDataDir, testEnv } from "../harness/app.ts";

const userVersion = (path: string) => {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

test("a database from a newer PeetMail stops startup with a reason, and is left alone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const dbPath = join(dataDir, "peetmail.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 999");
    db.close();

    // No server is contacted before the database opens, so the endpoints can point nowhere.
    const fake = { graphUrl: "http://127.0.0.1:9/v1.0", authorityUrl: "http://127.0.0.1:9/oauth" };
    const env = { ...process.env, ...testEnv({ fake, dataDir, cdpPort: await freePort() }) };
    const proc = spawn(EXE, [], { cwd: ROOT, env, stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));

    expect(code).toBe(1);
    const log = await readFile(join(dataDir, "logs", "PeetMail.log"), "utf8");
    expect(log).toContain("cannot start: This mailbox cache was written by a newer version of PeetMail");
    expect(userVersion(dbPath)).toBe(999);
  } finally {
    await removeDataDir(dataDir);
  }
});
