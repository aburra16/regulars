import type { NostrEvent } from "@nostrify/nostrify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import {
  AGREE_MIN,
  COPY_AHEAD_S,
  COPY_NOT_BEFORE_S,
  FOLLOW_READ_MS,
  MAX_FOLLOW_RELAYS,
  type OwnListRead,
  accountShowsUse,
  copyToAsk,
  enoughAnswered,
  followRelaysWith,
  newListQuorum,
  readFollowList,
  readOwnList,
  reviewRelaysBeside,
} from "../src/follow/read";
import type { RelayReader } from "../src/nostr/events";
import { hex64, shapedEvent } from "./support/events";
import { createMemoryReader } from "./support/memoryReader";

/*
 * Reading a person's follow list from several relays, and telling an account that has been used from
 * a new one. Nothing here writes. Relays are held in memory (tests/support/memoryReader.ts) and the
 * clock is fake, so that a relay that never answers costs no time.
 */

const SEARCH = "wss://search.brainstorm.world";
const DIRECTORY = "wss://purplepag.es";
const A = "wss://a.example.com";
const B = "wss://b.example.com";
const C = "wss://c.example.com";

const ALICE = hex64("a");
const BOB = hex64("b");
const CAROL = hex64("c");

/** A follow list by `pubkey` (Alice unless said), naming `follows`. */
const list = (follows: string[], fields: Partial<NostrEvent> = {}, pubkey = ALICE) =>
  shapedEvent({ kind: 3, pubkey, tags: follows.map((key) => ["p", key]), ...fields });

/** Alice's relay list (kind 10002): each entry is `[url]`, `[url, "read"]` or `[url, "write"]`. */
const relayList = (entries: string[][]) => shapedEvent({ kind: 10002, pubkey: ALICE, tags: entries.map((entry) => ["r", ...entry]) });

const profile = (pubkey = ALICE) => shapedEvent({ kind: 0, pubkey, content: "{}" });

/** Readers by relay URL: a relay that is not in `held` holds nothing. */
function readersOver(held: Record<string, RelayReader>): (url: string) => RelayReader {
  return (url) => held[url] ?? createMemoryReader([]);
}

/** A relay that never answers, and takes no notice of the signal. */
const silent: RelayReader = {
  async *req() {
    await new Promise<never>(() => {});
  },
};

/** `reader`, except that it fails for a request that asks for `kind`. */
const failingFor = (kind: number, reader: RelayReader): RelayReader => ({
  async *req(filter, signal) {
    if (filter.kinds?.includes(kind)) throw new Error("this relay does not take that");
    yield* reader.req(filter, signal);
  },
});

const run = (relays: string[], readers: (url: string) => RelayReader, signal = new AbortController().signal) =>
  readFollowList(ALICE, relays, readers, signal);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readFollowList", () => {
  it("returns the newest list when one relay holds an older one and another a newer, and counts both as answered", async () => {
    const older = list([BOB], { created_at: 1_700_000_000 });
    const newer = list([BOB, CAROL], { created_at: 1_700_000_500 });
    const readers = readersOver({ [A]: createMemoryReader([older]), [B]: createMemoryReader([newer]) });

    const read = await run([A, B], readers);

    expect(read.list).toEqual(newer);
    expect(read.answered).toEqual([A, B]);
    // Whichever relay it is asked of first.
    expect((await run([B, A], readers)).list).toEqual(newer);
  });

  it("takes the lowest id when two lists are of the same second", async () => {
    const first = list([BOB], { id: hex64("1") });
    const second = list([CAROL], { id: hex64("2") });
    const readers = readersOver({ [A]: createMemoryReader([second]), [B]: createMemoryReader([first]) });

    expect((await run([A, B], readers)).list).toEqual(first);
  });

  it("asks each relay for the person's newest kind 3 and no more", async () => {
    const a = createMemoryReader([]);
    await run([A], readersOver({ [A]: a }));

    expect(a.requests).toEqual([{ kinds: [3], authors: [ALICE], limit: 1 }]);
  });

  it("asks a relay once when it is named more than once, and counts it once among those that answered, at its first place", async () => {
    const mine = list([BOB]);
    const a = createMemoryReader([mine]);
    const b = createMemoryReader([]);

    const read = await run([A, B, A, B, A], readersOver({ [A]: a, [B]: b }));

    expect(a.requests).toEqual([{ kinds: [3], authors: [ALICE], limit: 1 }]);
    expect(b.requests).toHaveLength(1);
    expect(read).toEqual({ list: mine, answered: [A, B] });
    // A relay named twice that fails is left out once, too.
    const down = createMemoryReader([], { failWith: new Error("down") });
    expect(await run([B, C, C, B], readersOver({ [B]: createMemoryReader([mine]), [C]: down }))).toEqual({ list: mine, answered: [B] });
    expect(down.requests).toHaveLength(1);
  });

  it("leaves a relay that fails out of those that answered, and the others still count", async () => {
    const mine = list([BOB]);
    const readers = readersOver({
      [A]: createMemoryReader([], { failWith: new Error("socket closed") }),
      [B]: createMemoryReader([mine]),
      [C]: createMemoryReader([]),
    });

    const read = await run([A, B, C], readers);

    expect(read.list).toEqual(mine);
    expect(read.answered).toEqual([B, C]);
  });

  it("leaves a reader that cannot be made out of those that answered", async () => {
    const mine = list([BOB]);
    const readers = (url: string): RelayReader => {
      if (url === A) throw new Error("no reader for this one");
      return createMemoryReader([mine]);
    };

    expect(await run([A, B], readers)).toEqual({ list: mine, answered: [B] });
  });

  it("leaves a relay that does not answer within FOLLOW_READ_MS out, however it treats the signal, and goes on with the others", async () => {
    const mine = list([BOB]);
    const waiting = createMemoryReader([], { delayMs: 10 * FOLLOW_READ_MS });
    const readers = readersOver({ [A]: silent, [B]: waiting, [C]: createMemoryReader([mine]) });

    const reading = run([A, B, C], readers);
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

    expect(await reading).toEqual({ list: mine, answered: [C] });
  });

  it("counts a relay that answers just within its time, and does not give the others longer", async () => {
    const mine = list([BOB]);
    const readers = readersOver({
      [A]: createMemoryReader([mine], { delayMs: FOLLOW_READ_MS - 1 }),
      [B]: silent,
    });

    const reading = run([A, B], readers);
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

    expect(await reading).toEqual({ list: mine, answered: [A] });
  });

  it("stops asking a relay whose time is up", async () => {
    let aborted = false;
    const patient: RelayReader = {
      async *req(_filter, signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted = signal.aborted;
      },
    };

    const reading = run([A], readersOver({ [A]: patient }));
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);
    await reading;

    expect(aborted).toBe(true);
  });

  it("finds no list and no relay that answered when none answers", async () => {
    const readers = readersOver({
      [A]: createMemoryReader([], { failWith: new Error("down") }),
      [B]: silent,
    });

    const reading = run([A, B], readers);
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

    expect(await reading).toEqual({ list: null, answered: [] });
    expect(await run([], readers)).toEqual({ list: null, answered: [] });
  });

  it("counts a relay that answers with no list as answered", async () => {
    expect(await run([A], readersOver({}))).toEqual({ list: null, answered: [A] });
  });

  it("ignores a list by another author and events of another kind, whatever the relay was asked", async () => {
    const mine = list([BOB], { created_at: 1_700_000_000 });
    const strangers = list([BOB, CAROL], { created_at: 1_700_000_900 }, BOB);
    const notAList = shapedEvent({ kind: 10002, pubkey: ALICE, created_at: 1_700_000_900, tags: [["p", CAROL]] });
    // A relay that sends what it likes.
    const reader: RelayReader = {
      async *req() {
        yield strangers;
        yield notAList;
        yield { nonsense: true } as unknown as NostrEvent;
        yield mine;
      },
    };

    expect(await run([A], () => reader)).toEqual({ list: mine, answered: [A] });
  });

  it("finds no list when the relays hold only other people's", async () => {
    const readers = readersOver({ [A]: createMemoryReader([list([CAROL], {}, BOB)]) });

    expect(await run([A], readers)).toEqual({ list: null, answered: [A] });
  });

  it("asks the search relay for what it takes for spam too, and no other relay that", async () => {
    config.relayReadExtras = { [SEARCH]: { search: "include:spam" } };
    const search = createMemoryReader([]);
    const other = createMemoryReader([]);

    await run([SEARCH, A], readersOver({ [SEARCH]: search, [A]: other }));

    expect(search.requests).toEqual([{ kinds: [3], authors: [ALICE], limit: 1, search: "include:spam" }]);
    expect(other.requests).toEqual([{ kinds: [3], authors: [ALICE], limit: 1 }]);
  });

  it("throws the signal's reason when it aborts, not an empty answer", async () => {
    const stop = new AbortController();
    const reading = run([A], readersOver({ [A]: silent }), stop.signal);
    stop.abort(new Error("signed out"));

    await expect(reading).rejects.toThrow("signed out");
  });
});

describe("accountShowsUse", () => {
  const ask = (relays: string[], readers: (url: string) => RelayReader, signal = new AbortController().signal) =>
    accountShowsUse(ALICE, relays, readers, signal);

  it("asks each relay for a profile by the account and for one list that names it", async () => {
    const a = createMemoryReader([]);
    await ask([A], readersOver({ [A]: a }));

    expect(a.requests).toHaveLength(2);
    expect(a.requests).toContainEqual({ kinds: [0], authors: [ALICE], limit: 1 });
    expect(a.requests).toContainEqual({ kinds: [3], "#p": [ALICE], limit: 1 });
  });

  it("is true when there is a profile and nobody follows the account", async () => {
    expect(await ask([A], readersOver({ [A]: createMemoryReader([profile()]) }))).toBe(true);
  });

  it("is true when someone follows the account and it has no profile", async () => {
    const follower = list([ALICE], {}, BOB);
    expect(await ask([A], readersOver({ [A]: createMemoryReader([follower]) }))).toBe(true);
  });

  it("is false when there is neither, though the relay holds other people's profiles and lists", async () => {
    const readers = readersOver({
      [A]: createMemoryReader([profile(BOB), list([CAROL], {}, BOB), list([BOB], {}, CAROL)]),
    });

    expect(await ask([A], readers)).toBe(false);
  });

  it("is false when a relay answers both questions with nothing, and another fails", async () => {
    const readers = readersOver({ [A]: createMemoryReader([], { failWith: new Error("down") }) });

    expect(await ask([A, B], readers)).toBe(false);
  });

  it("is true on a sign at any relay, though the others fail or never answer", async () => {
    const readers = readersOver({
      [A]: createMemoryReader([], { failWith: new Error("down") }),
      [B]: silent,
      [C]: createMemoryReader([profile()]),
    });

    const asking = ask([A, B, C], readers);
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

    expect(await asking).toBe(true);
  });

  describe("once a sign is found", () => {
    /** Lets everything that can go on without the clock go on. No timer runs: the fake clock is not moved. */
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

    /** A relay that answers nothing until it is told to stop, and notes each time it was: `stopped` counts them. */
    function waiting() {
      const state = { asked: 0, stopped: 0 };
      const reader: RelayReader = {
        async *req(_filter, signal) {
          state.asked += 1;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          state.stopped += 1;
          signal.throwIfAborted();
        },
      };
      return { reader, state };
    }

    it.each([
      ["a profile", () => profile()],
      ["a list by someone that names the account", () => list([ALICE], {}, BOB)],
    ])("answers that the account has been used at once, on %s, without waiting for the relays that have not answered, and stops asking them", async (_, sign) => {
      const slow = waiting();
      const slower = waiting();
      const readers = readersOver({ [A]: slow.reader, [B]: createMemoryReader([sign()]), [C]: slower.reader });
      let answer: boolean | undefined;
      void accountShowsUse(ALICE, [A, B, C], readers, new AbortController().signal, 3).then((used) => {
        answer = used;
      });

      await turn();

      // Not one timer was moved: the relays' time is not waited out.
      expect(answer).toBe(true);
      // Both questions of each relay still asked were stopped, and nothing of the asking is left running.
      expect(slow.state).toEqual({ asked: 2, stopped: 2 });
      expect(slower.state).toEqual({ asked: 2, stopped: 2 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("answers at once on a sign from a relay asked besides, too", async () => {
      const slow = waiting();
      const readers = readersOver({ [A]: slow.reader, [SEARCH]: createMemoryReader([profile()]) });
      let answer: boolean | undefined;
      void accountShowsUse(ALICE, [A, B, C], readers, new AbortController().signal, 3, [SEARCH]).then((used) => {
        answer = used;
      });

      await turn();

      expect(answer).toBe(true);
      expect(slow.state.stopped).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not stop the caller's own signal: only its own reads", async () => {
      const stop = new AbortController();
      const readers = readersOver({ [A]: waiting().reader, [B]: createMemoryReader([profile()]) });
      let answer: boolean | undefined;
      void accountShowsUse(ALICE, [A, B], readers, stop.signal).then((used) => {
        answer = used;
      });

      await turn();

      expect(answer).toBe(true);
      expect(stop.signal.aborted).toBe(false);
    });

    it("still waits for every relay before it says no: a relay that has not answered may be the one with the sign", async () => {
      const slow = waiting();
      const readers = readersOver({ [A]: slow.reader });
      let outcome: boolean | "threw" | undefined;
      accountShowsUse(ALICE, [A, B, C], readers, new AbortController().signal, 2).then(
        (used) => (outcome = used),
        () => (outcome = "threw"),
      );

      await turn();
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

      // Two answered both questions with nothing, which is as many as were asked for.
      expect(outcome).toBe(false);
    });
  });

  it("takes a sign from the one question a relay answers, though it fails the other", async () => {
    const readers = readersOver({ [A]: failingFor(3, createMemoryReader([profile()])) });

    expect(await ask([A], readers)).toBe(true);
  });

  it("does not take a relay that answers only one of the two questions for a no", async () => {
    const readers = readersOver({ [A]: failingFor(3, createMemoryReader([])), [B]: failingFor(0, createMemoryReader([])) });

    await expect(ask([A, B], readers)).rejects.toThrow();
  });

  it("throws when no relay answers", async () => {
    const readers = readersOver({ [A]: createMemoryReader([], { failWith: new Error("down") }), [B]: silent });

    const asking = ask([A, B], readers);
    const outcome = expect(asking).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);
    await outcome;

    await expect(ask([], readersOver({}))).rejects.toThrow();
  });

  it("takes only a profile by the account and a list that names it, whatever a relay sends", async () => {
    const strangers = [
      profile(BOB),
      list([CAROL], {}, BOB),
      // A kind that names the account in a `p` tag, but is not a follow list.
      shapedEvent({ kind: 10002, pubkey: BOB, tags: [["p", ALICE]] }),
      // A list whose `p` tag is something else.
      shapedEvent({ kind: 3, pubkey: BOB, tags: [["e", ALICE], ["p"], ["p", BOB]] }),
      { nonsense: true } as unknown as NostrEvent,
    ];
    const reader: RelayReader = {
      async *req() {
        yield* strangers as NostrEvent[];
      },
    };

    expect(await ask([A], () => reader)).toBe(false);
  });

  it("throws the signal's reason when it aborts", async () => {
    const stop = new AbortController();
    const asking = ask([A], readersOver({ [A]: silent }), stop.signal);
    stop.abort(new Error("signed out"));

    await expect(asking).rejects.toThrow("signed out");
  });

  describe("asked for a no that several relays stand behind (ruling R7)", () => {
    const atLeast = (count: number, relays: string[], readers: (url: string) => RelayReader) =>
      accountShowsUse(ALICE, relays, readers, new AbortController().signal, count);
    const down = () => createMemoryReader([], { failWith: new Error("down") });

    it("is false when that many relays answered both questions with nothing", async () => {
      expect(await atLeast(3, [A, B, C], readersOver({}))).toBe(false);
    });

    it("throws when one fewer did: two relays' nothing is not three's", async () => {
      await expect(atLeast(3, [A, B, C], readersOver({ [C]: down() }))).rejects.toThrow();
      await expect(atLeast(3, [A, B], readersOver({}))).rejects.toThrow();
      // The same two are enough when two are asked for.
      expect(await atLeast(2, [A, B, C], readersOver({ [C]: down() }))).toBe(false);
    });

    it("does not count a relay that answered only one of the two questions", async () => {
      const readers = readersOver({ [C]: failingFor(3, createMemoryReader([])) });

      await expect(atLeast(3, [A, B, C], readers)).rejects.toThrow();
    });

    it("is true on one relay's sign, however few answered", async () => {
      const readers = readersOver({ [A]: createMemoryReader([profile()]), [B]: down(), [C]: down() });

      expect(await atLeast(3, [A, B, C], readers)).toBe(true);
    });
  });

  describe("with relays that are asked besides, which keep profiles and no follow lists (ruling R12)", () => {
    const besides = (count: number, relays: string[], others: string[], readers: (url: string) => RelayReader) =>
      accountShowsUse(ALICE, relays, readers, new AbortController().signal, count, others);

    it("is true on a sign one of them has, though the others show none", async () => {
      const readers = readersOver({ [SEARCH]: createMemoryReader([profile()]) });

      expect(await besides(3, [A, B, C], [SEARCH], readers)).toBe(true);
    });

    it("asks them the same two questions", async () => {
      const search = createMemoryReader([]);
      await besides(1, [A], [SEARCH], readersOver({ [SEARCH]: search }));

      expect(search.requests).toHaveLength(2);
      expect(search.requests).toContainEqual({ kinds: [0], authors: [ALICE], limit: 1, search: "include:spam" });
      expect(search.requests).toContainEqual({ kinds: [3], "#p": [ALICE], limit: 1, search: "include:spam" });
    });

    it("does not count their nothing towards a no: two relays and one of them are not three", async () => {
      const readers = readersOver({ [C]: createMemoryReader([], { failWith: new Error("down") }) });

      await expect(besides(3, [A, B, C], [SEARCH], readers)).rejects.toThrow();
      // With no relay of the first kind, there is no no at all.
      await expect(besides(1, [], [SEARCH], readers)).rejects.toThrow();
    });

    it("is false all the same when one of them fails, and enough of the others answered", async () => {
      const readers = readersOver({ [SEARCH]: createMemoryReader([], { failWith: new Error("down") }) });

      expect(await besides(3, [A, B, C], [SEARCH], readers)).toBe(false);
    });
  });
});

describe("newListQuorum: how many of the app's follow-list relays must answer before their nothing is believed (ruling R16)", () => {
  it.each([
    [4, 3],
    [6, 4],
    [3, 3],
    [5, 3],
    [7, 4],
    [8, 5],
    [16, 9],
  ])("of %i relays, %i: more than half, and no fewer than three", (relays, quorum) => {
    expect(newListQuorum(relays)).toBe(quorum);
    expect(quorum).toBeGreaterThan(relays / 2);
  });

  it.each([0, 1, 2])("of %i relays, three: more than there are, so it is never met", (relays) => {
    expect(newListQuorum(relays)).toBe(3);
  });
});

describe("enoughAnswered: whether enough of the app's follow-list relays answered a read for their nothing to be believed", () => {
  const SIX = [DIRECTORY, "wss://nos.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nostr.mom", "wss://nostr.oxtr.dev"];

  it("is so when more than half of them answered, and no fewer than three: four of six, three of three", () => {
    config.followListRelays = [...SIX];
    expect(enoughAnswered(SIX.slice(0, 4))).toBe(true);
    expect(enoughAnswered(SIX.slice(0, 3))).toBe(false);
    expect(enoughAnswered(SIX)).toBe(true);

    config.followListRelays = SIX.slice(0, 3);
    expect(enoughAnswered(SIX.slice(0, 3))).toBe(true);
    expect(enoughAnswered(SIX.slice(0, 2))).toBe(false);
  });

  it("counts only the app's own: a person's relays that answered do not make up the number", () => {
    config.followListRelays = [...SIX];

    expect(enoughAnswered([A, B, C, ...SIX.slice(0, 3)])).toBe(false);
    expect(enoughAnswered([A, ...SIX.slice(0, 4)])).toBe(true);
  });

  it("counts a relay as the app is set up with it, however its address is written there, and never with fewer than three", () => {
    config.followListRelays = ["wss://NOS.lol/", DIRECTORY, "wss://relay.primal.net"];
    expect(enoughAnswered(["wss://nos.lol", DIRECTORY, "wss://relay.primal.net"])).toBe(true);

    config.followListRelays = [DIRECTORY, "wss://nos.lol"];
    expect(enoughAnswered([DIRECTORY, "wss://nos.lol"])).toBe(false);
    config.followListRelays = [];
    expect(enoughAnswered([])).toBe(false);
  });
});

describe("reviewRelaysBeside", () => {
  it("gives the review relays that are not among a person's follow relays, each once, as addresses", () => {
    config.reviewRelays = [SEARCH, "wss://NOS.lol/", "wss://search.brainstorm.world/", "wss://reviews.example.com"];

    expect(reviewRelaysBeside([A, "wss://nos.lol"])).toEqual([SEARCH, "wss://reviews.example.com"]);
    expect(reviewRelaysBeside([SEARCH, "wss://nos.lol", "wss://reviews.example.com"])).toEqual([]);
  });

  it("gives none when there are no review relays", () => {
    expect(reviewRelaysBeside([A])).toEqual([]);
  });
});

describe("readOwnList: where a person's own list is read", () => {
  /** The relays the whole read of Alice's own list read her list from. */
  const find = async (readers: (url: string) => RelayReader, signal = new AbortController().signal) =>
    (await readOwnList(ALICE, readers, signal)).relays;
  const directoryHolds = (...entries: string[][]) => readersOver({ [DIRECTORY]: createMemoryReader([relayList(entries)]) });
  const asksFor = (kind: number) => (filter: { kinds?: number[] }) => filter.kinds?.includes(kind) === true;

  it("puts the relay list's relays first, writes before reads, then the follow-list relays", async () => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = [DIRECTORY, "wss://nos.lol"];
    const readers = directoryHolds([A, "read"], [B], [C, "write"]);

    expect(await find(readers)).toEqual([B, C, A, DIRECTORY, "wss://nos.lol"]);
  });

  it("leaves the review relays out: the search relay serves no follow lists (ruling R12)", async () => {
    config.reviewRelays = [SEARCH, "wss://reviews.example.com"];
    config.followListRelays = [DIRECTORY];

    expect(await find(directoryHolds([A]))).toEqual([A, DIRECTORY]);
    expect(await find(readersOver({}))).toEqual([DIRECTORY]);
  });

  it("keeps a review relay that is a follow-list relay too, or that the person's own list names", async () => {
    config.reviewRelays = [SEARCH, "wss://nos.lol"];
    config.followListRelays = [DIRECTORY, "wss://nos.lol"];

    expect(await find(readersOver({}))).toEqual([DIRECTORY, "wss://nos.lol"]);
    // The person's list is theirs to write: a relay it names is read, whatever else that relay is.
    expect(await find(directoryHolds([SEARCH]))).toEqual([SEARCH, DIRECTORY, "wss://nos.lol"]);
  });

  it("reads the person's relay list from the review relays and the relay-list relays, and then their follow list from the relays it gives", async () => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = [DIRECTORY];
    const search = createMemoryReader([relayList([[A]])]);
    const directory = createMemoryReader([]);
    const own = createMemoryReader([]);

    expect(await find(readersOver({ [SEARCH]: search, [DIRECTORY]: directory, [A]: own }))).toEqual([A, DIRECTORY]);
    expect(search.requests).toEqual([{ kinds: [10002], authors: [ALICE], limit: 1, search: "include:spam" }]);
    expect(directory.requests).toEqual([
      { kinds: [10002], authors: [ALICE], limit: 1 },
      { kinds: [3], authors: [ALICE], limit: 1 },
    ]);
    expect(own.requests).toEqual([{ kinds: [3], authors: [ALICE], limit: 1 }]);
  });

  it("gives the follow-list relays when the person has no relay list", async () => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = [DIRECTORY, "wss://nos.lol"];

    expect(await find(readersOver({}))).toEqual([DIRECTORY, "wss://nos.lol"]);
  });

  it("uses the relay list one relay sends, though another never answers: once that one's time is up (ruling R11)", async () => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = ["wss://nos.lol"];
    const readers = readersOver({ [SEARCH]: silent, [DIRECTORY]: createMemoryReader([relayList([[A]])]) });
    let found: string[] | undefined;
    void find(readers).then((relays) => {
      found = relays;
    });

    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS - 1);
    expect(found).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(found).toEqual([A, "wss://nos.lol"]);
  });

  it("counts a relay once, however it is written and wherever it is named", async () => {
    config.reviewRelays = [SEARCH, "wss://NOS.lol/"];
    config.followListRelays = [DIRECTORY, "wss://nos.lol", "wss://PURPLEPAG.es/"];
    const readers = directoryHolds(
      ["wss://Relay.Example.com/"],
      ["wss://relay.example.com"],
      ["wss://relay.example.com..."],
      ["wss://nos.lol/"],
      ["wss://relay.example.com", "read"],
      [SEARCH],
    );

    expect(await find(readers)).toEqual(["wss://relay.example.com", "wss://nos.lol", SEARCH, DIRECTORY]);
  });

  it("leaves out the person's relays that are not public wss addresses, and keeps the app's own, even on this machine in development", async () => {
    config.reviewRelays = [];
    config.followListRelays = ["ws://localhost:7777"];
    const readers = directoryHolds(
      ["ws://plain.example.com"],
      ["wss://localhost"],
      ["wss://192.168.1.1"],
      ["wss://127.0.0.1:4000", "read"],
      ["wss://user:secret@secret.example.com"],
      ["https://web.example.com"],
      ["wss://printer.local"],
      ["not a relay"],
      [""],
      ["wss://good.example.com"],
    );

    expect(await find(readers)).toEqual(["wss://good.example.com", "ws://localhost:7777"]);
  });

  it("gives at most 16, and keeps the six follow-list relays when the person's list is long: ten of theirs (ruling R15)", async () => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = [DIRECTORY, "wss://nos.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nostr.mom", "wss://nostr.oxtr.dev"];
    const readers = directoryHolds(...Array.from({ length: 30 }, (_, n) => [`wss://own${n}.example.com`]));

    const relays = await find(readers);

    expect(relays).toHaveLength(16);
    expect(relays).toEqual([
      ...Array.from({ length: 10 }, (_, n) => `wss://own${n}.example.com`),
      DIRECTORY,
      "wss://nos.lol",
      "wss://relay.primal.net",
      "wss://relay.damus.io",
      "wss://nostr.mom",
      "wss://nostr.oxtr.dev",
    ]);
    expect(MAX_FOLLOW_RELAYS).toBe(16);
  });

  it("gives every relay of a person who names ten, with the app's six", async () => {
    config.followListRelays = [DIRECTORY, "wss://nos.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nostr.mom", "wss://nostr.oxtr.dev"];
    const own = Array.from({ length: 10 }, (_, n) => `wss://own${n}.example.com`);

    expect(await find(directoryHolds(...own.map((url) => [url])))).toEqual([...own, ...config.followListRelays]);
  });

  it("throws the signal's reason when it aborts", async () => {
    const stop = new AbortController();
    stop.abort(new Error("signed out"));

    await expect(find(readersOver({}), stop.signal)).rejects.toThrow("signed out");
    // And while a relay is still being read.
    const later = new AbortController();
    const reading = readOwnList(ALICE, readersOver({ [DIRECTORY]: silent }), later.signal);
    later.abort(new Error("signed out later"));
    await expect(reading).rejects.toThrow("signed out later");
  });

  it("asks nothing of any relay for a follow list when the relay list could not be read: there is nowhere known to read it", async () => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = ["wss://nos.lol"];
    const nos = createMemoryReader([list([BOB])]);
    const down = () => createMemoryReader([], { failWith: new Error("down") });

    const read = await readOwnList(ALICE, readersOver({ [DIRECTORY]: down(), "wss://nos.lol": nos }), new AbortController().signal);

    expect(read).toEqual({ relayList: { is: "unknown" }, relays: [], writes: [], list: null, answered: [], trusted: false, ownAnswered: false, agreed: 0 });
    expect(nos.requests.filter(asksFor(3))).toEqual([]);
  });
});

describe("readOwnList: whether what it found may be acted on (rulings R43 and R44)", () => {
  const NOS = "wss://nos.lol";
  const down = () => createMemoryReader([], { failWith: new Error("down") });
  const older = list([BOB], { created_at: 1_690_000_000 });
  const newest = list([BOB, CAROL], { created_at: 1_700_000_500 });
  const read = (readers: (url: string) => RelayReader) => readOwnList(ALICE, readers, new AbortController().signal);

  beforeEach(() => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = [DIRECTORY, NOS];
  });

  it("is trusted when the relay list is known to be none: the list the app's relays hold is the list", async () => {
    const found = await read(readersOver({ [NOS]: createMemoryReader([newest]) }));

    expect(found).toEqual({
      relayList: { is: "none" },
      relays: [DIRECTORY, NOS],
      writes: [],
      list: newest,
      answered: [DIRECTORY, NOS],
      trusted: true,
      ownAnswered: false,
      agreed: 1,
    });
  });

  it("is trusted with no list at all when the relay list is none: how many answered is the caller's to weigh", async () => {
    const found = await read(readersOver({ [NOS]: down() }));

    expect(found).toMatchObject({ relayList: { is: "none" }, list: null, answered: [DIRECTORY], trusted: true });
  });

  it("is not trusted when the relay list is not known: the relay-list relay is out, and an old copy on one of the app's relays is not built on", async () => {
    // The directory, which holds her relay list, is out; the review relay says it has none.
    const found = await read(readersOver({ [DIRECTORY]: down(), [NOS]: createMemoryReader([older]) }));

    expect(found.relayList).toEqual({ is: "unknown" });
    expect(found.trusted).toBe(false);
    expect(found.list).toBeNull();
  });

  it("is trusted when the relay list is found and a relay it writes to answers, with the list or with none", async () => {
    const theirs = relayList([[A, "write"], [B, "write"], [C, "read"]]);
    const withList = await read(readersOver({ [DIRECTORY]: createMemoryReader([theirs]), [A]: down(), [B]: createMemoryReader([newest]), [NOS]: createMemoryReader([older]) }));
    expect(withList).toMatchObject({ relayList: { is: "found" }, writes: [A, B], list: newest, answered: [B, C, DIRECTORY, NOS], trusted: true });

    // It answered, to the end, with no list: it was read, and what the others hold is the newest there is.
    const withNone = await read(readersOver({ [DIRECTORY]: createMemoryReader([theirs]), [A]: down(), [NOS]: createMemoryReader([older]) }));
    expect(withNone).toMatchObject({ list: older, trusted: true });
  });

  it("is not trusted when the relay list is found and no relay it writes to answers: out, or too slow", async () => {
    const theirs = relayList([[A, "write"], [B, "write"], [C, "read"]]);
    const readers = readersOver({ [DIRECTORY]: createMemoryReader([theirs]), [A]: down(), [B]: silent, [NOS]: createMemoryReader([older]) });
    let found: Awaited<ReturnType<typeof readOwnList>> | undefined;
    void read(readers).then((result) => {
      found = result;
    });

    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

    // What the app's relays and the relay she only reads from sent is told, and is not to be built on.
    expect(found).toMatchObject({ relayList: { is: "found" }, writes: [A, B], list: older, answered: [C, DIRECTORY, NOS], trusted: false });
  });

  it("is not trusted on the word of a relay the person only reads from", async () => {
    const theirs = relayList([[A, "write"], [C, "read"]]);
    const found = await read(readersOver({ [DIRECTORY]: createMemoryReader([theirs]), [A]: down(), [C]: createMemoryReader([newest]) }));

    expect(found).toMatchObject({ list: newest, trusted: false });
  });

  it.each([
    ["only addresses the app cannot use", [["ws://plain.example.com", "write"], ["wss://localhost", "write"], ["not a relay"]]],
    ["only relays to read from", [[C, "read"]]],
    ["no relay", []],
  ])("stands on the app's relays, trusted, when the relay list names %s to write to", async (_, entries) => {
    const found = await read(readersOver({ [DIRECTORY]: createMemoryReader([relayList(entries)]), [NOS]: createMemoryReader([newest]) }));

    expect(found).toMatchObject({ relayList: { is: "found" }, writes: [], list: newest, trusted: true });
  });

  it("counts a relay the person writes to that is one of the app's own, when it answers", async () => {
    const theirs = relayList([[A, "write"], [NOS, "write"]]);
    const found = await read(readersOver({ [DIRECTORY]: createMemoryReader([theirs]), [A]: down(), [NOS]: createMemoryReader([newest]) }));

    expect(found).toMatchObject({ writes: [A, NOS], list: newest, trusted: true });
  });

  it("counts only the relays it writes to that there was room to ask: one left out for the cap has not answered", async () => {
    config.followListRelays = [DIRECTORY, NOS, "wss://relay.primal.net", "wss://relay.damus.io", "wss://nostr.mom", "wss://nostr.oxtr.dev"];
    const own = Array.from({ length: 12 }, (_, n) => `wss://own${n}.example.com`);
    const held: Record<string, RelayReader> = { [DIRECTORY]: createMemoryReader([relayList(own.map((url) => [url, "write"]))]) };
    // The ten there is room for are out. The eleventh, which holds her newest list, is never asked.
    for (const url of own.slice(0, 10)) held[url] = down();
    const eleventh = createMemoryReader([newest]);
    held[own[10]!] = eleventh;

    const found = await read(readersOver(held));

    expect(found.writes).toEqual(own.slice(0, 10));
    expect(eleventh.requests).toEqual([]);
    expect(found.trusted).toBe(false);
  });

  it("finds the relay list on a review relay though the relay-list relay is out, and then the relays it writes to decide", async () => {
    const theirs = relayList([[A, "write"]]);
    const answers = await read(readersOver({ [DIRECTORY]: down(), [SEARCH]: createMemoryReader([theirs]), [A]: createMemoryReader([newest]) }));
    expect(answers).toMatchObject({ relayList: { is: "found" }, list: newest, trusted: true });

    const isOut = await read(readersOver({ [DIRECTORY]: down(), [SEARCH]: createMemoryReader([theirs]), [A]: down(), [NOS]: createMemoryReader([older]) }));
    expect(isOut).toMatchObject({ relayList: { is: "found" }, list: older, trusted: false });
  });

  it("gives every relay the same time, for the relay list and for the list: six seconds each", async () => {
    const theirs = relayList([[A, "write"]]);
    const readers = readersOver({
      [SEARCH]: silent,
      [DIRECTORY]: createMemoryReader([theirs], { delayMs: FOLLOW_READ_MS - 1 }),
      [A]: createMemoryReader([newest], { delayMs: FOLLOW_READ_MS - 1 }),
      [NOS]: silent,
    });
    let found: Awaited<ReturnType<typeof readOwnList>> | undefined;
    void read(readers).then((result) => {
      found = result;
    });

    // The relay list: the directory answers just inside its time, and the review relay's time runs out.
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);
    expect(found).toBeUndefined();
    // The list: her own relay answers just inside its time, and one of the app's runs out.
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS - 1);
    expect(found).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(found).toMatchObject({ list: newest, answered: [A, DIRECTORY], trusted: true });
    expect(FOLLOW_READ_MS).toBe(6_000);
  });
});

describe("readOwnList: whether a relay of the person's own answered, and how many of the app's relays hold the newest list", () => {
  const SIX = [DIRECTORY, "wss://nos.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nostr.mom", "wss://nostr.oxtr.dev"];
  const OTHERS = SIX.slice(1);
  const down = () => createMemoryReader([], { failWith: new Error("down") });
  const older = list([BOB], { created_at: 1_690_000_000 });
  const newest = list([BOB, CAROL], { created_at: 1_700_000_500 });
  /** Alice's relay list: she writes to A, and reads from C. */
  const theirs = relayList([[A, "write"], [C, "read"]]);
  const read = (readers: (url: string) => RelayReader) => readOwnList(ALICE, readers, new AbortController().signal);

  /**
   * The six follow-list relays, each holding what `holds` gives for it (the directory, which is one
   * of them, holds her relay list besides), with the relay she writes to as `own` makes it.
   */
  function six(holds: (url: string, at: number) => NostrEvent[] | "out", own: RelayReader = down()): (url: string) => RelayReader {
    const held: Record<string, RelayReader> = { [A]: own };
    SIX.forEach((url, at) => {
      const events = holds(url, at);
      if (events === "out") held[url] = url === DIRECTORY ? failingFor(3, createMemoryReader([theirs])) : down();
      else held[url] = createMemoryReader(url === DIRECTORY ? [...events, theirs] : events);
    });
    return readersOver(held);
  }

  beforeEach(() => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = [...SIX];
  });

  it("asks for agreement among three: fewer of the app's relays holding a list show nothing of how widely it was sent", () => {
    expect(AGREE_MIN).toBe(3);
  });

  it("counts every one of the app's relays when each holds the newest list, and says her own relay did not answer", async () => {
    const found = await read(six(() => [newest]));

    expect(found).toMatchObject({ relayList: { is: "found" }, writes: [A], list: newest, ownAnswered: false, agreed: 6, trusted: false });
    expect(found.answered).toEqual([C, ...SIX]);
  });

  it.each([
    [2, 2],
    [3, 3],
    [5, 5],
  ])("counts %i of six when that many hold the list and the rest hold none", async (holding, agreed) => {
    const found = await read(six((_, at) => (at < holding ? [newest] : [])));

    expect(found).toMatchObject({ list: newest, ownAnswered: false, agreed, trusted: false });
    expect(found.answered).toHaveLength(7);
  });

  it("does not count one of the app's relays that holds an older list: it has not the newest", async () => {
    const found = await read(six((_, at) => (at === 2 ? [older] : [newest])));

    expect(found).toMatchObject({ list: newest, agreed: 5 });
  });

  it("counts only the relay that holds a newer list than the others, when one does: the others hold a list that is not the newest", async () => {
    const found = await read(six((_, at) => (at === 2 ? [newest] : [older])));

    expect(found).toMatchObject({ list: newest, agreed: 1 });
  });

  it("does not count one of the app's relays that is out: only those that answered can hold it", async () => {
    const found = await read(six((_, at) => (at === 4 ? "out" : [newest])));

    expect(found).toMatchObject({ list: newest, agreed: 5 });
    expect(found.answered).not.toContain(SIX[4]);
    // The directory out for lists, and answering for her relay list, is one that did not answer either.
    expect(await read(six((url) => (url === DIRECTORY ? "out" : [newest])))).toMatchObject({ relayList: { is: "found" }, list: newest, agreed: 5 });
  });

  it("goes by a relay's own newest list when it sends more than one: an older one beside it changes nothing", async () => {
    const found = await read(six((_, at) => (at === 1 ? [older, newest] : [newest])));

    expect(found).toMatchObject({ list: newest, agreed: 6 });
    // And a relay whose newest is another list of the same second is not counted: it is not the same list.
    const twin = list([CAROL], { created_at: newest.created_at, id: "f".repeat(64) });
    expect(await read(six((_, at) => (at < 2 ? [twin] : [newest])))).toMatchObject({ list: newest, agreed: 4 });
  });

  it("says her own relay answered when it sends the newest list, and counts none of the app's: they hold an older one", async () => {
    const found = await read(six(() => [older], createMemoryReader([newest])));

    expect(found).toMatchObject({ list: newest, ownAnswered: true, agreed: 0, trusted: true });
  });

  it("says her own relay answered when it sends an older list than the app's relays hold, and counts those", async () => {
    const found = await read(six(() => [newest], createMemoryReader([older])));

    expect(found).toMatchObject({ list: newest, ownAnswered: true, agreed: 6, trusted: true });
  });

  it("says her own relay answered when it answers with no list", async () => {
    const found = await read(six((_, at) => (at < 3 ? [newest] : []), createMemoryReader([])));

    expect(found).toMatchObject({ list: newest, ownAnswered: true, agreed: 3, trusted: true });
  });

  it("counts none of her own relays among the app's: the one she reads from holds the newest, and no relay of the app's does", async () => {
    const readers = six(() => [older]);
    const found = await read((url) => (url === C ? createMemoryReader([newest]) : readers(url)));

    // It is no relay she writes to, either: its answer is not her own relay's.
    expect(found).toMatchObject({ list: newest, ownAnswered: false, agreed: 0, trusted: false });
  });

  it("counts a relay she writes to that is one of the app's own, once, and says her own relay answered", async () => {
    const both = relayList([[A, "write"], ["wss://NOS.lol/", "write"]]);
    const held: Record<string, RelayReader> = { [A]: down(), [DIRECTORY]: createMemoryReader([both, newest]) };
    for (const url of OTHERS) held[url] = createMemoryReader([newest]);

    const found = await read(readersOver(held));

    expect(found).toMatchObject({ writes: [A, "wss://nos.lol"], list: newest, ownAnswered: true, agreed: 6, trusted: true });
  });

  it("counts none when no list is found, however many answer", async () => {
    const found = await read(six(() => []));

    expect(found).toMatchObject({ list: null, ownAnswered: false, agreed: 0, trusted: false });
    expect(found.answered).toHaveLength(7);
  });

  it("says no relay of her own answered when she has none to write to: no relay list, or one that names none the app can use", async () => {
    const none = readersOver(Object.fromEntries(SIX.map((url) => [url, createMemoryReader([newest])])));
    expect(await read(none)).toMatchObject({ relayList: { is: "none" }, writes: [], list: newest, ownAnswered: false, agreed: 6, trusted: true });

    const unusable = relayList([["ws://plain.example.com", "write"], [C, "read"]]);
    const held = Object.fromEntries(SIX.map((url) => [url, createMemoryReader(url === DIRECTORY ? [unusable, newest] : [newest])]));
    expect(await read(readersOver(held))).toMatchObject({ relayList: { is: "found" }, writes: [], list: newest, ownAnswered: false, agreed: 6, trusted: true });
  });

  it("counts the app's relays as it is set up with them, each once, however an address is written", async () => {
    config.followListRelays = [DIRECTORY, "wss://NOS.lol/", "wss://nos.lol", "wss://relay.primal.net"];
    const held: Record<string, RelayReader> = { [A]: down(), [DIRECTORY]: createMemoryReader([theirs, newest]), "wss://nos.lol": createMemoryReader([newest]), "wss://relay.primal.net": createMemoryReader([newest]) };

    expect(await read(readersOver(held))).toMatchObject({ list: newest, agreed: 3 });
  });
});

describe("copyToAsk: the one read a person may be asked about", () => {
  const found: OwnListRead["relayList"] = { is: "found", write: [A], read: [] };
  /** The device's clock, in seconds, and a list made a while before it. */
  const NOW = 1_700_001_000;
  const newest = list([BOB, CAROL], { created_at: 1_700_000_500 });
  /** A read in which every condition holds: her relay list found, a relay it writes to that the app can use, none of those heard from, a list, and three of the app's relays holding it. */
  const asking: OwnListRead = { relayList: found, relays: [A, DIRECTORY], writes: [A], list: newest, answered: [DIRECTORY], trusted: false, ownAnswered: false, agreed: 3 };
  /** That read, with its list dated `at`. */
  const dated = (at: number): OwnListRead => ({ ...asking, list: list([BOB], { created_at: at }) });

  it("gives the list the read found when every condition holds", () => {
    expect(copyToAsk(asking, NOW)).toBe(newest);
    expect(copyToAsk({ ...asking, agreed: 6 }, NOW)).toBe(newest);
  });

  it.each<[string, Partial<OwnListRead>]>([
    ["the relay list could not be read", { relayList: { is: "unknown" } }],
    ["the person is known to have no relay list", { relayList: { is: "none" } }],
    ["the relay list names no relay to write to that the app can use", { writes: [] }],
    ["a relay the person writes to answered", { ownAnswered: true }],
    ["no list was found", { list: null }],
    ["two of the app's relays hold the list", { agreed: 2 }],
    ["none of the app's relays holds the list", { agreed: 0 }],
    ["the read is one to trust", { trusted: true }],
  ])("gives none when %s, though every other condition holds", (_, other) => {
    expect(copyToAsk({ ...asking, ...other }, NOW)).toBeNull();
  });

  it("gives none for what a read that could not learn where the list is kept comes to", () => {
    expect(copyToAsk({ relayList: { is: "unknown" }, relays: [], writes: [], list: null, answered: [], trusted: false, ownAnswered: false, agreed: 0 }, NOW)).toBeNull();
  });

  describe("a copy whose date says nothing a person can weigh", () => {
    it("is asked about when it is dated up to a day after the device's clock, and not when a second more: a clock set a little wrong is no reason, a day that has not come is", () => {
      expect(COPY_AHEAD_S).toBe(24 * 60 * 60);
      expect(copyToAsk(dated(NOW), NOW)).not.toBeNull();
      expect(copyToAsk(dated(NOW + COPY_AHEAD_S), NOW)).not.toBeNull();
      expect(copyToAsk(dated(NOW + COPY_AHEAD_S + 1), NOW)).toBeNull();
      expect(copyToAsk(dated(Number.MAX_SAFE_INTEGER), NOW)).toBeNull();
    });

    it("is asked about when it is dated from the first second of 2020 in Greenwich on, and not when a second before", () => {
      expect(COPY_NOT_BEFORE_S).toBe(Date.UTC(2020, 0, 1) / 1000);
      expect(copyToAsk(dated(COPY_NOT_BEFORE_S), NOW)).not.toBeNull();
      expect(copyToAsk(dated(COPY_NOT_BEFORE_S - 1), NOW)).toBeNull();
      expect(copyToAsk(dated(0), NOW)).toBeNull();
    });

    it("goes by the clock it is given: the same copy is a day too far ahead for an earlier clock, and not for a later one", () => {
      const copy = dated(NOW + COPY_AHEAD_S + 1);
      expect(copyToAsk(copy, NOW)).toBeNull();
      expect(copyToAsk(copy, NOW + 1)).toBe(copy.list);
    });

    it("gives none whatever else holds: a list dated so is not asked about with every relay holding it", () => {
      expect(copyToAsk({ ...dated(NOW + COPY_AHEAD_S + 1), agreed: 6 }, NOW)).toBeNull();
      expect(copyToAsk({ ...dated(COPY_NOT_BEFORE_S - 1), agreed: 6 }, NOW)).toBeNull();
    });
  });
});

describe("followRelaysWith", () => {
  beforeEach(() => {
    config.reviewRelays = [SEARCH];
    config.followListRelays = [DIRECTORY, "wss://nos.lol"];
  });

  it("gives the relays a person's list is read from, and of them the ones the person writes to", () => {
    const theirs = { write: [B, C], read: [B, A] };

    expect(followRelaysWith(theirs)).toEqual({ relays: [B, C, A, DIRECTORY, "wss://nos.lol"], writes: [B, C] });
  });

  it("is what the whole read of a person's own list reads their relay list into", async () => {
    const readers = readersOver({ [DIRECTORY]: createMemoryReader([relayList([[A, "read"], [B], [C, "write"]])]) });

    const read = await readOwnList(ALICE, readers, new AbortController().signal);

    expect({ relays: read.relays, writes: read.writes }).toEqual(followRelaysWith({ write: [B, C], read: [A, B] }));
  });

  it("gives the follow-list relays, and nowhere the person writes, when they have no relay list", () => {
    expect(followRelaysWith(null)).toEqual({ relays: [DIRECTORY, "wss://nos.lol"], writes: [] });
  });

  it("writes each relay the person writes to as an address, once, and leaves out one that is not public", () => {
    const theirs = { write: ["wss://B.example.com/", B, "wss://localhost", "ws://plain.example.com", "wss://NOS.lol"], read: [] };

    expect(followRelaysWith(theirs)).toEqual({
      relays: [B, "wss://nos.lol", DIRECTORY],
      writes: [B, "wss://nos.lol"],
    });
  });

  it("leaves out of both the relays the person writes to that there is no room for", () => {
    config.followListRelays = [DIRECTORY, "wss://nos.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://nostr.mom", "wss://nostr.oxtr.dev"];
    const own = Array.from({ length: 30 }, (_, n) => `wss://own${n}.example.com`);

    const { relays, writes } = followRelaysWith({ write: own, read: [] });

    expect(relays).toHaveLength(16);
    expect(writes).toEqual(own.slice(0, 10));
    for (const url of writes) expect(relays).toContain(url);
  });
});
