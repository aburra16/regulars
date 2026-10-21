import type { NostrEvent } from "@nostrify/nostrify";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import type { Readers, ReadOptions, RelayReader } from "../src/nostr/events";
import { MAX_SAVED_RELAYS, mayStartList, readSavedList, SAVED_READ_MS, type SavedRead, savedRelaysWith } from "../src/saved/read";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";

/*
 * Reading a person's saved places from several relays: their relay list first, then their list from
 * the relays it writes to and reads from and the app's own saved-list relays, side by side; and
 * whether enough of the app's relays answered for a first list to be made. Nothing here writes.
 * Relays are held in memory (tests/support/memoryReader.ts) and the clock is fake, so that a relay
 * that never answers costs no time.
 */

/** Where a person's relay list is kept. */
const DIRECTORY = "wss://purplepag.es";
/** The app's five saved-list relays, for these tests. */
const APP = ["wss://one.example.test", "wss://two.example.test", "wss://three.example.test", "wss://four.example.test", "wss://five.example.test"];
const [ONE, TWO, THREE, FOUR, FIVE] = APP as [string, string, string, string, string];
/** A relay the person writes to, and one they read from. */
const WRITES = "wss://own.example.test";
const READS = "wss://reads.example.test";

const ME = getPublicKey(generateSecretKey());
const OTHER = hex64("2");

/** A saved list of the person's, over `fields`. */
const saved = (fields: Partial<NostrEvent> = {}) => shapedEvent({ kind: 30003, pubkey: ME, tags: [["d", "regulars-saved"]], ...fields });

/** The person's relay list (kind 10002): each entry is `[url]`, `[url, "read"]` or `[url, "write"]`. */
const relayList = (entries: string[][]) => shapedEvent({ kind: 10002, pubkey: ME, tags: entries.map((entry) => ["r", ...entry]) });

/** Readers by relay URL: a relay that is not in `held` holds nothing. */
const readersOver =
  (held: Record<string, RelayReader>): Readers =>
  (url) =>
    held[url] ?? createMemoryReader([]);

/** A relay that never answers, and takes no notice of the signal. */
const silent: RelayReader = {
  async *req() {
    await new Promise<never>(() => {});
  },
};

/** A relay that sends `events` whatever it is asked. */
const sendingAnyway = (events: NostrEvent[]): RelayReader => ({
  async *req() {
    yield* events;
  },
});

const read = (readers: Readers, signal = new AbortController().signal) => readSavedList(ME, readers, signal);

/** The filter a saved list is asked for by. */
const ASKED = { kinds: [30003], authors: [ME], "#d": ["regulars-saved"] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  config.relayListRelays = [DIRECTORY];
  config.savedListRelays = [...APP];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("savedRelaysWith", () => {
  it("gives the person's relays, those they write to first, then the app's saved-list relays", () => {
    expect(savedRelaysWith({ write: [WRITES], read: [READS] })).toEqual({ relays: [WRITES, READS, ...APP], writes: [WRITES] });
    expect(savedRelaysWith(null)).toEqual({ relays: APP, writes: [] });
  });

  it("gives at most 16, and keeps the app's five when the person names more than there is room for", () => {
    const theirs = Array.from({ length: 20 }, (_, n) => `wss://own${n}.example.test`);

    const { relays, writes } = savedRelaysWith({ write: theirs, read: [] });

    expect(MAX_SAVED_RELAYS).toBe(16);
    expect(relays).toEqual([...theirs.slice(0, 11), ...APP]);
    expect(writes).toEqual(theirs.slice(0, 11));
  });
});

describe("readSavedList", () => {
  it("takes the newest list of three relays that hold one, and counts every relay that answered", async () => {
    const older = saved({ created_at: 1_700_000_000 });
    const newest = saved({ created_at: 1_700_000_900 });
    const between = saved({ created_at: 1_700_000_500 });
    const readers = readersOver({ [ONE]: createMemoryReader([older]), [TWO]: createMemoryReader([newest]), [THREE]: createMemoryReader([between]) });

    const found = await read(readers);

    expect(found).toEqual({ list: newest, answered: APP, relays: APP, writes: [], relayList: "none" });
  });

  it("takes the lower id of two lists made in the same second", async () => {
    const low = saved({ id: hex64("1") });
    const high = saved({ id: hex64("f") });

    expect((await read(readersOver({ [ONE]: createMemoryReader([high]), [TWO]: createMemoryReader([low]) }))).list).toEqual(low);
  });

  it("asks each relay for the person's list by its name, once, and the relay-list relay for their relay list first", async () => {
    const directory = createMemoryReader([]);
    const one = createMemoryReader([]);

    await read(readersOver({ [DIRECTORY]: directory, [ONE]: one }));

    expect(directory.requests).toEqual([{ kinds: [10002], authors: [ME], limit: 1 }]);
    expect(one.requests).toEqual([ASKED]);
  });

  it("leaves a relay that fails out of those that answered, and the others still count", async () => {
    const mine = saved();
    const readers = readersOver({ [ONE]: createMemoryReader([], { failWith: new Error("socket closed") }), [TWO]: createMemoryReader([mine]) });

    const found = await read(readers);

    expect(found.list).toEqual(mine);
    expect(found.answered).toEqual([TWO, THREE, FOUR, FIVE]);
  });

  it("leaves a relay that does not answer within SAVED_READ_MS out, and goes on with the others", async () => {
    const mine = saved();
    let found: SavedRead | undefined;
    void read(readersOver({ [ONE]: silent, [TWO]: createMemoryReader([mine]) })).then((result) => {
      found = result;
    });

    await vi.advanceTimersByTimeAsync(SAVED_READ_MS - 1);
    expect(found).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(SAVED_READ_MS).toBe(6_000);
    expect(found?.list).toEqual(mine);
    expect(found?.answered).toEqual([TWO, THREE, FOUR, FIVE]);
  });

  it("finds no list, and no relay that answered, when none answers", async () => {
    const down = createMemoryReader([], { failWith: new Error("down") });

    expect(await read(() => down)).toEqual({ list: null, answered: [], relays: APP, writes: [], relayList: "unknown" });
  });

  it("reads the relays the person writes to and reads from beside the app's, and finds a newer list on one of theirs", async () => {
    const old = saved({ created_at: 1_700_000_000 });
    const theirNewest = saved({ created_at: 1_700_000_900 });
    const own = createMemoryReader([theirNewest]);
    const reads = createMemoryReader([]);
    const readers = readersOver({
      [DIRECTORY]: createMemoryReader([relayList([[WRITES, "write"], [READS, "read"]])]),
      [WRITES]: own,
      [READS]: reads,
      [ONE]: createMemoryReader([old]),
    });

    const found = await read(readers);

    expect(found).toEqual({ list: theirNewest, answered: [WRITES, READS, ...APP], relays: [WRITES, READS, ...APP], writes: [WRITES], relayList: "found" });
    expect(own.requests).toEqual([ASKED]);
    expect(reads.requests).toEqual([ASKED]);
  });

  it("reads the app's relays alone when the person's relay list is not known, still finds the list there, and says the relay list is not known", async () => {
    const mine = saved();
    const one = createMemoryReader([mine]);
    const readers = readersOver({ [DIRECTORY]: createMemoryReader([], { failWith: new Error("down") }), [ONE]: one });

    const found = await read(readers);

    expect(found).toEqual({ list: mine, answered: APP, relays: APP, writes: [], relayList: "unknown" });
    expect(one.requests).toEqual([ASKED]);
  });

  it("reads the app's relays alone when the person has no relay list, and says they have none", async () => {
    const found = await read(readersOver({}));

    expect(found).toEqual({ list: null, answered: APP, relays: APP, writes: [], relayList: "none" });
  });

  it("asks every relay, for the relay list and for the saved list, not to be waited on when it is out", async () => {
    const asked: Array<{ url: string; kinds: number[] | undefined; opts: ReadOptions | undefined }> = [];
    const readers: Readers = (url) => ({
      req(filter, signal, opts) {
        asked.push({ url, kinds: filter.kinds, opts });
        return createMemoryReader([]).req(filter, signal, opts);
      },
    });

    await read(readers);

    expect(asked.map(({ url, kinds }) => [url, kinds])).toEqual([[DIRECTORY, [10002]], ...APP.map((url) => [url, [30003]])]);
    expect(asked.every(({ opts }) => opts?.failFast === true)).toBe(true);
  });

  it("ignores lists of another name, by another author or of another kind, whatever a relay sends", async () => {
    const mine = saved({ created_at: 1_700_000_000 });
    const readers = readersOver({
      [ONE]: sendingAnyway([
        saved({ created_at: 1_700_000_900, tags: [["d", "favourites"]] }),
        saved({ created_at: 1_700_000_900, pubkey: OTHER }),
        shapedEvent({ kind: 10003, pubkey: ME, created_at: 1_700_000_900, tags: [["d", "regulars-saved"]] }),
        mine,
      ]),
    });

    expect((await read(readers)).list).toEqual(mine);
  });

  it("throws the signal's reason when it aborts, before it starts or while a relay is still being read", async () => {
    const stop = new AbortController();
    stop.abort(new Error("signed out"));
    await expect(read(readersOver({}), stop.signal)).rejects.toThrow("signed out");

    const later = new AbortController();
    const reading = read(readersOver({ [ONE]: silent }), later.signal);
    await vi.advanceTimersByTimeAsync(0);
    later.abort(new Error("signed out later"));
    await expect(reading).rejects.toThrow("signed out later");
  });
});

describe("mayStartList: whether enough of the app's saved-list relays answered for their nothing to be believed", () => {
  const answering = (answered: string[], relayList: SavedRead["relayList"] = "none"): SavedRead => ({ list: null, answered, relays: [...answered], writes: [], relayList });

  it("is so when three of the app's five answered, and not with two", () => {
    expect(mayStartList(answering([ONE, TWO, THREE]))).toBe(true);
    expect(mayStartList(answering(APP))).toBe(true);
    expect(mayStartList(answering([ONE, FIVE]))).toBe(false);
    expect(mayStartList(answering([]))).toBe(false);
  });

  it("counts only the app's own: the person's relays that answered never make up the number", () => {
    expect(mayStartList(answering([WRITES, READS, "wss://more.example.test", ONE, TWO]))).toBe(false);
    expect(mayStartList(answering([WRITES, ONE, TWO, THREE]))).toBe(true);
  });

  it("counts a relay as the app is set up with it, however its address is written there", () => {
    config.savedListRelays = ["wss://ONE.example.test/", TWO, THREE];

    expect(mayStartList(answering([ONE, TWO, THREE]))).toBe(true);
  });

  it("is never so while the person's relay list is not known, however many of the app's relays answered: their list may be on their own relays alone", () => {
    expect(mayStartList(answering(APP, "unknown"))).toBe(false);
    expect(mayStartList(answering([ONE, TWO, THREE], "unknown"))).toBe(false);
    expect(mayStartList(answering([WRITES, ...APP], "unknown"))).toBe(false);
  });

  it("is so with the person's relay list found, or known to be none, once enough of the app's relays answered", () => {
    expect(mayStartList(answering(APP, "found"))).toBe(true);
    expect(mayStartList(answering(APP, "none"))).toBe(true);
    expect(mayStartList(answering([ONE, TWO], "found"))).toBe(false);
  });

  it("is never so with fewer than three of the app's relays, however many answered", () => {
    config.savedListRelays = [ONE, TWO];
    expect(mayStartList(answering([ONE, TWO]))).toBe(false);

    config.savedListRelays = [];
    expect(mayStartList(answering([ONE, TWO, THREE]))).toBe(false);
  });
});
