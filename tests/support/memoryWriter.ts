import type { NostrEvent } from "@nostrify/nostrify";

import type { RelayWriter } from "../../src/nostr/events.ts";

export interface MemoryWriterOptions {
  /** Refuses every event with this reason, as a relay's `OK false` does. Default: it takes them. */
  refuse?: string;
  /** Never answers: the event waits until its signal aborts. */
  silent?: boolean;
  /** Where an event it takes is kept, so a reader over the same array sends it back. Default: nowhere (a relay that lags). */
  into?: NostrEvent[];
  /** Answers only after this many milliseconds (fake timers move them). Default: at once. */
  delayMs?: number;
  /** Answers only once this settles: a relay slower than the others, for as long as the test likes. */
  until?: Promise<unknown>;
}

/** `promise`, or the signal's reason as soon as it aborts. */
function orAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A `RelayWriter` that keeps every event it was sent, and every signal it was sent with. */
export interface MemoryWriter extends RelayWriter {
  readonly published: NostrEvent[];
  readonly signals: AbortSignal[];
}

/**
 * A stand-in for a relay that is sent reviews, held in memory, for tests: it takes each event (`OK
 * true`), refuses it, or never answers, at once or later, as `opts` says. It never opens a socket.
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
      if (opts.silent) await orAbort(new Promise<never>(() => {}), signal);
      if (opts.until !== undefined) await orAbort(opts.until, signal);
      if (opts.delayMs !== undefined) {
        const ms = opts.delayMs;
        await orAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal);
      }
      if (opts.refuse !== undefined) throw new Error(opts.refuse);
      opts.into?.push(event);
    },
  };
}
