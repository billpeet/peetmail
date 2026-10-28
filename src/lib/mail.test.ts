import { describe, expect, it, vi } from "vitest";

// The list query is held open so the test can move the selection while it's in flight.
let resolveRows: (rows: unknown[]) => void = () => {};
const removed: number[] = [];
vi.mock("./api", () => ({
  api: {
    listSplits: () => Promise.resolve([]),
    listThreads: () => new Promise((r) => (resolveRows = r)),
    recentOpens: () => Promise.resolve([]),
    removeDraftFiles: (ids: number[]) => (removed.push(...ids), Promise.resolve()),
    sendMessage: () => Promise.resolve({ id: 1, sendAt: new Date().toISOString(), scheduled: false }),
    scheduledSends: () => Promise.resolve([]),
  },
}));
vi.mock("./bodies", () => ({ prefetchBody: () => Promise.resolve() }));
vi.mock("./calendar.svelte", () => ({ calendar: { refresh: () => Promise.resolve() } }));
vi.mock("./accounts.svelte", () => ({ visibility: { among: () => [] } }));

const { mail } = await import("./mail.svelte");

const row = (id: string) => ({ accountId: 1, conversationId: id, sortAt: "2026-10-28T00:00:00Z", messageId: 1 }) as never;

describe("list refresh", () => {
  it("keeps a selection moved while the refresh was in flight", async () => {
    mail.boot = { accounts: [{ id: 1, provider: "microsoft", email: "a@b.c", displayName: null, signedIn: true }], preferences: {} } as never;
    mail.threads = [row("a"), row("b"), row("c"), row("d")];
    mail.selected = 0;

    // A background sync refreshes the list...
    const done = mail.refresh();
    // ...while j j moves the cursor to "c".
    mail.selected = 2;
    // New mail arrived at the top, so "c" is now one row further down.
    resolveRows([row("new"), row("a"), row("b"), row("c"), row("d")]);
    await done;

    expect(mail.current?.conversationId).toBe("c");
  });
});

describe("composer files", () => {
  const file = (id: number) => ({ id, name: `f${id}.txt`, mime: "text/plain", size: 1 });
  const composer = (ids: number[]) => ({
    accountId: 1, kind: "new" as const, referenceMessageId: null, conversationId: null,
    to: "p@x.com", cc: "", subject: "", body: "", attachments: ids.map(file), droppedAttachments: [],
  });

  it("closing or replacing the composer throws its files away", () => {
    removed.length = 0;
    mail.composer = composer([1, 2]);
    mail.composer = null;
    expect(removed).toEqual([1, 2]);
    mail.composer = composer([3]);
    mail.composer = composer([4]);
    expect(removed).toEqual([1, 2, 3]);
    mail.composer = null;
  });

  it("sending hands the files to the outbox instead", async () => {
    mail.composer = composer([5]);
    removed.length = 0;
    await mail.send();
    expect(mail.composer).toBeNull();
    expect(removed).toEqual([]);
  });
});
