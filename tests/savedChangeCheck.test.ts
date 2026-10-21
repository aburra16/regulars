import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../src/account/session";
import { config } from "../src/config";
import { changeSaved, forgetSavedFloor, type SavedOutcome } from "../src/saved/change";
import { useLocks } from "./support/locks";
import { savedWorld, setUpSavedRelays } from "./support/savedWorld";

/*
 * The check of what the signer returns (`signatureCheck`, src/nostr/listWrite.ts), as a change of
 * saved places has it: its code is fetched, and it is had before the signer is asked. These play the
 * fetch failing, which the tests of the change itself cannot (tests/savedChange.test.ts: there the
 * code is always there). They are a file of their own, as a fetch that was played is slower for every
 * change after it in the same file. Relays are held in memory, the keys are thrown away, and the
 * clock is fake; nothing opens a socket.
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const NOW = 1_800_000_000;
const CAFE = { address: `39999:${config.houseHex}:cafe-funchal` };

/** A signer as an add-on is: it signs what it is asked to with the person's key. */
function signer() {
  return {
    getPublicKey: async () => ME,
    signEvent: vi.fn(async (asked: EventTemplate): Promise<NostrEvent> => finalizeEvent(structuredClone(asked), SECRET)),
  };
}

/** Aborts when each test ends: a change a test left under way ends there, and does not hold up the next. */
let life: AbortController;

/** The person saves the café, over the relays of `w`. */
function save(w: ReturnType<typeof savedWorld>, by: ReturnType<typeof signer>): Promise<SavedOutcome> {
  const account: Account = { pubkey: ME, signer: by, how: "browser" };
  return changeSaved(account, { save: CAFE }, { readers: w.readers, writers: w.writers, now: () => NOW }, life.signal);
}

/** What the app logs, on any level: nothing here may be. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  life = new AbortController();
  setUpSavedRelays(config);
  forgetSavedFloor();
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    life.abort(new Error("The test is over"));
    vi.doUnmock("nostr-tools/pure");
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useLocks(undefined);
  }
});

describe("the check of what the signer returns, had before the signer is asked", () => {
  it("stops the change with nothing signed when its code cannot be fetched: the person is not asked to approve what could not be saved", async () => {
    const w = savedWorld([]);
    const by = signer();
    vi.doMock("nostr-tools/pure", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });

    expect(await save(w, by)).toEqual({ kind: "not-saved" });

    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
    // Once it can be fetched, the same change is made.
    vi.doUnmock("nostr-tools/pure");
    expect((await save(w, by)).kind).toBe("saved");
    expect(by.signEvent).toHaveBeenCalledTimes(1);
  });
});
