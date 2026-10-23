// In-memory LRU of message bodies in front of the Rust/SQLite cache, so j/k
// over recently seen mail never crosses IPC. Promises dedupe concurrent requests.
import { api } from "./api";

const MAX_ENTRIES = 64;
const cache = new Map<number, Promise<string>>();

export function getBody(messageId: number): Promise<string> {
  const hit = cache.get(messageId);
  if (hit) {
    cache.delete(messageId);
    cache.set(messageId, hit);
    return hit;
  }
  const p = api.getMessageBody(messageId);
  cache.set(messageId, p);
  p.catch(() => cache.delete(messageId));
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return p;
}

export function prefetchBody(messageId: number) {
  getBody(messageId).catch(() => {});
}
