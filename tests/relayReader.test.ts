import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS, relayReader, TOTAL_TIMEOUT_MS } from "../src/places/relayReader";

// A stand-in for Nostrify's relay, with no socket: the test plays the relay's part, message by
// message, and the reader's limits run on fake timers.
const fake = vi.hoisted(() => ({ relays: [] as { send(msg: unknown[]): void; closed: boolean }[] }));

vi.mock("@nostrify/nostrify", () => {
  class NRelay1 {
    private queue: unknown[][] = [];
    private wake: (() => void) | undefined;
    closed = false;

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

    async close(): Promise<void> {
      this.closed = true;
    }
  }
  return { NRelay1 };
});

const SECOND = 1000;
const event = (n: number) => ({ id: String(n) });

/** Starts a read, and how it ended once it has: the events it gave, or the error it threw. */
async function startRead(signal = new AbortController().signal) {
  const events: unknown[] = [];
  let outcome: { done: true } | { error: unknown } | undefined;
  void (async () => {
    try {
      for await (const value of relayReader.req({ kinds: [39999] }, signal)) events.push(value);
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
    const read = await startRead(controller.signal);
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
