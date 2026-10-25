/** Returned by a superseded call of a `latestOnly` function. */
export const STALE: unique symbol = Symbol("stale");

/**
 * Wraps an async function so only the most recent call's result counts. Earlier calls
 * that finish later resolve to `STALE`, so out-of-order replies (a slow lookup for "p"
 * landing after the one for "priya") can't overwrite newer results. `cancel()` makes
 * every in-flight call stale.
 */
export function latestOnly<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  let seq = 0;
  const call = async (...args: A): Promise<R | typeof STALE> => {
    const mine = ++seq;
    const result = await fn(...args);
    return mine === seq ? result : STALE;
  };
  call.cancel = () => {
    seq++;
  };
  return call;
}
