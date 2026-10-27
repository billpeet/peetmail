import { ensureBuilt, sweepStaleDataDirs } from "../harness/app.ts";

// Rebuilds the debug binary only when sources are newer than it, and clears temp data
// dirs that earlier (crashed or interrupted) runs left behind.
export default async function globalSetup() {
  ensureBuilt();
  const swept = await sweepStaleDataDirs();
  if (swept) console.log(`removed ${swept} leftover test data dir(s)`);
}
