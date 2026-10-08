import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADD_ON_TIMEOUT_MS, CONNECT_TIMEOUT_MS, connectBrowser } from "../src/account/connect";
import { ADD_ON_WAIT_MS, hasAddOn, lookForAddOn, msSinceLoad } from "../src/signin/addOn";

/*
 * Whether the browser has an add-on to sign in with (NIP-07), looking for one that puts itself on the
 * page a moment after it loads (decision 23), and how long the add-on has to answer. The clock is the
 * test's: nothing here waits on time. A look is given how long ago the page loaded: 0, a page that has
 * just loaded, unless the test is of a page that loaded a while ago.
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
  vi.restoreAllMocks();
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
    await expect(lookForAddOn(new AbortController().signal, 0)).resolves.toBe(true);
  });

  it("finds one that puts itself on the page a moment later, before the look ends", async () => {
    vi.useFakeTimers();
    const look = watch(lookForAddOn(new AbortController().signal, 0));
    await vi.advanceTimersByTimeAsync(150);
    expect(look.done()).toBe(false);

    installAddOn();
    await vi.advanceTimersByTimeAsync(ADD_ON_WAIT_MS - 150 - 1);
    expect(look.done()).toBe(true);
    expect(look.value()).toBe(true);
  });

  it("finds one when the window gets the focus back, without waiting for the next look", async () => {
    vi.useFakeTimers();
    const look = watch(lookForAddOn(new AbortController().signal, 0));
    installAddOn();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(look.value()).toBe(true);
  });

  it("ends with none once it has looked for at most half a second", async () => {
    vi.useFakeTimers();
    expect(ADD_ON_WAIT_MS).toBeLessThanOrEqual(500);
    const look = watch(lookForAddOn(new AbortController().signal, 0));
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
    const look = watch(lookForAddOn(controller.signal, 0));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(look.value()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a page that loaded a while ago", () => {
  it("is not looked at again: an add-on puts itself on the page as it loads, so whatever is there now is all there is", async () => {
    vi.useFakeTimers();
    const look = watch(lookForAddOn(new AbortController().signal, ADD_ON_WAIT_MS + 100));
    await vi.advanceTimersByTimeAsync(0);
    expect(look.done()).toBe(true);
    expect(look.value()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is looked at only for what is left of the half second, for a page that loaded a moment ago", async () => {
    vi.useFakeTimers();
    const look = watch(lookForAddOn(new AbortController().signal, 300));
    await vi.advanceTimersByTimeAsync(ADD_ON_WAIT_MS - 300 - 1);
    expect(look.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(look.value()).toBe(false);
  });

  it("is measured from when the document loaded, against the start of its navigation", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_200);
    const loaded = vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ domContentLoadedEventEnd: 400 } as unknown as PerformanceEntry]);
    expect(msSinceLoad()).toBe(800);
    // Where the browser does not say when it loaded: from the start of the navigation.
    loaded.mockReturnValue([]);
    expect(msSinceLoad()).toBe(1_200);
  });

  it("is a page that has just loaded while its document is still loading, on a slow network: the look runs", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(4_000);
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ domContentLoadedEventEnd: 0 } as unknown as PerformanceEntry]);
    expect(msSinceLoad()).toBe(0);

    const look = watch(lookForAddOn(new AbortController().signal));
    await vi.advanceTimersByTimeAsync(ADD_ON_WAIT_MS - 1);
    expect(look.done()).toBe(false);
    installAddOn();
    await vi.advanceTimersByTimeAsync(1);
    expect(look.value()).toBe(true);
  });
});

describe("the time the add-on has to answer", () => {
  it("is a minute, its own, while a phone app keeps two", () => {
    expect(ADD_ON_TIMEOUT_MS).toBe(60_000);
    expect(CONNECT_TIMEOUT_MS).toBe(120_000);
  });

  it("ends signing in with the add-on after a minute with no answer", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "nostr", {
      configurable: true,
      writable: true,
      value: { getPublicKey: () => new Promise<string>(() => {}), signEvent: async () => ({}) },
    });
    const signingIn = connectBrowser(new AbortController().signal);
    signingIn.catch(() => {});
    const ended = watch(signingIn.then(() => "in", () => "ended"));
    await vi.advanceTimersByTimeAsync(ADD_ON_TIMEOUT_MS - 1);
    expect(ended.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.value()).toBe("ended");
    expect(vi.getTimerCount()).toBe(0);
  });
});
