import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../src/account/session";
import { config } from "../src/config";
import { changeFollow, FOLLOW_LOCK, type FollowOutcome, forgetFollowFloor } from "../src/follow/change";
import { FOLLOW_READ_MS } from "../src/follow/read";
import { ABSENT, buildFollowList, FOLLOW_LIST_TIME, pubkeyAt } from "./fixtures/follow-list";
import { shapedEvent } from "./support/events";
import { everywhere, setUpRelays, type World } from "./support/followWorld";
import { FakeLocks, useLocks } from "./support/locks";

/*
 * The check of what the signer returns (src/follow/change.ts, `signatureCheck`): its code is fetched,
 * as its curve is no part of the first screen, and it is had before the signer is asked. These play
 * the fetch failing, and hanging, which the tests of the change itself cannot (tests/followChange.test.ts:
 * there the code is always there). They are a file of their own because a fetch that was played is
 * slower for every change after it in the same file, and those tests count the turns a change takes.
 * Relays are held in memory, the keys are thrown away, and the clock is fake; nothing opens a socket.
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
/** Someone the list names already, and the clock: after the list was made. */
const FRIEND = pubkeyAt(8);
const NOW = FOLLOW_LIST_TIME + 500;

/** A signer as an add-on is: it signs what it is asked to with the person's key. */
function signer() {
  return {
    getPublicKey: async () => ME,
    signEvent: vi.fn(async (asked: EventTemplate): Promise<NostrEvent> => finalizeEvent(structuredClone(asked), SECRET)),
  };
}

/** Aborts when each test ends: a change a test left under way ends there, and does not hold up the next. */
let life: AbortController;

/** The person follows `who`, over the relays of `w`. */
function follow(w: World, who: string, opts: { by?: ReturnType<typeof signer>; signal?: AbortSignal } = {}): Promise<FollowOutcome> {
  const account: Account = { pubkey: ME, signer: opts.by ?? signer(), how: "browser" };
  const signal = opts.signal === undefined ? life.signal : AbortSignal.any([opts.signal, life.signal]);
  return changeFollow(account, who, "follow", { readers: w.readers, writers: w.writers, now: () => NOW }, signal);
}

/** How a change ended, once it has: its outcome, or what it threw. Neither while it goes on. */
function track(changing: Promise<FollowOutcome>) {
  const ended: { outcome?: FollowOutcome; error?: unknown } = {};
  changing.then(
    (outcome) => (ended.outcome = outcome),
    (error: unknown) => (ended.error = error),
  );
  return ended;
}

/** Lets the code that was held back come, at the end of a test that held it: nothing is left waiting on it. */
let comes: (() => void) | undefined;

/** Makes the fetch of nostr-tools' code, which the change fetches for the check, fail. */
function checkCodeCannotBeFetched() {
  vi.doMock("nostr-tools/pure", () => {
    throw new TypeError("Failed to fetch dynamically imported module");
  });
}

/** Holds the fetch of that code back, as on a connection that hangs, until the test ends. */
function checkCodeDoesNotCome() {
  const held = new Promise<void>((resolve) => {
    comes = resolve;
  });
  vi.doMock("nostr-tools/pure", async () => {
    await held;
    return vi.importActual("nostr-tools/pure");
  });
}

/** What the app logs, on any level: nothing here may be. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  life = new AbortController();
  setUpRelays(config);
  forgetFollowFloor();
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    life.abort(new Error("The test is over"));
    comes?.();
    comes = undefined;
    vi.doUnmock("nostr-tools/pure");
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useLocks(undefined);
  }
});

describe("the check of what the signer returns, had before the signer is asked", () => {
  it("stops the change with nothing signed when the check's code cannot be fetched: the person is not asked to approve what could not be saved", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    checkCodeCannotBeFetched();

    expect(await follow(w, ABSENT, { by })).toEqual({ kind: "not-saved" });

    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
    // Once it can be fetched, the same change is made.
    vi.doUnmock("nostr-tools/pure");
    const again = await follow(w, ABSENT, { by });
    expect(again.kind).toBe("saved");
    expect(by.signEvent).toHaveBeenCalledTimes(1);
  });

  it("does not fetch it for a change that signs nothing: one that is so already, and one whose list could not be loaded", async () => {
    checkCodeCannotBeFetched();

    expect((await follow(everywhere([buildFollowList(SECRET)]), FRIEND)).kind).toBe("unchanged");
    // An account that shows use, and no list anywhere: nothing is built, and nothing is to be checked.
    expect(await follow(everywhere([shapedEvent({ kind: 0, pubkey: ME, content: "{}" })]), ABSENT)).toEqual({ kind: "not-loaded" });
  });

  it("waits for it under the change's signal: when the code does not come, a change that is stopped ends at once, the signer was never asked, and the tab's turn is let go of", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    const stop = new AbortController();
    checkCodeDoesNotCome();
    const ended = track(follow(w, ABSENT, { by, signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);
    // The list is read, and the change waits for the check's code: nothing is signed meanwhile.
    expect(ended).toEqual({});
    expect(by.signEvent).not.toHaveBeenCalled();

    const reason = new Error("signed out");
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.error).toBe(reason);

    // The tab's turn went with it: a change that needs no check is not held behind a fetch that
    // hangs. (One that signs would wait for the same code, under a signal of its own.)
    const next = track(follow(w, FRIEND));
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);
    expect(next.outcome?.kind).toBe("unchanged");
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("holds the browser's lock no longer than the change, when the code does not come and the change is stopped", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const w = everywhere([buildFollowList(SECRET)]);
    const stop = new AbortController();
    checkCodeDoesNotCome();
    const ended = track(follow(w, ABSENT, { signal: stop.signal }));
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);
    // Another tab asks for the lock, and waits: the change holds it while it waits for the code.
    let lent = false;
    void locks.request(FOLLOW_LOCK, {}, async () => {
      lent = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lent).toBe(false);

    stop.abort(new Error("signed out"));
    await vi.advanceTimersByTimeAsync(0);

    expect(ended.error).toBeInstanceOf(Error);
    expect(lent).toBe(true);
  });
});
