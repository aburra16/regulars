import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { matchFilter } from "nostr-tools/filter";

import type { RelayReader } from "../../src/places/load.ts";

export interface MemoryReaderOptions {
  /** Every request fails with this error, after the delay. */
  failWith?: Error;
  /** How long each request waits before it answers, in milliseconds. */
  delayMs?: number;
}

/** A `RelayReader` that also keeps every filter it was sent, in order. */
export interface MemoryReader extends RelayReader {
  readonly requests: NostrFilter[];
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Newest first; events from the same second in id order, so every answer is the same. */
const newestFirst = (a: NostrEvent, b: NostrEvent) =>
  b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A stand-in for the places relay, over events held in memory, for tests. It answers each
 * request the way a relay does: the events that match the filter (`until` included), newest
 * first, at most `limit` of them, and then it ends. It never opens a socket.
 */
export function createMemoryReader(events: NostrEvent[], opts: MemoryReaderOptions = {}): MemoryReader {
  const requests: NostrFilter[] = [];
  return {
    requests,
    async *req(filter, signal) {
      requests.push(filter);
      signal.throwIfAborted();
      if (opts.delayMs !== undefined) await wait(opts.delayMs, signal);
      if (opts.failWith) throw opts.failWith;
      const page = events
        .filter((ev) => matchFilter(filter, ev))
        .sort(newestFirst)
        .slice(0, filter.limit ?? events.length);
      for (const ev of page) {
        signal.throwIfAborted();
        yield ev;
      }
    },
  };
}
