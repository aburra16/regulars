import type { NostrEvent } from "@nostrify/nostrify";

import type { RelayWriter } from "../../src/nostr/events.ts";

export interface MemoryWriterOptions {
  /** Refuses every event with this reason, as a relay's `OK false` does. Default: it takes them. */
  refuse?: string;
  /** Never answers: the event waits until its signal aborts. */
  silent?: boolean;
  /** Where an event it takes is kept, so a reader over the same array sends it back. Default: nowhere (a relay that lags). */
  into?: NostrEvent[];
}

/** A `RelayWriter` that keeps every event it was sent, and every signal it was sent with. */
export interface MemoryWriter extends RelayWriter {
  readonly published: NostrEvent[];
  readonly signals: AbortSignal[];
}

/**
 * A stand-in for a relay that is sent reviews, held in memory, for tests: it takes each event (`OK
 * true`), refuses it, or never answers, as `opts` says. It never opens a socket.
 */
export function createMemoryWriter(opts: MemoryWriterOptions = {}): MemoryWriter {
  const published: NostrEvent[] = [];
  const signals: AbortSignal[] = [];
  return {
    published,
    signals,
    async publish(event, signal) {
      signal.throwIfAborted();
      published.push(event);
      signals.push(signal);
      if (opts.silent) {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (opts.refuse !== undefined) throw new Error(opts.refuse);
      opts.into?.push(event);
    },
  };
}
