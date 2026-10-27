import { describe, expect, it, vi } from "vitest";

// The store imports the Tauri API and the mail store; neither is reached by these tests.
vi.mock("./api", () => ({ api: {}, onUpdateStatus: () => Promise.resolve(() => {}) }));
vi.mock("./mail.svelte", () => ({ mail: {} }));

const { updateText, updates } = await import("./updates.svelte");
type Status = Parameters<typeof updateText>[0];

const status = (s: Partial<Status>): Status => ({
  seq: 1,
  state: "idle",
  channel: "stable",
  currentVersion: "0.2.0",
  version: null,
  notes: null,
  message: null,
  lastCheck: null,
  ...s,
});

describe("updateText", () => {
  it("says what's happening at each step", () => {
    expect(updateText(status({ state: "disabled" }))).toBe("Updates aren't available in this build.");
    expect(updateText(status({ state: "downloading", version: "0.3.0" }))).toBe("Downloading 0.3.0…");
    expect(updateText(status({ state: "ready", version: "0.3.0" }))).toBe("0.3.0 is ready. Restart to update.");
    expect(updateText(status({ state: "upToDate" }))).toBe("Up to date.");
  });

  it("passes the error through", () => {
    expect(updateText(status({ state: "error", message: "signature mismatch" }))).toBe("Couldn't update: signature mismatch");
  });
});

describe("updates store", () => {
  it("keeps the newest status when an older one arrives late", () => {
    updates.apply(status({ seq: 5, state: "ready", version: "0.3.0" }));
    updates.apply(status({ seq: 3, state: "idle" }));
    expect(updates.status?.state).toBe("ready");
    updates.apply(status({ seq: 6, state: "upToDate" }));
    expect(updates.status?.state).toBe("upToDate");
  });
});
