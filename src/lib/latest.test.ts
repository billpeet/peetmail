import { describe, expect, it } from "vitest";
import { latestOnly, STALE } from "./latest";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("latestOnly", () => {
  it("drops replies that arrive after a newer call", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string[]>>>();
    const lookup = latestOnly((prefix: string) => {
      const d = deferred<string[]>();
      pending.set(prefix, d);
      return d.promise;
    });

    const p = lookup("p");
    const priya = lookup("priya");
    // The newer lookup answers first, the older one last (the composer race).
    pending.get("priya")!.resolve(["priya@fabrikam.io"]);
    pending.get("p")!.resolve(["receipts@stripe.com", "priya@fabrikam.io"]);

    expect(await priya).toEqual(["priya@fabrikam.io"]);
    expect(await p).toBe(STALE);
  });

  it("cancel() makes in-flight calls stale", async () => {
    const d = deferred<number>();
    const f = latestOnly(() => d.promise);
    const call = f();
    f.cancel();
    d.resolve(1);
    expect(await call).toBe(STALE);
  });
});
