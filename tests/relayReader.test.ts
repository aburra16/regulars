import type { NostrEvent, NRelay1Opts } from "@nostrify/nostrify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import type { ReadOptions, RelayReader } from "../src/nostr/events";
import { appReaders } from "../src/nostr/relayCode";
import { CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS, readerFor, TOTAL_TIMEOUT_MS, writerFor } from "../src/nostr/relayReader";
import { relayReader } from "../src/places/relayReader";

// A stand-in for Nostrify's relay, with no socket: the test plays the relay's part, message by
// message, and the reader's limits run on fake timers.
const fake = vi.hoisted(() => ({
  relays: [] as {
    url: string;
    opts: unknown;
    send(msg: unknown[]): void;
    drop(type: "close" | "error"): void;
    closed: boolean;
    published: unknown[];
  }[],
}));

vi.mock("@nostrify/nostrify", () => {
  class NRelay1 {
    private queue: unknown[][] = [];
    private wake: (() => void) | undefined;
    closed = false;
    /** The events sent to it, in order. */
    readonly published: unknown[] = [];
    /** Its connection, as websocket-ts holds it: the browser's socket underneath is what says it closed. */
    readonly socket = { underlyingWebsocket: new EventTarget() };

    constructor(
      readonly url: string,
      readonly opts: unknown,
    ) {
      fake.relays.push(this);
    }

    /** The relay sends a message, which goes through `receive` as a real one does. */
    send(msg: unknown[]): void {
      this.receive(msg);
    }

    /**
     * The connection closes, or fails, as the browser's socket says. NRelay1 neither says so to an
     * event waiting for its OK nor sends it again: the event waits until its signal aborts.
     */
    drop(type: "close" | "error"): void {
      this.socket.underlyingWebsocket.dispatchEvent(new Event(type));
    }

    protected receive(msg: unknown[]): void {
      this.queue.push(msg);
      this.wake?.();
    }

    /** The request's messages as they come. Aborted, it ends with a bare AbortError, as NRelay1 does. */
    async *req(_filters: unknown, { signal }: { signal: AbortSignal }): AsyncGenerator<unknown[]> {
      while (true) {
        if (signal.aborted) throw new DOMException("The request was aborted", "AbortError");
        const next = this.queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    }

    /**
     * Sends an event, and waits for the relay's OK about it: resolves when it takes it, throws its
     * reason when it refuses. Aborted, it ends with a bare AbortError, as NRelay1 does.
     */
    async event(ev: { id: string }, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
      this.published.push(ev);
      while (true) {
        if (signal?.aborted) throw new DOMException("The signal has been aborted", "AbortError");
        const at = this.queue.findIndex((msg) => msg[0] === "OK" && msg[1] === ev.id);
        if (at >= 0) {
          const [, , ok, reason] = this.queue.splice(at, 1)[0]!;
          if (!ok) throw new Error(String(reason));
          return;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  }
  return { NRelay1 };
});

const SECOND = 1000;
const event = (n: number) => ({ id: String(n) });

/**
 * Starts a read by `reader` (the places reader unless given), made as `opts` says when it says
 * anything, and how it ended once it has: the events it gave, or the error it threw.
 */
async function startRead({
  signal = new AbortController().signal,
  reader = relayReader,
  opts,
}: { signal?: AbortSignal; reader?: RelayReader; opts?: ReadOptions } = {}) {
  const events: unknown[] = [];
  let outcome: { done: true } | { error: unknown } | undefined;
  void (async () => {
    try {
      const reading = opts === undefined ? reader.req({ kinds: [39999] }, signal) : reader.req({ kinds: [39999] }, signal, opts);
      for await (const value of reading) events.push(value);
      outcome = { done: true };
    } catch (error) {
      outcome = { error };
    }
  })();
  // The reader makes its relay as it starts.
  await vi.advanceTimersByTimeAsync(0);
  const relay = fake.relays.at(-1)!;
  return {
    relay,
    events,
    get outcome() {
      return outcome;
    },
  };
}

const timedOut = (outcome: unknown) =>
  typeof outcome === "object" &&
  outcome !== null &&
  "error" in outcome &&
  outcome.error instanceof DOMException &&
  outcome.error.name === "TimeoutError";

beforeEach(() => {
  vi.useFakeTimers();
  fake.relays = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relayReader's limits", () => {
  it("are 20 s to the first message, 20 s between messages, and 180 s in all", () => {
    expect(CONNECT_TIMEOUT_MS).toBe(20 * SECOND);
    expect(IDLE_TIMEOUT_MS).toBe(20 * SECOND);
    expect(TOTAL_TIMEOUT_MS).toBe(180 * SECOND);
  });

  it("gives up when the relay sends nothing within 20 s of the request", async () => {
    const read = await startRead();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
    expect(read.relay.closed).toBe(true);
  });

  it.each(["close", "error"] as const)("is not ended by a %s of its connection: it gives up at its 20 s, as if nothing had been heard of it", async (type) => {
    const read = await startRead();
    read.relay.drop(type);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
    expect((read.outcome as { error: Error }).error.message).toBe(`${config.placesRelay} did not answer`);
  });

  it("keeps reading for as long as messages keep coming, each within 20 s of the last", async () => {
    const read = await startRead();
    // A slow link: an event every 15 s for two minutes, far past 20 s in all.
    for (let n = 0; n < 8; n++) {
      await vi.advanceTimersByTimeAsync(15 * SECOND);
      read.relay.send(["EVENT", "sub", event(n)]);
    }
    await vi.advanceTimersByTimeAsync(15 * SECOND);
    expect(read.outcome).toBeUndefined();
    read.relay.send(["EOSE", "sub"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.outcome).toEqual({ done: true });
    expect(read.events).toEqual(Array.from({ length: 8 }, (_, n) => event(n)));
  });

  it("gives up when the relay goes quiet for 20 s in the middle of the list", async () => {
    const read = await startRead();
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    read.relay.send(["EVENT", "sub", event(1)]);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
    expect(read.events).toEqual([event(1)]);
  });

  it("gives up at 180 s however steadily the relay sends", async () => {
    const read = await startRead();
    for (let elapsed = 0; elapsed < TOTAL_TIMEOUT_MS - 10 * SECOND; elapsed += 10 * SECOND) {
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      read.relay.send(["EVENT", "sub", event(elapsed)]);
    }
    await vi.advanceTimersByTimeAsync(10 * SECOND - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
  });

  it("leaves no timer running once the read has ended", async () => {
    const read = await startRead();
    read.relay.send(["EVENT", "sub", event(1)]);
    read.relay.send(["EOSE", "sub"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.outcome).toEqual({ done: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends with the caller's reason when the caller aborts", async () => {
    const controller = new AbortController();
    const read = await startRead({ signal: controller.signal });
    const reason = new Error("unmounted");
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.outcome).toEqual({ error: reason });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops at a notice from the relay", async () => {
    const read = await startRead();
    read.relay.send(["NOTICE", "too many requests"]);
    await vi.advanceTimersByTimeAsync(0);
    const outcome = read.outcome as { error: Error };
    expect(outcome.error.message).toContain("too many requests");
  });
});

describe("readerFor", () => {
  const SCORES = "wss://scores.example.test";

  it("reads from the relay it is given, one connection per request, closed at the end", async () => {
    const reader = readerFor(SCORES);
    const first = await startRead({ reader });
    expect(first.relay.url).toBe(SCORES);
    first.relay.send(["EOSE", "sub"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.outcome).toEqual({ done: true });
    expect(first.relay.closed).toBe(true);

    const second = await startRead({ reader });
    expect(second.relay).not.toBe(first.relay);
    expect(second.relay.url).toBe(SCORES);
    second.relay.send(["EOSE", "sub"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.outcome).toEqual({ done: true });
  });

  it("is what the places reader is, for the places relay", async () => {
    const read = await startRead();
    expect(read.relay.url).toBe(config.placesRelay);
    read.relay.send(["EOSE", "sub"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.outcome).toEqual({ done: true });
  });

  it("keeps the places reader's limits for any relay", async () => {
    const read = await startRead({ reader: readerFor(SCORES) });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
    expect((read.outcome as { error: Error }).error.message).toContain(SCORES);
    expect(read.relay.closed).toBe(true);
  });

  it("stops at a notice from any relay, and says which relay sent it", async () => {
    const read = await startRead({ reader: readerFor(SCORES) });
    read.relay.send(["NOTICE", "rate limited"]);
    await vi.advanceTimersByTimeAsync(0);
    const { message } = (read.outcome as { error: Error }).error;
    expect(message).toContain(SCORES);
    expect(message).toContain("rate limited");
  });

  it("gives up on any relay that goes quiet for 20 s in the middle of its events", async () => {
    const read = await startRead({ reader: readerFor(SCORES) });
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    read.relay.send(["EVENT", "sub", event(1)]);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
    expect((read.outcome as { error: Error }).error.message).toContain(SCORES);
    expect(read.events).toEqual([event(1)]);
  });

  it("gives up on any relay at 180 s however steadily it sends", async () => {
    const read = await startRead({ reader: readerFor(SCORES) });
    for (let elapsed = 0; elapsed < TOTAL_TIMEOUT_MS - 10 * SECOND; elapsed += 10 * SECOND) {
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      read.relay.send(["EVENT", "sub", event(elapsed)]);
    }
    await vi.advanceTimersByTimeAsync(10 * SECOND - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
    expect((read.outcome as { error: Error }).error.message).toContain(SCORES);
  });
});

describe("a read that asks not to wait on a relay that is out (failFast, ruling R40)", () => {
  const SCORES = "wss://scores.example.test";
  const lostUnheard = (outcome: unknown) =>
    typeof outcome === "object" && outcome !== null && "error" in outcome && outcome.error instanceof DOMException && outcome.error.name === "NetworkError";

  it.each(["close", "error"] as const)("ends at once with a NetworkError that names the relay when its connection has a %s before the relay has said anything, and closes it", async (type) => {
    const read = await startRead({ reader: readerFor(SCORES), opts: { failFast: true } });
    read.relay.drop(type);
    await vi.advanceTimersByTimeAsync(0);

    expect(lostUnheard(read.outcome)).toBe(true);
    expect((read.outcome as { error: Error }).error.message).toBe(`${SCORES} lost its connection before it answered`);
    expect(read.relay.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes on under its limits once the relay has sent an event: a connection lost then does not end it", async () => {
    const read = await startRead({ reader: readerFor(SCORES), opts: { failFast: true } });
    read.relay.send(["EVENT", "sub", event(1)]);
    await vi.advanceTimersByTimeAsync(0);
    read.relay.drop("close");

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(read.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(read.outcome)).toBe(true);
    expect(read.events).toEqual([event(1)]);
  });

  it("ends well at EOSE as any read, and a connection that closes after it changes nothing", async () => {
    const read = await startRead({ reader: readerFor(SCORES), opts: { failFast: true } });
    read.relay.send(["EOSE", "sub"]);
    await vi.advanceTimersByTimeAsync(0);
    read.relay.drop("close");
    await vi.advanceTimersByTimeAsync(0);

    expect(read.outcome).toEqual({ done: true });
  });

  it("is not how a read is made unless it asks: with failFast false, or nothing, a lost connection is waited out", async () => {
    for (const opts of [undefined, {}, { failFast: false }]) {
      const read = await startRead({ reader: readerFor(SCORES), opts });
      read.relay.drop("close");
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
      expect(read.outcome, JSON.stringify(opts)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(timedOut(read.outcome), JSON.stringify(opts)).toBe(true);
    }
  });

  it("is passed on by the app's readers, which load the relay code first: asked for, the read ends at once; not asked for, it waits", async () => {
    /** A read by the app's reader of `SCORES`, once the relay code is in and its relay is made. */
    async function appRead(opts?: ReadOptions) {
      const made = fake.relays.length;
      let outcome: { done: true } | { error: unknown } | undefined;
      void (async () => {
        try {
          const reader = appReaders(SCORES);
          const reading = opts === undefined ? reader.req({ kinds: [3] }, new AbortController().signal) : reader.req({ kinds: [3] }, new AbortController().signal, opts);
          for await (const _ of reading) {
            // Nothing is sent: only how the read ends matters.
          }
          outcome = { done: true };
        } catch (error) {
          outcome = { error };
        }
      })();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.relays).toHaveLength(made + 1);
      return {
        relay: fake.relays.at(-1)!,
        get outcome() {
          return outcome;
        },
      };
    }

    const asked = await appRead({ failFast: true });
    asked.relay.drop("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(lostUnheard(asked.outcome)).toBe(true);

    const plain = await appRead();
    plain.relay.drop("close");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(plain.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut(plain.outcome)).toBe(true);
  });
});

describe("signatures (Ruling R3b)", () => {
  const SCORES = "wss://scores.example.test";
  /** An event with no valid signature, which only the bypass lets through. */
  const unsigned = { id: "0".repeat(64), sig: "0".repeat(128) } as NostrEvent;

  /** The options the reader gave the relay it made, once its read has ended. */
  async function optionsOf(reader: RelayReader): Promise<NRelay1Opts> {
    const read = await startRead({ reader });
    read.relay.send(["EOSE", "sub"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.outcome).toEqual({ done: true });
    return read.relay.opts as NRelay1Opts;
  }

  it("are checked by NRelay1's own verifier on any relay, unless the reader opts out", async () => {
    expect(await optionsOf(readerFor(SCORES))).not.toHaveProperty("verifyEvent");
    expect(await optionsOf(readerFor(SCORES, { verify: true }))).not.toHaveProperty("verifyEvent");
    expect((await optionsOf(readerFor(SCORES, { verify: false }))).verifyEvent?.(unsigned)).toBe(true);
  });

  it("are not checked on the places relay, until Ruling R12's follow-up", async () => {
    expect((await optionsOf(relayReader)).verifyEvent?.(unsigned)).toBe(true);
  });
});

describe("writerFor", () => {
  const OWN = "wss://nos.example.test";
  const review = { id: "1".repeat(64) } as NostrEvent;

  /** Starts sending `review` to `OWN`, and how it ended once it has: done, or the error it threw. */
  async function startPublish(signal = new AbortController().signal) {
    let outcome: { done: true } | { error: unknown } | undefined;
    writerFor(OWN)
      .publish(review, signal)
      .then(
        () => (outcome = { done: true }),
        (error: unknown) => (outcome = { error }),
      );
    await vi.advanceTimersByTimeAsync(0);
    const relay = fake.relays.at(-1)!;
    return {
      relay,
      get outcome() {
        return outcome;
      },
    };
  }

  it("sends the event over a connection of its own, done when the relay takes it, and then closes it", async () => {
    const sent = await startPublish();
    expect(sent.relay.url).toBe(OWN);
    expect(sent.relay.published).toEqual([review]);
    expect(sent.outcome).toBeUndefined();
    sent.relay.send(["OK", review.id, true, ""]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.outcome).toEqual({ done: true });
    expect(sent.relay.closed).toBe(true);
  });

  it("fails with the relay's reason when it refuses the event, and closes the connection", async () => {
    const sent = await startPublish();
    sent.relay.send(["OK", review.id, false, "blocked: not on the list"]);
    await vi.advanceTimersByTimeAsync(0);
    expect((sent.outcome as { error: Error }).error.message).toBe("blocked: not on the list");
    expect(sent.relay.closed).toBe(true);
  });

  it("is done when the relay says it has the event already (OK true, duplicate:)", async () => {
    const sent = await startPublish();
    sent.relay.send(["OK", review.id, true, "duplicate: already have this event"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.outcome).toEqual({ done: true });
  });

  it.each([
    ["closes", "close"],
    ["fails", "error"],
  ] as const)(
    "fails with a NetworkError when the connection %s before the relay answers, and closes it: the relay may never have read the event",
    async (_, type) => {
      const sent = await startPublish();
      sent.relay.drop(type);
      await vi.advanceTimersByTimeAsync(0);
      const { error } = sent.outcome as { error: unknown };
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("NetworkError");
      expect((error as DOMException).message).toBe("The connection was lost before the relay answered");
      expect(sent.relay.closed).toBe(true);
    },
  );

  it("is done all the same when the connection closes after the relay has taken the event", async () => {
    const sent = await startPublish();
    sent.relay.send(["OK", review.id, true, ""]);
    await vi.advanceTimersByTimeAsync(0);
    sent.relay.drop("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.outcome).toEqual({ done: true });
  });

  it("stops when its signal aborts, with the signal's reason in place of NRelay1's bare AbortError", async () => {
    const controller = new AbortController();
    const sent = await startPublish(controller.signal);
    const reason = new DOMException("took too long", "TimeoutError");
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect((sent.outcome as { error: unknown }).error).toBe(reason);
    expect(sent.relay.closed).toBe(true);
  });

  it("does not start when its signal has aborted already", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const before = fake.relays.length;
    await expect(writerFor(OWN).publish(review, controller.signal)).rejects.toThrow("gone");
    expect(fake.relays).toHaveLength(before);
  });
});
