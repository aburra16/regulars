import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADD_ON_WAIT_MS, hasAddOn, lookForAddOn } from "../src/signin/addOn";

/*
 * Whether the browser has an add-on to sign in with (NIP-07), and looking for one that puts itself on
 * the page a moment after it loads (decision 23). The clock is the test's: nothing here waits on time.
 */

/** The browser add-on as a page sees it, put on the page now. */
function installAddOn() {
  const key = generateSecretKey();
  Object.defineProperty(window, "nostr", {
    configurable: true,
    writable: true,
    value: { getPublicKey: async () => getPublicKey(key), signEvent: async () => ({}) },
  });
}

/** Whether `promise` has settled yet, and with what. */
function watch<T>(promise: Promise<T>): { done(): boolean; value(): T | undefined } {
  let done = false;
  let value: T | undefined;
  void promise.then((result) => {
    done = true;
    value = result;
  });
  return { done: () => done, value: () => value };
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "nostr");
});

describe("whether the browser has an add-on", () => {
  it("is yes where something on the page answers who the person is, and no otherwise", () => {
    expect(hasAddOn()).toBe(false);
    Object.defineProperty(window, "nostr", { configurable: true, writable: true, value: {} });
    expect(hasAddOn()).toBe(false);
    installAddOn();
    expect(hasAddOn()).toBe(true);
  });
});

describe("looking for the browser's add-on", () => {
  it("finds one that is on the page already, at once", async () => {
    installAddOn();
    await expect(lookForAddOn(new AbortController().signal)).resolves.toBe(true);
  });

  it("finds one that puts itself on the page a moment later, before the look ends", async () => {
    vi.useFakeTimers();
    const look = watch(lookForAddOn(new AbortController().signal));
    await vi.advanceTimersByTimeAsync(150);
    expect(look.done()).toBe(false);

    installAddOn();
    await vi.advanceTimersByTimeAsync(ADD_ON_WAIT_MS - 150 - 1);
    expect(look.done()).toBe(true);
    expect(look.value()).toBe(true);
  });

  it("finds one when the window gets the focus back, without waiting for the next look", async () => {
    vi.useFakeTimers();
    const look = watch(lookForAddOn(new AbortController().signal));
    installAddOn();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(look.value()).toBe(true);
  });

  it("ends with none once it has looked for at most half a second", async () => {
    vi.useFakeTimers();
    expect(ADD_ON_WAIT_MS).toBeLessThanOrEqual(500);
    const look = watch(lookForAddOn(new AbortController().signal));
    await vi.advanceTimersByTimeAsync(ADD_ON_WAIT_MS - 1);
    expect(look.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(look.done()).toBe(true);
    expect(look.value()).toBe(false);
    // Nothing is left running: no look, and no listener.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends when it is stopped, with what the page has then, and leaves nothing running", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const look = watch(lookForAddOn(controller.signal));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(look.value()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
