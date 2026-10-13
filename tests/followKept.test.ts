import type { NostrEvent } from "@nostrify/nostrify";
import { get, set } from "idb-keyval";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEEP_WAIT_MS, keepCopy, KEPT_COPIES, type KeptFor, keptCopies } from "../src/follow/kept";
import { LAST_MOMENT_S } from "../src/locale";
import { ABSENT, buildFollowList, FOLLOW_LIST_SIZE, FOLLOW_LIST_TIME, pubkeyAt } from "./fixtures/follow-list";

/*
 * The copies of a person's follow list kept in the browser (src/follow/kept.ts): the list a change
 * was built on, as the relays sent it, kept before the changed one is signed, so that it can be put
 * back. These hold the keeping to what is kept (the event's seven fields, byte for byte, with what
 * it was kept for), to how many, to whose, and to never failing a change: a storage that cannot keep
 * is a no, and never a throw. The device's storage is IndexedDB as tests have it (tests/setup.ts);
 * the keys are thrown away.
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const OTHER_SECRET = generateSecretKey();
const SOMEONE_ELSE = getPublicKey(OTHER_SECRET);

/** When a copy is kept, in seconds. */
const NOW = FOLLOW_LIST_TIME + 500;

const FOLLOWED: KeptFor = { did: "follow", who: ABSENT };

/** A list of the person's with `tags`, made `at` seconds after the synthetic one. */
const listOf = (tags: string[][], at = 0, key = SECRET) => finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + at, content: "", tags }, key);

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** Where the person's copies are, in the device's storage. */
const keyOf = (pubkey: string) => `regulars.follow.kept.${pubkey}`;

/** What the app logs, on any level: nothing here may be, as a list and who it names are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("idb-keyval");
    vi.doUnmock("nostr-tools/pure");
    vi.resetModules();
  }
});

describe("keeping a copy", () => {
  it("keeps the list as it was given, its seven fields byte for byte and its signature whole, with when and what for", async () => {
    const list = asSent(buildFollowList(SECRET));

    expect(await keepCopy(ME, list, FOLLOWED, NOW)).toBe(true);

    const copies = await keptCopies(ME);
    expect(copies).toEqual([{ list, at: NOW, for: FOLLOWED }]);
    // The very text of it: every tag in its order, entries this app cannot read among them, and the content.
    expect(JSON.stringify(copies[0]!.list)).toBe(JSON.stringify(list));
    expect(copies[0]!.list.tags).toHaveLength(FOLLOW_LIST_SIZE);
    expect(Object.keys(copies[0]!.list).sort()).toEqual(["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
    // Its signature is what later proves it may be put back.
    expect(verifyEvent(copies[0]!.list)).toBe(true);
  });

  it("is in the device's own storage under the person's key, as a list of copies", async () => {
    const list = asSent(listOf([["p", pubkeyAt(1)]]));

    await keepCopy(ME, list, FOLLOWED, NOW);

    expect(await get(keyOf(ME))).toEqual([{ list, at: NOW, for: FOLLOWED }]);
  });

  it("keeps the event's seven fields and nothing a caller left beside them", async () => {
    const signed = listOf([["p", pubkeyAt(1)]]);
    // As nostr-tools hands it over: with its own mark of a checked event, and whatever else is on it.
    const withMore = Object.assign(signed, { relays: ["wss://own.example.test"], seenAt: () => NOW }) as NostrEvent;

    expect(await keepCopy(ME, withMore, FOLLOWED, NOW)).toBe(true);

    expect((await keptCopies(ME))[0]!.list).toEqual(asSent(signed));
    expect(Object.keys((await get<{ list: object }[]>(keyOf(ME)))![0]!.list)).toHaveLength(7);
  });

  it.each<[string, KeptFor]>([
    ["a follow", { did: "follow", who: ABSENT }],
    ["an unfollow", { did: "unfollow", who: pubkeyAt(8) }],
    ["an Undo", { did: "undo", who: pubkeyAt(8) }],
    ["a copy put back", { did: "put-back" }],
  ])("says what it was kept for: %s", async (_, why) => {
    await keepCopy(ME, listOf([["p", pubkeyAt(1)]]), why, NOW);

    expect((await keptCopies(ME)).map((copy) => copy.for)).toEqual([why]);
  });

  it("has the newest first", async () => {
    const lists = [0, 1, 2].map((at) => asSent(listOf([["p", pubkeyAt(at)]], at)));

    for (const [at, list] of lists.entries()) expect(await keepCopy(ME, list, FOLLOWED, NOW + at)).toBe(true);

    expect((await keptCopies(ME)).map((copy) => copy.list)).toEqual([lists[2], lists[1], lists[0]]);
    expect((await keptCopies(ME)).map((copy) => copy.at)).toEqual([NOW + 2, NOW + 1, NOW]);
  });

  it("keeps ten at most: the oldest gives way to an eleventh", async () => {
    const lists = Array.from({ length: KEPT_COPIES + 2 }, (_, at) => asSent(listOf([["p", pubkeyAt(at)]], at)));

    for (const [at, list] of lists.entries()) expect(await keepCopy(ME, list, FOLLOWED, NOW + at)).toBe(true);

    const copies = await keptCopies(ME);
    expect(copies).toHaveLength(KEPT_COPIES);
    expect(copies.map((copy) => copy.list.id)).toEqual(lists.slice(2).reverse().map((list) => list.id));
    expect(await get(keyOf(ME))).toHaveLength(KEPT_COPIES);
    expect(KEPT_COPIES).toBe(10);
  });

  describe("a copy that is about to be put back", () => {
    /** Ten lists kept a second apart, the oldest first; and the list as it is now, which a put-back keeps before it replaces it. */
    async function tenKept() {
      const lists = Array.from({ length: KEPT_COPIES }, (_, at) => asSent(listOf([["p", pubkeyAt(at)]], at)));
      for (const [at, list] of lists.entries()) expect(await keepCopy(ME, list, FOLLOWED, NOW + at)).toBe(true);
      return { lists, current: asSent(listOf([["p", ABSENT]], 100)) };
    }
    const ids = async () => (await keptCopies(ME)).map((copy) => copy.list.id);

    it("does not give way to the keeping that comes before it: with ten kept, the oldest other copy goes, and it stays where it was", async () => {
      const { lists, current } = await tenKept();
      const oldest = lists[0]!;

      // The list as it is now is kept before the oldest copy is put back in its place.
      expect(await keepCopy(ME, current, { did: "put-back" }, NOW + 100, oldest.id)).toBe(true);

      // The newest first; the copy that was second oldest has gone; the one to be put back is still the last.
      expect(await ids()).toEqual([current.id, ...lists.slice(2).reverse().map((list) => list.id), oldest.id]);
      expect(await ids()).toHaveLength(KEPT_COPIES);
      expect((await keptCopies(ME)).at(-1)).toEqual({ list: oldest, at: NOW, for: FOLLOWED });
    });

    it("changes nothing of which copy goes when it is not the oldest: the oldest gives way, as ever", async () => {
      const { lists, current } = await tenKept();

      expect(await keepCopy(ME, current, { did: "put-back" }, NOW + 100, lists[5]!.id)).toBe(true);

      expect(await ids()).toEqual([current.id, ...lists.slice(1).reverse().map((list) => list.id)]);
    });

    it("lets the oldest go when the copy named is none that is kept", async () => {
      const { lists, current } = await tenKept();

      expect(await keepCopy(ME, current, { did: "put-back" }, NOW + 100, asSent(listOf([["p", pubkeyAt(77)]], 77)).id)).toBe(true);

      expect(await ids()).toEqual([current.id, ...lists.slice(1).reverse().map((list) => list.id)]);
    });

    it("lets none go while there is room for all", async () => {
      const [first, second, current] = [0, 1, 2].map((at) => asSent(listOf([["p", pubkeyAt(at)]], at)));
      await keepCopy(ME, first!, FOLLOWED, NOW);
      await keepCopy(ME, second!, FOLLOWED, NOW + 1);

      expect(await keepCopy(ME, current!, { did: "put-back" }, NOW + 2, first!.id)).toBe(true);

      expect(await ids()).toEqual([current!.id, second!.id, first!.id]);
    });

    it("stays through a keeping that keeps nothing new: the list as it is now was the newest copy already", async () => {
      const { lists } = await tenKept();
      const before = await keptCopies(ME);

      // A putting back that was not approved is tried again: the list it replaces was kept the first time.
      expect(await keepCopy(ME, lists[9]!, { did: "put-back" }, NOW + 100, lists[0]!.id)).toBe(true);

      expect(await keptCopies(ME)).toEqual(before);
    });
  });

  it("does not keep the same list twice running: it counts as kept, and when and what for are as they were", async () => {
    const list = asSent(buildFollowList(SECRET));
    await keepCopy(ME, list, FOLLOWED, NOW);

    // A change that was not approved, tried again: built on the same list.
    expect(await keepCopy(ME, structuredClone(list), { did: "unfollow", who: pubkeyAt(8) }, NOW + 60)).toBe(true);

    expect(await keptCopies(ME)).toEqual([{ list, at: NOW, for: FOLLOWED }]);
  });

  it("keeps a list again once another has been kept since", async () => {
    const [first, second] = [0, 1].map((at) => asSent(listOf([["p", pubkeyAt(at)]], at)));
    await keepCopy(ME, first!, FOLLOWED, NOW);
    await keepCopy(ME, second!, FOLLOWED, NOW + 1);

    expect(await keepCopy(ME, first!, { did: "put-back" }, NOW + 2)).toBe(true);

    expect((await keptCopies(ME)).map((copy) => [copy.list.id, copy.at])).toEqual([
      [first!.id, NOW + 2],
      [second!.id, NOW + 1],
      [first!.id, NOW],
    ]);
  });

  it("keeps each person's copies apart", async () => {
    const mine = asSent(listOf([["p", pubkeyAt(1)]]));
    const theirs = asSent(listOf([["p", pubkeyAt(2)]], 0, OTHER_SECRET));

    expect(await keepCopy(ME, mine, FOLLOWED, NOW)).toBe(true);
    expect(await keepCopy(SOMEONE_ELSE, theirs, { did: "put-back" }, NOW + 1)).toBe(true);

    expect(await keptCopies(ME)).toEqual([{ list: mine, at: NOW, for: FOLLOWED }]);
    expect(await keptCopies(SOMEONE_ELSE)).toEqual([{ list: theirs, at: NOW + 1, for: { did: "put-back" } }]);
    expect(await keptCopies(pubkeyAt(3))).toEqual([]);
  });

  it("does not lose a copy when two are kept at once, nor when two tabs keep at once", async () => {
    const lists = [0, 1, 2, 3].map((at) => asSent(listOf([["p", pubkeyAt(at)]], at)));
    // Another tab: a copy of the code of its own, over the same storage.
    vi.resetModules();
    const otherTab = await import("../src/follow/kept");
    expect(otherTab.keepCopy).not.toBe(keepCopy);

    const kept = await Promise.all([
      keepCopy(ME, lists[0]!, FOLLOWED, NOW),
      otherTab.keepCopy(ME, lists[1]!, FOLLOWED, NOW),
      keepCopy(ME, lists[2]!, FOLLOWED, NOW),
      otherTab.keepCopy(ME, lists[3]!, FOLLOWED, NOW),
    ]);

    expect(kept).toEqual([true, true, true, true]);
    expect((await keptCopies(ME)).map((copy) => copy.list.id).sort()).toEqual(lists.map((list) => list.id).sort());
  });
});

describe("what is not a copy of the person's list", () => {
  /** Nothing was kept for the person, and nothing is in their place in the storage. */
  async function expectNothingKept() {
    expect(await keptCopies(ME)).toEqual([]);
    expect(await get(keyOf(ME))).toBeUndefined();
  }

  it("does not keep another person's list", async () => {
    expect(await keepCopy(ME, asSent(buildFollowList(OTHER_SECRET)), FOLLOWED, NOW)).toBe(false);
    await expectNothingKept();
  });

  it("does not keep an event of another kind", async () => {
    const profile = asSent(finalizeEvent({ kind: 0, created_at: FOLLOW_LIST_TIME, content: "{}", tags: [] }, SECRET));
    const relays = asSent(finalizeEvent({ kind: 10002, created_at: FOLLOW_LIST_TIME, content: "", tags: [["r", "wss://own.example.test"]] }, SECRET));

    expect(await keepCopy(ME, profile, FOLLOWED, NOW)).toBe(false);
    expect(await keepCopy(ME, relays, FOLLOWED, NOW)).toBe(false);
    await expectNothingKept();
  });

  it.each<[string, unknown]>([
    ["nothing", null],
    ["a template that was never signed", { kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [] }],
    ["a list with a tag that is no list of words", { ...asSent(listOf([])), tags: [["p", 7]] }],
    ["words", "a list"],
  ])("does not keep %s, and does not throw", async (_, given) => {
    expect(await keepCopy(ME, given as NostrEvent, FOLLOWED, NOW)).toBe(false);
    await expectNothingKept();
  });

  it.each<[string, unknown]>([
    ["nothing", undefined],
    ["a word", "follow"],
    ["a change with nobody", { did: "follow" }],
    ["a change of someone who is no key", { did: "unfollow", who: "npub1example" }],
    ["something else done", { did: "wipe", who: ABSENT }],
  ])("does not keep a list for %s", async (_, why) => {
    expect(await keepCopy(ME, asSent(listOf([])), why as KeptFor, NOW)).toBe(false);
    await expectNothingKept();
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, LAST_MOMENT_S + 1, Number.MAX_SAFE_INTEGER])("does not keep a list at a time that is none: %s", async (at) => {
    expect(await keepCopy(ME, asSent(listOf([])), FOLLOWED, at)).toBe(false);
    await expectNothingKept();
  });

  it("keeps a list at the last moment a date can hold, and at the first: every time kept is one the page can write", async () => {
    expect(LAST_MOMENT_S).toBe(8_640_000_000_000);
    expect(await keepCopy(ME, asSent(listOf([], 1)), FOLLOWED, LAST_MOMENT_S)).toBe(true);
    expect(await keepCopy(ME, asSent(listOf([], 2)), FOLLOWED, 0)).toBe(true);
    for (const copy of await keptCopies(ME)) expect(Number.isFinite(new Date(copy.at * 1000).getTime())).toBe(true);
  });

  it("does not keep a list for a person who is no key", async () => {
    const list = asSent(listOf([]));

    expect(await keepCopy(ME.toUpperCase(), list, FOLLOWED, NOW)).toBe(false);
    expect(await keepCopy("", list, FOLLOWED, NOW)).toBe(false);
    await expectNothingKept();
  });

  describe("on reading", () => {
    const good = () => asSent(listOf([["p", pubkeyAt(1)]], 5));

    /** Puts `stored` where the person's copies are, as something else that writes there might. */
    const stored = (value: unknown) => set(keyOf(ME), value);

    it("drops a list whose tag was changed after it was signed, and keeps the true ones around it", async () => {
      const tampered = { ...good(), tags: [["p", ABSENT]] };
      const older = asSent(listOf([["p", pubkeyAt(2)]]));
      await stored([
        { list: tampered, at: NOW + 2, for: FOLLOWED },
        { list: good(), at: NOW + 1, for: FOLLOWED },
        { list: older, at: NOW, for: FOLLOWED },
      ]);

      expect((await keptCopies(ME)).map((copy) => copy.list.id)).toEqual([good().id, older.id]);
    });

    it.each<[string, (list: NostrEvent) => NostrEvent]>([
      ["a signature that is not over it", (list) => ({ ...list, sig: asSent(listOf([["p", ABSENT]])).sig })],
      ["a signature of another key's", (list) => ({ ...list, sig: finalizeEvent({ kind: 3, created_at: list.created_at, content: list.content, tags: list.tags }, OTHER_SECRET).sig })],
      ["an id that is not the hash of its fields", (list) => ({ ...list, id: asSent(listOf([["p", ABSENT]])).id })],
      ["a content changed after it was signed", (list) => ({ ...list, content: "{}" })],
      ["a time changed after it was signed", (list) => ({ ...list, created_at: list.created_at + 1 })],
    ])("drops a list with %s", async (_, forged) => {
      await stored([{ list: forged(good()), at: NOW, for: FOLLOWED }]);

      expect(await keptCopies(ME)).toEqual([]);
    });

    it("drops another person's list, though it is truly signed, and an event of another kind", async () => {
      const profile = asSent(finalizeEvent({ kind: 0, created_at: FOLLOW_LIST_TIME, content: "{}", tags: [] }, SECRET));
      await stored([
        { list: asSent(buildFollowList(OTHER_SECRET)), at: NOW + 1, for: FOLLOWED },
        { list: profile, at: NOW, for: FOLLOWED },
      ]);

      expect(await keptCopies(ME)).toEqual([]);
    });

    it.each<[string, unknown]>([
      ["something that is no list of copies", { list: good(), at: NOW, for: FOLLOWED }],
      ["a word", "copies"],
      ["copies that are none", [null, 7, "copy", []]],
      ["a copy with no time", [{ list: good(), for: FOLLOWED }]],
      ["a copy kept at a time no date can hold", [{ list: good(), at: LAST_MOMENT_S + 1, for: FOLLOWED }]],
      ["a copy kept at a time that is no whole number of seconds", [{ list: good(), at: NOW + 0.5, for: FOLLOWED }]],
      ["a copy kept for nothing that is known", [{ list: good(), at: NOW, for: { did: "wipe" } }]],
      ["a copy kept for a change of nobody", [{ list: good(), at: NOW, for: { did: "follow", who: "someone" } }]],
      ["a copy with no list", [{ at: NOW, for: FOLLOWED }]],
    ])("gives nothing for %s, and does not throw", async (_, value) => {
      await stored(value);

      expect(await keptCopies(ME)).toEqual([]);
    });

    it("keeps a new copy over what it could not read, which is let go of then", async () => {
      await stored([null, { list: { id: "not an event" }, at: NOW, for: FOLLOWED }, "junk"]);
      const list = good();

      expect(await keepCopy(ME, list, FOLLOWED, NOW)).toBe(true);

      expect(await keptCopies(ME)).toEqual([{ list, at: NOW, for: FOLLOWED }]);
      expect(await get(keyOf(ME))).toHaveLength(1);
    });

    it("leaves no mark of the check on what it gives back", async () => {
      await keepCopy(ME, good(), FOLLOWED, NOW);

      expect(Object.getOwnPropertySymbols((await keptCopies(ME))[0]!.list)).toEqual([]);
    });

    it("gives nothing when the check of a signature cannot be had: an unchecked copy is no copy", async () => {
      await keepCopy(ME, good(), FOLLOWED, NOW);
      vi.resetModules();
      vi.doMock("nostr-tools/pure", () => {
        throw new TypeError("Failed to fetch dynamically imported module");
      });
      const fresh = await import("../src/follow/kept");

      expect(await fresh.keptCopies(ME)).toEqual([]);
    });
  });
});

describe("a storage that cannot keep", () => {
  /** The device's storage as idb-keyval presents it, for tests that replace it. */
  interface Storage {
    get(key: unknown): Promise<unknown>;
    update(key: unknown, updater: (old: unknown) => unknown): Promise<void>;
  }

  /** A fresh copy of the code whose IndexedDB (idb-keyval) is `storage`. */
  async function over(storage: Storage) {
    vi.resetModules();
    vi.doMock("idb-keyval", () => storage);
    return import("../src/follow/kept");
  }

  const refuses = () => Promise.reject(new DOMException("The quota has been exceeded.", "QuotaExceededError"));
  const works: Storage = { get: async () => undefined, update: async () => {} };

  it("says no, and does not throw, when the storage refuses the write: it is full, or will not be written", async () => {
    const kept = await over({ ...works, update: refuses });

    expect(await kept.keepCopy(ME, asSent(listOf([])), FOLLOWED, NOW)).toBe(false);
  });

  it("gives no copies, and does not throw, when the storage cannot be read", async () => {
    const kept = await over({ ...works, get: refuses });

    expect(await kept.keptCopies(ME)).toEqual([]);
  });

  it.each<[string, () => never]>([
    [
      // As idb-keyval fails where there is no IndexedDB: at once, as it is asked, and not by a promise.
      "has no storage at all",
      () => {
        throw new ReferenceError("indexedDB is not defined");
      },
    ],
    [
      "will not let the page reach its storage",
      () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    ],
  ])("says no, and gives no copies, in a browser that %s", async (_, absent) => {
    const kept = await over({ get: absent, update: absent });

    expect(await kept.keepCopy(ME, asSent(listOf([])), FOLLOWED, NOW)).toBe(false);
    expect(await kept.keptCopies(ME)).toEqual([]);
  });

  it("says no once the storage has not answered in its time: a change is not held up by it for ever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kept = await over({ ...works, update: () => new Promise<never>(() => {}) });
    let answer: boolean | undefined;
    void kept.keepCopy(ME, asSent(listOf([])), FOLLOWED, NOW).then((value) => {
      answer = value;
    });

    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS - 1);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(answer).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(KEEP_WAIT_MS).toBe(2_000);
  });

  it("leaves no timer behind once the storage has answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kept = await over(works);

    expect(await kept.keepCopy(ME, asSent(listOf([])), FOLLOWED, NOW)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
