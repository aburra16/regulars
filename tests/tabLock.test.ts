import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withTabLock } from "../src/account/tabLock";
import { FakeLocks, useLocks } from "./support/locks";

/*
 * One thing at a time across the person's tabs, by a lock of the browser's (Web Locks): what
 * Brainstorm's sign-in and a change to the follow list both run under, each with a name of its own.
 * The browser's locks are played in memory (tests/support/locks.ts), and the clock is fake.
 */

const NAME = "regulars.test";
const WAIT_MS = 30_000;

const never = () => new AbortController().signal;

/** A task that ends when the test says: `end` settles it, with `value` or by failing with it. */
function heldTask<T>(value: T) {
  let end!: (how?: "fail") => void;
  const run = vi.fn(
    () =>
      new Promise<T>((resolve, reject) => {
        end = (how) => (how === "fail" ? reject(value) : resolve(value));
      }),
  );
  return { run, end: (how?: "fail") => end(how) };
}

let locks: FakeLocks;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  locks = new FakeLocks();
  useLocks(locks);
});

afterEach(() => {
  // No wait outlives what it waited for.
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  useLocks(undefined);
});

describe("withTabLock", () => {
  it("runs the task under the browser's lock of that name, and gives what the task gives", async () => {
    const task = vi.fn(async () => "done");

    await expect(withTabLock(NAME, WAIT_MS, task, never())).resolves.toBe("done");

    expect(task).toHaveBeenCalledTimes(1);
    expect(locks.requests).toEqual([NAME]);
  });

  it("stops the clock of its wait once it has the lock: a task longer than the wait runs to its end, once", async () => {
    const long = heldTask("done at last");
    const running = withTabLock(NAME, WAIT_MS, long.run, never());

    await vi.advanceTimersByTimeAsync(0);
    expect(long.run).toHaveBeenCalledTimes(1);
    // It holds the lock: nothing is counting any more.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(WAIT_MS * 3);
    long.end();
    await expect(running).resolves.toBe("done at last");
    expect(long.run).toHaveBeenCalledTimes(1);
  });

  it("makes a second task of the same name wait for the first to end, and not one of another name", async () => {
    const first = heldTask("first");
    const second = vi.fn(async () => "second");
    const other = vi.fn(async () => "other");

    const one = withTabLock(NAME, WAIT_MS, first.run, never());
    const two = withTabLock(NAME, WAIT_MS, second, never());
    await expect(withTabLock("regulars.other", WAIT_MS, other, never())).resolves.toBe("other");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    first.end();
    await expect(one).resolves.toBe("first");
    await expect(two).resolves.toBe("second");
  });

  it("lets go of the lock when the task fails, fails as it did, and does not run it again", async () => {
    const failing = heldTask(new Error("it broke"));
    const next = vi.fn(async () => "next");

    const one = withTabLock(NAME, WAIT_MS, failing.run, never());
    const two = withTabLock(NAME, WAIT_MS, next, never());
    await vi.advanceTimersByTimeAsync(0);
    failing.end("fail");

    await expect(one).rejects.toThrow("it broke");
    await expect(two).resolves.toBe("next");
    // Not run a second time, without the lock, as it is when the lock could not be had.
    expect(failing.run).toHaveBeenCalledTimes(1);
  });

  it("does not wait for ever on a lock another tab never lets go: once its wait is up it goes ahead without it", async () => {
    void locks.request(NAME, {}, () => new Promise<never>(() => {}));
    const task = vi.fn(async () => "done");
    const running = withTabLock(NAME, WAIT_MS, task, never());

    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(running).resolves.toBe("done");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when its signal aborts, with the signal's reason, and never runs the task", async () => {
    void locks.request(NAME, {}, () => new Promise<never>(() => {}));
    const task = vi.fn(async () => "done");
    const stop = new AbortController();
    const running = withTabLock(NAME, WAIT_MS, task, stop.signal);
    const ended = running.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error("Gone");
    stop.abort(reason);

    expect(await ended).toBe(reason);
    // It has left the queue: nothing of it is still waiting.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(task).not.toHaveBeenCalled();
  });

  it("does not ask for the lock's task when its signal has aborted already", async () => {
    const task = vi.fn(async () => "done");
    const stop = new AbortController();
    const reason = new Error("Gone");
    stop.abort(reason);

    await expect(withTabLock(NAME, WAIT_MS, task, stop.signal)).rejects.toBe(reason);
    expect(task).not.toHaveBeenCalled();
  });

  it("goes ahead at once, unguarded, in a browser with no Web Locks", async () => {
    useLocks(undefined);
    const first = heldTask("first");
    const second = vi.fn(async () => "second");

    const one = withTabLock(NAME, WAIT_MS, first.run, never());
    // Nothing holds the second back: the first has not ended.
    await expect(withTabLock(NAME, WAIT_MS, second, never())).resolves.toBe("second");
    first.end();
    await expect(one).resolves.toBe("first");
  });

  it("goes ahead without the lock when the browser will not lend it", async () => {
    useLocks({ request: () => Promise.reject(new DOMException("Locks are not allowed here", "SecurityError")) });
    const task = vi.fn(async () => "done");

    await expect(withTabLock(NAME, WAIT_MS, task, never())).resolves.toBe("done");
    expect(task).toHaveBeenCalledTimes(1);
  });
});
