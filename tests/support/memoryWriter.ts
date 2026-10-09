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
  /**
   * Its connection closes before it answers: the event fails with a `NetworkError`, as the app's
   * writer does (`writerFor`, src/nostr/relayReader.ts). Default: it stays open.
   */
  closes?: boolean;
  /**
   * How it answers the first events it is sent, one each, in order, as each of these says: a relay
   * that fails a try and takes the next. Once they run out, it answers as the rest of `opts` says.
   */
  answers?: readonly Omit<MemoryWriterOptions, "answers" | "into">[];
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
 * true`), refuses it, never answers, or loses its connection, at once or later, as `opts` says (or,
 * for the first events, `opts.answers`). It never opens a socket.
 */
export function createMemoryWriter(opts: MemoryWriterOptions = {}): MemoryWriter {
  const published: NostrEvent[] = [];
  const signals: AbortSignal[] = [];
  return {
    published,
    signals,
    async publish(event, signal) {
      signal.throwIfAborted();
      const answer = opts.answers?.[published.length] ?? opts;
      published.push(event);
      signals.push(signal);
      if (answer.silent) await orAbort(new Promise<never>(() => {}), signal);
      if (answer.until !== undefined) await orAbort(answer.until, signal);
      if (answer.delayMs !== undefined) {
        const ms = answer.delayMs;
        await orAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal);
      }
      if (answer.closes) throw new DOMException("The connection closed before the relay answered", "NetworkError");
      if (answer.refuse !== undefined) throw new Error(answer.refuse);
      opts.into?.push(event);
    },
  };
}
