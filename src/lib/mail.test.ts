import { describe, expect, it, vi } from "vitest";

// The list query is held open so the test can move the selection while it's in flight.
let resolveRows: (rows: unknown[]) => void = () => {};
const removed: number[] = [];
const saved: { id: number | null; draft: Record<string, unknown> & { body: string } }[] = [];
const deleted: number[] = [];
const sentInputs: { draftId?: number | null }[] = [];
vi.mock("./api", () => ({
  api: {
    listSplits: () => Promise.resolve([]),
    listThreads: () => new Promise((r) => (resolveRows = r)),
    recentOpens: () => Promise.resolve([]),
    removeDraftFiles: (ids: number[]) => (removed.push(...ids), Promise.resolve()),
    sendMessage: (input: { draftId?: number | null }) => (sentInputs.push(input), Promise.resolve({ id: 1, sendAt: new Date().toISOString(), scheduled: false })),
    saveDraft: (id: number | null, _account: number, draft: never) => (saved.push({ id, draft }), Promise.resolve(id ?? 100 + saved.length)),
    deleteDraft: (id: number) => (deleted.push(id), Promise.resolve()),
    listDrafts: () => Promise.resolve([]),
    scheduledSends: () => Promise.resolve([]),
  },
}));
vi.mock("./bodies", () => ({ prefetchBody: () => Promise.resolve() }));
vi.mock("./calendar.svelte", () => ({ calendar: { refresh: () => Promise.resolve() } }));
vi.mock("./accounts.svelte", () => ({ visibility: { among: () => [] } }));

const { mail, worthKeeping, withDraftRows } = await import("./mail.svelte");
type ComposerState = import("./mail.svelte").ComposerState;

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

describe("drafts", () => {
  const file = (id: number) => ({ id, name: `f${id}.txt`, mime: "text/plain", size: 1 });
  const composer = (over: Partial<ComposerState> = {}): ComposerState => ({
    accountId: 1, kind: "new", referenceMessageId: null, conversationId: null,
    to: "", cc: "", bcc: "", subject: "", body: "", html: "", attachments: [], droppedAttachments: [], draftId: null, ...over,
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const reset = () => {
    removed.length = 0;
    saved.length = 0;
    deleted.length = 0;
  };

  it("keeps only what you wrote or attached; a reply's own To and subject don't count", () => {
    expect(worthKeeping(composer())).toBe(false);
    expect(worthKeeping(composer({ subject: "Hi" }))).toBe(true);
    expect(worthKeeping(composer({ kind: "reply", to: "a@b.c", subject: "RE: x" }))).toBe(false);
    expect(worthKeeping(composer({ kind: "reply", body: "ok" }))).toBe(true);
    expect(worthKeeping(composer({ kind: "reply", attachments: [file(1)] }))).toBe(true);
    expect(worthKeeping(composer({ kind: "forward", to: "a@b.c" }))).toBe(true);
  });

  it("closing a composer with something in it saves it as a draft, files and all", async () => {
    reset();
    mail.composer = composer({ to: "p@x.com", body: "half a thought", attachments: [file(1)] });
    mail.composer = null;
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0].draft.body).toBe("half a thought");
    expect(removed).toEqual([]);
  });

  it("closing an empty one leaves nothing behind", async () => {
    reset();
    mail.composer = composer({ kind: "reply", to: "a@b.c", subject: "RE: x" });
    mail.composer = null;
    await settle();
    expect(saved).toEqual([]);
  });

  it("emptied after it was saved, its draft goes", async () => {
    reset();
    mail.composer = composer({ draftId: 9 });
    mail.composer = null;
    await settle();
    expect(deleted).toEqual([9]);
  });

  it("discarding removes the draft and its files", async () => {
    reset();
    mail.composer = composer({ body: "no", draftId: 4, attachments: [file(2)] });
    await mail.discardComposer();
    expect(mail.composer).toBeNull();
    expect(deleted).toEqual([4]);
    expect(removed).toEqual([2]);
    expect(saved).toEqual([]);
  });

  it("sending hands the files to the outbox and removes the draft, without saving it again", async () => {
    reset();
    const c = composer({ to: "p@x.com", body: "go", draftId: 7, attachments: [file(5)] });
    mail.composer = c;
    mail.autosave(mail.composer!);
    await mail.send();
    mail.autosave(c); // a save scheduled before the send fires late
    await settle();
    expect(mail.composer).toBeNull();
    expect(sentInputs.at(-1)?.draftId).toBe(7);
    expect(removed).toEqual([]);
    expect(saved).toEqual([]); // not even the one queued just before: the send removes the draft
  });
});

describe("drafts in the Inbox", () => {
  const conv = (id: string, at: string) => ({ accountId: 1, conversationId: id, sortAt: at, messageId: 1 }) as never;
  const draft = (id: number, at: string, conversationId: string | null = null) =>
    ({ id, accountId: 1, updatedAt: at, draft: { kind: "new", conversationId, to: "p@x.com", bcc: "", subject: `d${id}`, body: "", attachments: [] } }) as never;

  it("puts new drafts among the conversations by time; replies stay with their conversation", () => {
    const rows = withDraftRows(
      [conv("a", "2026-10-29T10:00:00Z"), conv("b", "2026-10-29T08:00:00Z")],
      [draft(1, "2026-10-29T09:00:00.000Z"), draft(2, "2026-10-29T11:00:00.000Z"), draft(3, "2026-10-29T09:30:00Z", "b")],
      true,
    );
    expect(rows.map((r: { conversationId: string }) => r.conversationId)).toEqual(["draft:2", "a", "draft:1", "b"]);
  });

  it("holds back drafts older than what's loaded until the rest loads", () => {
    const rows = withDraftRows([conv("a", "2026-10-29T10:00:00Z")], [draft(1, "2026-10-01T00:00:00Z")], false);
    expect(rows).toHaveLength(1);
  });

  it("re-merging drops the old draft rows first", () => {
    const once = withDraftRows([conv("a", "2026-10-29T10:00:00Z")], [draft(1, "2026-10-29T11:00:00Z")], true);
    expect(withDraftRows(once, [], true).map((r: { conversationId: string }) => r.conversationId)).toEqual(["a"]);
  });
});
