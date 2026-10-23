import { ensureBuilt } from "../harness/app.ts";

// Rebuilds the debug binary only when sources are newer than it.
export default function globalSetup() {
  ensureBuilt();
}
