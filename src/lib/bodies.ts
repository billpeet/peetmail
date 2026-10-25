// In-memory LRU of message bodies in front of the Rust/SQLite cache, so j/k
// over recently seen mail never crosses IPC. Promises dedupe concurrent requests;
// resolved bodies can also be read synchronously so a cached message renders in
// the same frame it's opened.
import { api } from "./api";

const MAX_ENTRIES = 64;
const pending = new Map<number, Promise<string>>();
const resolved = new Map<number, string>();

function touch<V>(map: Map<number, V>, key: number, value: V) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

export function getBody(messageId: number): Promise<string> {
  const done = resolved.get(messageId);
  if (done !== undefined) {
    touch(resolved, messageId, done);
    return Promise.resolve(done);
  }
  const inflight = pending.get(messageId);
  if (inflight) return inflight;
  const p = api.getMessageBody(messageId).then(
    (html) => {
      pending.delete(messageId);
      touch(resolved, messageId, html);
      return html;
    },
    (e) => {
      pending.delete(messageId);
      throw e;
    },
  );
  pending.set(messageId, p);
  return p;
}

/** The body if it's already in memory, without waiting. */
export function peekBody(messageId: number): string | undefined {
  return resolved.get(messageId);
}

export function prefetchBody(messageId: number) {
  getBody(messageId).catch(() => {});
}
