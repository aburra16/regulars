import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRelayList, relayListOf, writeRelaysOf } from "../src/account/writeRelays";
import { config } from "../src/config";
import type { RelayReader } from "../src/nostr/events";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader, type MemoryReader } from "./support/memoryReader";

/** Brainstorm's search relay (the review relay, which takes `include:spam`) and the relay-list directory. */
const SEARCH = "wss://search.brainstorm.world";
const DIRECTORY = "wss://purplepag.es";

const ALICE = hex64("a");
const BOB = hex64("b");

/** Alice's relay list (kind 10002): each entry is `[url]`, `[url, "read"]` or `[url, "write"]`. */
const relayList = (entries: string[][], fields: Partial<NostrEvent> = {}, pubkey = ALICE) =>
  shapedEvent({ kind: 10002, pubkey, tags: entries.map((entry) => ["r", ...entry]), ...fields });

/** A signer that can only be asked for its relays: none of the tests asks it to sign. */
function signerWith(getRelays?: NostrSigner["getRelays"]): NostrSigner {
  return {
    getPublicKey: async () => ALICE,
    signEvent: async () => {
      throw new Error("These tests sign nothing");
    },
    ...(getRelays === undefined ? {} : { getRelays }),
  };
}

/** The relays a signer reports, as NIP-07's `getRelays` does. */
const reports = (relays: Record<string, { read: boolean; write: boolean }>) =>
  vi.fn(async () => relays);

/** Readers by relay URL: a relay that is not in `held` holds nothing. Each reader keeps the filters it was sent. */
function readersOver(held: Record<string, MemoryReader>): { readers: (url: string) => RelayReader; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    readers(url) {
      asked.push(url);
      return held[url] ?? createMemoryReader([]);
    },
  };
}

const run = (
  signer: NostrSigner,
  readers: (url: string) => RelayReader,
  signal: AbortSignal = new AbortController().signal,
  pubkey = ALICE,
) => writeRelaysOf(pubkey, signer, readers, signal);

describe("relayListOf: the relays a person's list reads from and writes to", () => {
  it("gives the writes and the reads of the newest list, in its order, an unmarked relay being both", async () => {
    const older = relayList([["wss://old.example.com"]], { created_at: 1_700_000_000 });
    const newer = relayList(
      [["wss://both.example.com"], ["wss://reads.example.com", "read"], ["wss://writes.example.com", "write"], ["wss://after.example.com"]],
      { created_at: 1_700_000_500 },
    );
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([older, newer]) });

    expect(await relayListOf(ALICE, readers, new AbortController().signal)).toEqual({
      write: ["wss://both.example.com", "wss://writes.example.com", "wss://after.example.com"],
      read: ["wss://both.example.com", "wss://reads.example.com", "wss://after.example.com"],
    });
  });

  it("gives null when no relay has a list, or none answers", async () => {
    const { readers } = readersOver({});
    expect(await relayListOf(ALICE, readers, new AbortController().signal)).toBeNull();

    const failing = () => createMemoryReader([], { failWith: new Error("down") });
    expect(await relayListOf(ALICE, () => failing(), new AbortController().signal)).toBeNull();
  });

  it("gives empty lists for a list that names no relay", async () => {
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([relayList([])]) });

    expect(await relayListOf(ALICE, readers, new AbortController().signal)).toEqual({ write: [], read: [] });
  });

  it("throws the signal's reason when it aborts", async () => {
    const stop = new AbortController();
    stop.abort(new Error("gone"));
    const { readers } = readersOver({});

    await expect(relayListOf(ALICE, readers, stop.signal)).rejects.toThrow("gone");
  });
});

describe("relayListOf, the read a review waits for", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    config.reviewRelays = [SEARCH];
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("waits for a slow relay as it always has: a review's wait is its caller's", async () => {
    const OWN = "wss://own.example.com";
    const { readers } = readersOver({ [SEARCH]: createMemoryReader([relayList([[OWN]])], { delayMs: 40_000 }) });
    const ended: { list?: Awaited<ReturnType<typeof relayListOf>> } = {};
    void relayListOf(ALICE, readers, new AbortController().signal).then((list) => (ended.list = list));

    await vi.advanceTimersByTimeAsync(40_000 - 1);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(ended.list).toEqual({ write: [OWN], read: [OWN] });
  });
});

describe("readRelayList: found, none, or not known (ruling R43), with a time for each relay (ruling R11)", () => {
  const OWN = "wss://own.example.com";
  const WITHIN = 4_000;
  const FOUND = { is: "found", write: [OWN], read: [OWN] };

  /** A relay that never answers, and takes no notice of the signal. */
  const stalled: RelayReader = {
    async *req() {
      await new Promise<never>(() => {});
    },
  };
  const down = () => createMemoryReader([], { failWith: new Error("down") });

  /** How the read ended, once it has. */
  function track(reading: ReturnType<typeof readRelayList>) {
    const ended: { list?: Awaited<ReturnType<typeof readRelayList>>; error?: unknown } = {};
    reading.then(
      (list) => (ended.list = list),
      (error: unknown) => (ended.error = error),
    );
    return ended;
  }
  const read = (readers: (url: string) => RelayReader) => readRelayList(ALICE, readers, new AbortController().signal, WITHIN);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    config.reviewRelays = [SEARCH];
  });

  afterEach(() => {
    // No relay's clock outlives the read.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("is found when a relay sends one: the writes and the reads of the newest, in its order", async () => {
    const older = relayList([["wss://old.example.com"]], { created_at: 1_700_000_000 });
    const newer = relayList([["wss://both.example.com"], ["wss://reads.example.com", "read"], ["wss://writes.example.com", "write"]], { created_at: 1_700_000_500 });
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([older]), [SEARCH]: createMemoryReader([newer]) });

    expect(await read(readers)).toEqual({
      is: "found",
      write: ["wss://both.example.com", "wss://writes.example.com"],
      read: ["wss://both.example.com", "wss://reads.example.com"],
    });
    // A list that names no relay is a list all the same.
    expect(await read(readersOver({ [DIRECTORY]: createMemoryReader([relayList([])]) }).readers)).toEqual({ is: "found", write: [], read: [] });
  });

  it("is none when the relay-list relay answers and no relay sends one", async () => {
    expect(config.relayListRelays).toEqual([DIRECTORY]);

    expect(await read(readersOver({}).readers)).toEqual({ is: "none" });
  });

  it("is none though a review relay does not answer: the review relays are more chances to find one, and their silence takes nothing away", async () => {
    expect(await read(readersOver({ [SEARCH]: down() }).readers)).toEqual({ is: "none" });
  });

  it("is not known when the relay-list relay does not answer, whatever the review relays say: theirs is no proof that there is none", async () => {
    // The review relay answers, with none: the directory, where a person's list is kept, did not.
    expect(await read(readersOver({ [DIRECTORY]: down() }).readers)).toEqual({ is: "unknown" });
    expect(await read(() => down())).toEqual({ is: "unknown" });
  });

  it("is found from a review relay though the relay-list relay is out: a list that was found is known", async () => {
    const readers = readersOver({ [DIRECTORY]: down(), [SEARCH]: createMemoryReader([relayList([[OWN]])]) }).readers;

    expect(await read(readers)).toEqual(FOUND);
  });

  it("needs every relay-list relay to answer before it is none, when the app is set up with more than one", async () => {
    const SECOND = "wss://lists.example.com";
    config.relayListRelays = [DIRECTORY, SECOND];

    expect(await read(readersOver({}).readers)).toEqual({ is: "none" });
    expect(await read(readersOver({ [SECOND]: down() }).readers)).toEqual({ is: "unknown" });
    expect(await read(readersOver({ [DIRECTORY]: down() }).readers)).toEqual({ is: "unknown" });
    expect(await read(readersOver({ [DIRECTORY]: down(), [SECOND]: createMemoryReader([relayList([[OWN]])]) }).readers)).toEqual(FOUND);
  });

  it("counts a relay-list relay that is a review relay too, written another way, as the one relay it is", async () => {
    config.reviewRelays = [SEARCH, "wss://PURPLEPAG.es/"];
    const directory = createMemoryReader([]);
    const { readers, asked } = readersOver({ [DIRECTORY]: directory, "wss://PURPLEPAG.es/": directory });

    expect(await read(readers)).toEqual({ is: "none" });
    expect(asked).toHaveLength(2);
    expect(directory.requests).toHaveLength(1);
  });

  it("is not known, with no relay-list relay to ask, when no review relay sends one: nobody who would know was asked", async () => {
    config.relayListRelays = [];

    expect(await read(readersOver({}).readers)).toEqual({ is: "unknown" });
    expect(await read(readersOver({ [SEARCH]: createMemoryReader([relayList([[OWN]])]) }).readers)).toEqual(FOUND);
  });

  it("is not known when a relay-list relay is written as no address a relay has: it cannot answer", async () => {
    config.relayListRelays = [DIRECTORY, "not a relay"];

    expect(await read(readersOver({}).readers)).toEqual({ is: "unknown" });
  });

  it("uses the list one relay sent, though another never answers: it goes on once that one's time is up", async () => {
    const directory = createMemoryReader([relayList([[OWN]])]);
    const readers = (url: string) => (url === SEARCH ? stalled : directory);
    const ended = track(read(readers));

    await vi.advanceTimersByTimeAsync(WITHIN - 1);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(ended.list).toEqual(FOUND);
  });

  it("does not wait when every relay answers", async () => {
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([relayList([[OWN]])]) });

    expect(await read(readers)).toEqual(FOUND);
  });

  it("leaves out a relay that answers after its time, though its list is the newer", async () => {
    const older = relayList([["wss://old.example.com"]], { created_at: 1_700_000_000 });
    const newer = relayList([[OWN]], { created_at: 1_700_000_500 });
    const { readers } = readersOver({
      [SEARCH]: createMemoryReader([newer], { delayMs: WITHIN + 1 }),
      [DIRECTORY]: createMemoryReader([older]),
    });
    const ended = track(read(readers));

    await vi.advanceTimersByTimeAsync(WITHIN);

    expect(ended.list).toEqual({ is: "found", write: ["wss://old.example.com"], read: ["wss://old.example.com"] });
  });

  it("takes the list of a relay that answers just within its time", async () => {
    const { readers } = readersOver({ [SEARCH]: createMemoryReader([relayList([[OWN]])], { delayMs: WITHIN - 1 }) });
    const ended = track(read(readers));

    await vi.advanceTimersByTimeAsync(WITHIN - 1);

    expect(ended.list).toEqual(FOUND);
  });

  it("is not known when the relay-list relay answers after its time, though it would have said there is none", async () => {
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([], { delayMs: WITHIN + 1 }) });
    const ended = track(read(readers));

    await vi.advanceTimersByTimeAsync(WITHIN);

    expect(ended).toEqual({ list: { is: "unknown" } });
  });

  it("is not known when no relay answers in its time", async () => {
    const ended = track(read(() => stalled));

    await vi.advanceTimersByTimeAsync(WITHIN);

    expect(ended).toEqual({ list: { is: "unknown" } });
  });

  it("asks a relay to stop once its time is up", async () => {
    let stopped = false;
    const patient: RelayReader = {
      async *req(_filter, signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        stopped = signal.aborted;
      },
    };
    const ended = track(read(() => patient));

    await vi.advanceTimersByTimeAsync(WITHIN);

    expect(ended).toEqual({ list: { is: "unknown" } });
    expect(stopped).toBe(true);
  });

  it("throws the signal's reason when it aborts while a relay has not answered, at once", async () => {
    const stop = new AbortController();
    const ended = track(readRelayList(ALICE, () => stalled, stop.signal, WITHIN));

    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error("gone");
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(ended.error).toBe(reason);
  });

  it("still asks the search relay with include:spam, and no other relay that", async () => {
    const search = createMemoryReader([]);
    const directory = createMemoryReader([]);
    const { readers } = readersOver({ [SEARCH]: search, [DIRECTORY]: directory });

    await read(readers);

    expect(search.requests).toEqual([{ kinds: [10002], authors: [ALICE], limit: 1, search: "include:spam" }]);
    expect(directory.requests).toEqual([{ kinds: [10002], authors: [ALICE], limit: 1 }]);
  });

  it("only reads what it is handed as a person's own: another's list, and another kind, are no list of theirs", async () => {
    const strangers = [relayList([[OWN]], {}, BOB), shapedEvent({ kind: 3, pubkey: ALICE, tags: [["r", OWN]] })];
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader(strangers) });
    // A relay that sends what it likes, whatever it was asked.
    const loose = (url: string): RelayReader => ({
      async *req(_filter, signal) {
        yield* readers(url).req({}, signal);
      },
    });

    expect(await read(loose)).toEqual({ is: "none" });
  });
});

describe("writeRelaysOf: where a person's relay list is read", () => {
  it("asks the review relays and the directory for the person's newest relay list, the search relay with include:spam", async () => {
    config.reviewRelays = [SEARCH];
    const search = createMemoryReader([]);
    const directory = createMemoryReader([]);
    const { readers } = readersOver({ [SEARCH]: search, [DIRECTORY]: directory });

    await run(signerWith(), readers);

    expect(search.requests).toEqual([{ kinds: [10002], authors: [ALICE], limit: 1, search: "include:spam" }]);
    // The other relay is not given the search words: it would take them as words to look for.
    expect(directory.requests).toEqual([{ kinds: [10002], authors: [ALICE], limit: 1 }]);
  });

  it("reads each relay once, even when the directory is also a review relay", async () => {
    config.reviewRelays = [SEARCH, "wss://PURPLEPAG.es/"];
    const { readers, asked } = readersOver({});

    await run(signerWith(), readers);

    expect(asked.sort()).toEqual([SEARCH, "wss://PURPLEPAG.es/"].sort());
  });

  it("reads the relay-list relays the config names, in place of the directory when it names others", async () => {
    config.relayListRelays = ["wss://lists.example.test", "wss://LISTS.example.test/"];
    const lists = createMemoryReader([relayList([["wss://nos.lol"]])]);
    const { readers, asked } = readersOver({ "wss://lists.example.test": lists });

    expect(await run(signerWith(), readers)).toEqual(["wss://nos.lol"]);
    expect(asked).toEqual(["wss://lists.example.test"]);
  });

  it("reads the directory when no review relay is set", async () => {
    const directory = createMemoryReader([relayList([["wss://nos.lol"]])]);
    const { readers } = readersOver({ [DIRECTORY]: directory });

    expect(await run(signerWith(), readers)).toEqual(["wss://nos.lol"]);
  });
});

describe("writeRelaysOf: the relays a person writes to", () => {
  it("puts the review relays first, then the person's write and unmarked relays in their order", async () => {
    config.reviewRelays = [SEARCH];
    const list = relayList([
      ["wss://nos.lol"],
      ["wss://read-only.example.com", "read"],
      ["wss://relay.damus.io", "write"],
    ]);
    const { readers } = readersOver({ [SEARCH]: createMemoryReader([list]) });

    expect(await run(signerWith(), readers)).toEqual([SEARCH, "wss://nos.lol", "wss://relay.damus.io"]);
  });

  it("takes only the person's own list, and only a kind 10002", async () => {
    const bobs = relayList([["wss://bobs.example.com"]], { created_at: 1_700_000_900 }, BOB);
    const notAList = shapedEvent({ kind: 3, pubkey: ALICE, created_at: 1_700_000_900, tags: [["r", "wss://not-a-list.example.com"]] });
    const mine = relayList([["wss://mine.example.com"]]);
    // A relay that sends what it likes, whatever it was asked for.
    const reader: RelayReader = {
      async *req() {
        yield bobs;
        yield notAList;
        yield mine;
      },
    };

    expect(await run(signerWith(), () => reader)).toEqual(["wss://mine.example.com"]);
  });

  it("passes over events that are not shaped like events, and tags that are not relay entries", async () => {
    const odd = relayList([["wss://ok.example.com"]]);
    odd.tags.push(["p", ALICE], ["r"], ["relay", "wss://wrong-tag.example.com"], ["r", "wss://marker.example.com", "elsewhere"]);
    const reader: RelayReader = {
      async *req() {
        yield { nonsense: true } as unknown as NostrEvent;
        yield odd;
      },
    };

    expect(await run(signerWith(), () => reader)).toEqual(["wss://ok.example.com"]);
  });

  it("follows the newest list, whichever relay it came from", async () => {
    const older = relayList([["wss://old.example.com"]], { created_at: 1_700_000_000 });
    const newer = relayList([["wss://new.example.com"]], { created_at: 1_700_000_500 });
    config.reviewRelays = [SEARCH];
    const { readers } = readersOver({
      [SEARCH]: createMemoryReader([older]),
      [DIRECTORY]: createMemoryReader([newer]),
    });

    expect(await run(signerWith(), readers)).toEqual([SEARCH, "wss://new.example.com"]);
  });

  it("keeps the newest list of one relay that sends more than one", async () => {
    const older = relayList([["wss://old.example.com"]], { created_at: 1_700_000_000 });
    const newer = relayList([["wss://new.example.com"]], { created_at: 1_700_000_500 });
    const reader: RelayReader = {
      async *req() {
        yield newer;
        yield older;
      },
    };

    expect(await run(signerWith(), () => reader)).toEqual(["wss://new.example.com"]);
  });

  it("takes the lowest id when two lists are of the same second", async () => {
    const first = relayList([["wss://first.example.com"]], { id: hex64("1") });
    const second = relayList([["wss://second.example.com"]], { id: hex64("2") });
    config.reviewRelays = [SEARCH];
    const { readers } = readersOver({
      [SEARCH]: createMemoryReader([second]),
      [DIRECTORY]: createMemoryReader([first]),
    });

    expect(await run(signerWith(), readers)).toEqual([SEARCH, "wss://first.example.com"]);
  });

  it("uses what answers, and takes a relay that fails for one with nothing", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = readersOver({
      [SEARCH]: createMemoryReader([], { failWith: new Error("socket closed") }),
      [DIRECTORY]: createMemoryReader([relayList([["wss://nos.lol"]])]),
    });

    expect(await run(signerWith(), readers)).toEqual([SEARCH, "wss://nos.lol"]);
  });

  it("takes a reader that cannot be made for a relay that fails", async () => {
    const list = relayList([["wss://nos.lol"]]);
    const readers = (url: string): RelayReader => {
      if (url === DIRECTORY) return createMemoryReader([list]);
      throw new Error("no reader for this one");
    };
    config.reviewRelays = [SEARCH];

    expect(await run(signerWith(), readers)).toEqual([SEARCH, "wss://nos.lol"]);
  });

  it("does not read the signer's relays when a list was found, even one with no relay to write to", async () => {
    const getRelays = reports({ "wss://from-signer.example.com": { read: true, write: true } });
    const readOnly = relayList([["wss://read.example.com", "read"]]);
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([readOnly]) });
    config.reviewRelays = [SEARCH];

    expect(await run(signerWith(getRelays), readers)).toEqual([SEARCH]);
    expect(getRelays).not.toHaveBeenCalled();
  });
});

describe("writeRelaysOf: when the person has no relay list", () => {
  it("asks the signer, and takes its relays that are written to", async () => {
    config.reviewRelays = [SEARCH];
    const getRelays = reports({
      "wss://writes.example.com": { read: false, write: true },
      "wss://both.example.com": { read: true, write: true },
      "wss://reads.example.com": { read: true, write: false },
    });
    const { readers } = readersOver({});

    expect(await run(signerWith(getRelays), readers)).toEqual([SEARCH, "wss://writes.example.com", "wss://both.example.com"]);
    expect(getRelays).toHaveBeenCalledTimes(1);
  });

  it("asks the signer when every relay failed to answer", async () => {
    config.reviewRelays = [SEARCH];
    const failing = () => createMemoryReader([], { failWith: new Error("down") });
    const { readers } = readersOver({ [SEARCH]: failing(), [DIRECTORY]: failing() });
    const getRelays = reports({ "wss://writes.example.com": { read: false, write: true } });

    expect(await run(signerWith(getRelays), readers)).toEqual([SEARCH, "wss://writes.example.com"]);
  });

  it("gives the review relays alone when the signer has no way to say", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = readersOver({});

    expect(await run(signerWith(), readers)).toEqual([SEARCH]);
  });

  it("gives the review relays alone when the signer fails or answers with nonsense", async () => {
    config.reviewRelays = [SEARCH];
    const { readers } = readersOver({});
    const throwsNow: NostrSigner["getRelays"] = () => {
      throw new Error("not allowed");
    };
    const rejects: NostrSigner["getRelays"] = () => Promise.reject(new Error("the user said no"));
    const nonsense = [null, "relays", 7, [], { "wss://a.example.com": null, "wss://b.example.com": "yes", "wss://c.example.com": { write: "true" } }];

    expect(await run(signerWith(throwsNow), readers)).toEqual([SEARCH]);
    expect(await run(signerWith(rejects), readers)).toEqual([SEARCH]);
    for (const answer of nonsense) {
      expect(await run(signerWith(async () => answer as never), readers)).toEqual([SEARCH]);
    }
  });
});

describe("writeRelaysOf: merging", () => {
  it("counts a relay once, however it is written, and keeps the first place it had", async () => {
    config.reviewRelays = [SEARCH];
    const list = relayList([
      ["WSS://Search.Brainstorm.World/"],
      ["wss://Relay.Example.com/"],
      ["wss://relay.example.com"],
      ["wss://relay.example.com/"],
      ["wss://relay.example.com./"],
      ["wss://relay.example.com..."],
      ["wss://Search.Brainstorm.World.."],
      ["wss://relay.example.com:443"],
      ["wss://relay.example.com/ws/"],
      ["wss://relay.example.com/WS"],
    ]);
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([list]) });

    expect(await run(signerWith(), readers)).toEqual([
      SEARCH,
      "wss://relay.example.com",
      "wss://relay.example.com/ws",
      "wss://relay.example.com/WS",
    ]);
  });

  it("gives at most six, the review relays among them and first", async () => {
    config.reviewRelays = [SEARCH];
    const list = relayList(Array.from({ length: 10 }, (_, n) => [`wss://relay${n}.example.com`]));
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([list]) });

    const relays = await run(signerWith(), readers);

    expect(relays).toHaveLength(6);
    expect(relays).toEqual([
      SEARCH,
      "wss://relay0.example.com",
      "wss://relay1.example.com",
      "wss://relay2.example.com",
      "wss://relay3.example.com",
      "wss://relay4.example.com",
    ]);
  });

  it("gives at most six of the signer's too", async () => {
    config.reviewRelays = [SEARCH];
    const getRelays = reports(
      Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`wss://signer${n}.example.com`, { read: true, write: true }])),
    );
    const { readers } = readersOver({});

    const relays = await run(signerWith(getRelays), readers);

    expect(relays).toHaveLength(6);
    expect(relays[0]).toBe(SEARCH);
  });

  it("counts a bad relay in the list for nothing, so the good ones after it are not crowded out", async () => {
    const list = relayList([
      ...Array.from({ length: 8 }, (_, n) => [`ws://plain${n}.example.com`]),
      ["wss://good.example.com"],
    ]);
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([list]) });

    expect(await run(signerWith(), readers)).toEqual(["wss://good.example.com"]);
  });

  it("keeps the review relays the app is set up with, even a plain one on this machine in development", async () => {
    config.reviewRelays = ["ws://localhost:7777", SEARCH];
    const { readers } = readersOver({});

    expect(await run(signerWith(), readers)).toEqual(["ws://localhost:7777", SEARCH]);
  });
});

describe("writeRelaysOf: relays that are left out", () => {
  const BAD = [
    // Not wss:
    "ws://relay.example.com",
    "http://relay.example.com",
    "https://relay.example.com",
    "ftp://relay.example.com",
    "relay.example.com",
    "wss:relay.example.com",
    "javascript:alert(1)",
    "data:text/plain,hello",
    // Unparseable
    "",
    "   ",
    "wss://",
    "wss://exa mple.com",
    // Carrying a password
    "wss://user:secret@relay.example.com",
    "wss://user@relay.example.com",
    // This machine
    "wss://localhost",
    "wss://LOCALHOST:7777",
    "wss://localhost.",
    "wss://relay.localhost",
    "wss://127.0.0.1",
    "wss://127.8.9.10:4000",
    "wss://2130706433",
    "wss://0x7f.1",
    "wss://0.0.0.0",
    "wss://[::1]",
    "wss://[::1]:8080",
    "wss://[::]",
    "wss://[::ffff:127.0.0.1]",
    // The local network
    "wss://10.0.0.5",
    "wss://10.255.255.255",
    "wss://192.168.1.1",
    "wss://192.168.0.200:7777",
    "wss://172.16.0.1",
    "wss://172.20.4.4",
    "wss://172.31.255.255",
    "wss://169.254.169.254",
    "wss://100.64.0.1",
    "wss://[fc00::1]",
    "wss://[fd12:3456::1]",
    "wss://[fe80::1]",
    "wss://printer.local",
    "wss://printer.LOCAL.",
    "wss://abcdefghij234567.onion",
    "wss://intranet",
    // The same, with more than one dot at the end: URL keeps them all, and a name with them is not a number
    "wss://127.0.0.1..",
    "wss://127.0.0.1...",
    "wss://localhost..",
    "wss://10.0.0.5..",
    "wss://192.168.1.1...",
    "wss://172.16.0.1..",
    "wss://0x7f.1..",
    "wss://printer.local..",
    "wss://abc.onion..",
    "wss://intranet..",
    "wss://.",
    "wss://..",
    // Names the machine gives itself
    "wss://localhost.localdomain",
    "wss://machine.localdomain.",
    // Addresses no relay is reached at: multicast, reserved, and the range kept for benchmarks
    "wss://224.0.0.1",
    "wss://239.255.255.250",
    "wss://240.0.0.1",
    "wss://255.255.255.255",
    "wss://198.18.0.1",
    "wss://198.19.255.255",
    // IPv6 that is a private IPv4 or this machine in another form
    "wss://[::2]",
    "wss://[::7f00:1]",
    "wss://[::127.0.0.1]",
    "wss://[0:0:0:0:0:0:0:1]",
    "wss://[::ffff:10.0.0.1]",
    "wss://[64:ff9b::7f00:1]",
    "wss://[64:ff9b::127.0.0.1]",
    "wss://[64:ff9b::a00:5]",
    "wss://[64:ff9b:1::1]",
    "wss://[2002:7f00:1::]",
    "wss://[2002:c0a8:101::1]",
    // IPv6 private ranges, at both ends of each
    "wss://[fc00::1]",
    "wss://[fdff:ffff::1]",
    "wss://[fe80::1]",
    "wss://[febf::1]",
    "wss://[fec0::1]",
    "wss://[feff::1]",
    "wss://[ff02::1]",
  ];

  it.each(BAD)("drops %j", async (bad) => {
    const list = relayList([[bad], ["wss://good.example.com"]]);
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([list]) });

    expect(await run(signerWith(), readers)).toEqual(["wss://good.example.com"]);
  });

  it.each([
    "wss://172.15.0.1",
    "wss://172.32.0.1",
    "wss://11.0.0.1",
    "wss://192.169.0.1",
    "wss://100.128.0.1",
    "wss://198.17.0.1",
    "wss://198.20.0.1",
    "wss://223.255.255.255",
    "wss://8.8.8.8",
    "wss://localhost.example.com",
    "wss://notlocal.com",
    "wss://mylocal.localdomain.example.com",
    // Short groups that only begin like a private range: fc and fe8 are not fc00 and fe80
    "wss://[fc::1]",
    "wss://[fe8::1]",
    "wss://[fe7f::1]",
    "wss://[fb00::1]",
    "wss://[2606:4700:4700::1111]",
    "wss://[64:ff9b::808:808]",
    "wss://[2002:808:808::1]",
  ])(
    "keeps %j: it is not on a private network",
    async (good) => {
      const list = relayList([[good]]);
      const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([list]) });

      expect(await run(signerWith(), readers)).toEqual([good]);
    },
  );

  it("drops them from the signer's relays too", async () => {
    const getRelays = reports({
      "ws://plain.example.com": { read: true, write: true },
      "wss://192.168.1.20": { read: true, write: true },
      "wss://good.example.com": { read: true, write: true },
    });
    const { readers } = readersOver({});

    expect(await run(signerWith(getRelays), readers)).toEqual(["wss://good.example.com"]);
  });

  it("writes the same relay one way, however many dots end its name", async () => {
    for (const written of ["wss://example.com", "wss://example.com.", "wss://example.com..", "wss://EXAMPLE.com.../"]) {
      const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([relayList([[written]])]) });
      expect(await run(signerWith(), readers)).toEqual(["wss://example.com"]);
    }
  });

  it("gives back only addresses that pass the same check again", async () => {
    // Whatever is sent out, read as an address, is not private: checking the address as written would not see "127.0.0.1.." as 127.0.0.1.
    const list = relayList([["wss://127.0.0.1.."], ["wss://0x7f.1.."], ["wss://example.com.."], ["wss://[2002:808:808::1]"]]);
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([list]) });

    const sent = await run(signerWith(), readers);
    expect(sent).toEqual(["wss://example.com", "wss://[2002:808:808::1]"]);
    const again = relayList(sent.map((url) => [url]));
    const { readers: second } = readersOver({ [DIRECTORY]: createMemoryReader([again]) });
    expect(await run(signerWith(), second)).toEqual(sent);
  });

  it("drops the address and the query a relay entry carries", async () => {
    const list = relayList([["wss://relay.example.com/inbox?token=abc#top"]]);
    const { readers } = readersOver({ [DIRECTORY]: createMemoryReader([list]) });

    expect(await run(signerWith(), readers)).toEqual(["wss://relay.example.com/inbox"]);
  });
});

describe("writeRelaysOf: stopping", () => {
  it("rejects with the signal's reason when it is already aborted, and asks nothing", async () => {
    const reason = new Error("left the page");
    const { readers, asked } = readersOver({});
    const getRelays = reports({});

    await expect(run(signerWith(getRelays), readers, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(asked).toEqual([]);
    expect(getRelays).not.toHaveBeenCalled();
  });

  it("rejects with the signal's reason when it aborts while the relays are being read", async () => {
    const reason = new Error("left the page");
    const slow = createMemoryReader([relayList([["wss://nos.lol"]])], { delayMs: 60_000 });
    const { readers } = readersOver({ [DIRECTORY]: slow });
    const controller = new AbortController();

    const result = run(signerWith(), readers, controller.signal);
    await vi.waitFor(() => expect(slow.requests).toHaveLength(1));
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it("rejects with the signal's reason, not an empty answer, when every read ended because of the abort", async () => {
    const reason = new DOMException("Aborted", "AbortError");
    const getRelays = reports({ "wss://writes.example.com": { read: false, write: true } });
    const slow = () => createMemoryReader([], { delayMs: 60_000 });
    const { readers } = readersOver({ [SEARCH]: slow(), [DIRECTORY]: slow() });
    config.reviewRelays = [SEARCH];
    const controller = new AbortController();

    const result = run(signerWith(getRelays), readers, controller.signal);
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(getRelays).not.toHaveBeenCalled();
  });

  it("rejects with the signal's reason when it aborts while the signer has not answered", async () => {
    const reason = new Error("left the page");
    const getRelays = vi.fn(() => new Promise<never>(() => {}));
    const { readers } = readersOver({});
    const controller = new AbortController();

    const result = run(signerWith(getRelays), readers, controller.signal);
    await vi.waitFor(() => expect(getRelays).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });
});
