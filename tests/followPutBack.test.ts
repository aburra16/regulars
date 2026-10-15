import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Account, REQUEST_TIMEOUT_MS } from "../src/account/session";
import { config } from "../src/config";
import {
  changeFollow,
  FOLLOW_LOCK,
  FOLLOW_LOCK_WAIT_MS,
  type FollowDeps,
  type FollowOutcome,
  forgetFollowFloor,
  putBackList,
  raiseFollowFloor,
} from "../src/follow/change";
import { KEEP_WAIT_MS, keepCopy, KEPT_COPIES, type KeptFor, keptCopies } from "../src/follow/kept";
import { FOLLOW_READ_MS } from "../src/follow/read";
import { PUBLISH_TIMEOUT_MS } from "../src/nostr/send";
import { ABSENT, buildFollowList, FOLLOW_LIST_CONTENT, FOLLOW_LIST_SIZE, FOLLOW_LIST_TIME, pubkeyAt } from "./fixtures/follow-list";
import { shapedEvent } from "./support/events";
import {
  asksForFollower,
  asksForList,
  asksForProfile,
  BIG,
  DIRECTORY,
  everywhere,
  failingWhen,
  NOS,
  OWN,
  type Relay,
  relay,
  setUpRelays,
  strangers,
  type World,
  world,
} from "./support/followWorld";
import { FakeLocks, useLocks } from "./support/locks";

/*
 * Putting a kept copy of a follow list back: `putBackList` (src/follow/change.ts), the one write that
 * replaces a person's whole list on purpose, and so the one that could lose the most. These hold it
 * to what it may write (the content and the tags of an event that is the person's own valid follow
 * list, and nothing else), to the list it replaces being kept first, and to the safeguards every
 * write to a follow list goes through (tests/followChange.test.ts holds a change of one entry to
 * them): one at a time, read fresh, never older than what this tab has seen, the signed event exactly
 * what was built, saved where it was read, read back. Relays are held in memory, the keys are thrown
 * away, and the clock is fake; nothing opens a socket.
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const OTHER_SECRET = generateSecretKey();

/** The clock, in seconds: after every list here was made. */
const NOW = FOLLOW_LIST_TIME + 5_000;

/** A second person the synthetic list does not name. */
const ALSO_ABSENT = pubkeyAt(20_001);

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** The copy: the person's list of 1,200 entries as it was, as a relay sent it then. */
const copyOf = (at = FOLLOW_LIST_TIME) => asSent(buildFollowList(SECRET, at));

/** The person's list as it is now: a few entries, another content, made `at` seconds after the copy. Something has shrunk it. */
const shrunk = (at = 1_000) =>
  finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + at, content: "", tags: [["p", pubkeyAt(3)], ["p", ABSENT], ["client", "another-app"]] }, SECRET);

const down = () => relay([], { reads: failingWhen(() => true), writes: { refuse: "error: down" } });

/** The person's relay list (kind 10002): each entry is `[url]`, `[url, "read"]` or `[url, "write"]`. */
const relayList = (entries: string[][]) => shapedEvent({ kind: 10002, pubkey: ME, tags: entries.map((entry) => ["r", ...entry]) });

/** A signer as an add-on is: it signs what it is asked to with the person's key. */
function signer(key = SECRET) {
  return {
    getPublicKey: async () => getPublicKey(key),
    signEvent: vi.fn(async (asked: EventTemplate): Promise<NostrEvent> => finalizeEvent(structuredClone(asked), key)),
  };
}

/** What keeps the list a write replaces, as the app's does: it says yes, and a test sees what it was handed. */
const keeper = (answer = true) => vi.fn(async (_list: NostrEvent, _why: KeptFor, _spare?: string): Promise<boolean> => answer);

interface Options {
  by?: ReturnType<typeof signer>;
  signal?: AbortSignal;
  now?: number;
  /** What keeps the list that is replaced. Default: something that does. `null`: nothing keeps it. */
  keep?: FollowDeps["keep"] | null;
}

/** Aborts when each test ends, so that a write a failed test left under way ends there. */
let life: AbortController;

const depsOf = (w: World, opts: Options): FollowDeps => ({
  readers: w.readers,
  writers: w.writers,
  now: () => opts.now ?? NOW,
  ...(opts.keep === null ? {} : { keep: opts.keep ?? keeper() }),
});

const signalOf = (opts: Options) => (opts.signal === undefined ? life.signal : AbortSignal.any([opts.signal, life.signal]));

/** The person has `copy` put back, over the relays of `w`. */
function putBack(w: World, copy: NostrEvent, opts: Options = {}, tab = putBackList): Promise<FollowOutcome> {
  const account: Account = { pubkey: ME, signer: opts.by ?? signer(), how: "browser" };
  return tab(account, copy, depsOf(w, opts), signalOf(opts));
}

/** The person follows `who`, over the relays of `w`: a change of one entry, for the tests that set one beside a putting back. */
function follow(w: World, who: string, opts: Options = {}, tab = changeFollow): Promise<FollowOutcome> {
  const account: Account = { pubkey: ME, signer: opts.by ?? signer(), how: "browser" };
  return tab(account, who, "follow", depsOf(w, opts), signalOf(opts));
}

/** How a write ended, once it has: its outcome, or what it threw. Neither while it goes on. */
function track(writing: Promise<FollowOutcome>) {
  const ended: { outcome?: FollowOutcome; error?: unknown } = {};
  writing.then(
    (outcome) => (ended.outcome = outcome),
    (error: unknown) => (ended.error = error),
  );
  return ended;
}

/** The list a write saved; fails the test when it did not save one. */
function savedBy(outcome: FollowOutcome | undefined): NostrEvent {
  if (outcome?.kind !== "saved") throw new Error(`Not saved: ${JSON.stringify(outcome?.kind)}`);
  return outcome.list;
}

/** Nothing was asked of the signer, and no relay was sent anything. */
function expectNothingWritten(w: World, by: ReturnType<typeof signer>) {
  expect(by.signEvent).not.toHaveBeenCalled();
  expect(w.published()).toEqual([]);
}

/** What the app logs, on any level: nothing here may be, as a list and its relays are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  life = new AbortController();
  setUpRelays(config);
  strangers.length = 0;
  // Each test starts as a tab just opened: no list seen yet.
  forgetFollowFloor();
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    // No timer of a write outlives it.
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
  } finally {
    life.abort(new Error("The test is over"));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useLocks(undefined);
  }
});

// ---------------------------------------------------------------------------------------------

describe("a copy of 1,200 entries, put back over the list as it is now", () => {
  it("saves a list with the copy's content and its tags exactly, every one in its order, in place of the one the relays held", async () => {
    const copy = copyOf();
    const now = shrunk();
    const w = everywhere([now]);

    const outcome = await putBack(w, copy);

    const saved = savedBy(outcome);
    // Saved as any write is, with the list it replaced kept first, and nothing for Undo.
    expect(outcome).toEqual({ kind: "saved", list: saved, confirmed: true, kept: true });
    expect(verifyEvent({ ...saved })).toBe(true);
    expect(saved.pubkey).toBe(ME);
    expect(saved.kind).toBe(3);
    expect(saved.content).toBe(FOLLOW_LIST_CONTENT);
    expect(saved.tags).toHaveLength(FOLLOW_LIST_SIZE);
    expect(JSON.stringify(saved.tags)).toBe(JSON.stringify(copy.tags));
    // Nothing of the list it replaced is in it.
    expect(saved.tags).not.toContainEqual(["client", "another-app"]);
    expect(saved.tags).not.toContainEqual(["p", ABSENT]);
    // A new event of the person's: not the copy sent again, which the relays would take for an older list.
    expect(saved.id).not.toBe(copy.id);
    for (const url of [NOS, DIRECTORY, BIG]) {
      expect(w.relays[url]!.writer.published).toEqual([saved]);
      expect(w.relays[url]!.held).toContainEqual(saved);
    }
  });

  it("asks the signer once, for exactly that: the copy's content and tags, at the time it is made", async () => {
    const copy = copyOf();
    const w = everywhere([shrunk()]);
    const by = signer();

    await putBack(w, copy, { by });

    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(by.signEvent).toHaveBeenCalledWith({ kind: 3, created_at: NOW, content: copy.content, tags: copy.tags });
  });

  it("is dated after the newest list the relays hold, though the device's clock is behind it, and behind the copy", async () => {
    const copy = copyOf();
    const older = shrunk(500);
    const newest = shrunk(1_000);
    const w = world({ [NOS]: relay([older]), [DIRECTORY]: relay([newest]), [BIG]: relay() });

    const late = savedBy(await putBack(w, copy, { now: FOLLOW_LIST_TIME - 9_000 }));

    expect(late.created_at).toBe(newest.created_at + 1);
    expect(late.created_at).toBeGreaterThan(copy.created_at);
    // So every relay takes it for the newest: the one that held the older list, and the one that held none.
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([late]);
  });

  it("is dated now when the clock is ahead of the newest list", async () => {
    const w = everywhere([shrunk()]);

    expect(savedBy(await putBack(w, copyOf(), { now: NOW + 77 })).created_at).toBe(NOW + 77);
  });

  it("puts back a copy that is newer than the list the relays hold, as any other", async () => {
    // The relays hold an old list: the newer one was lost, and a copy of it was kept.
    const copy = copyOf(FOLLOW_LIST_TIME + 2_000);
    const stale = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME - 500, content: "", tags: [["p", pubkeyAt(1)]] }, SECRET);
    const w = everywhere([stale]);

    const saved = savedBy(await putBack(w, copy));

    expect(saved.tags).toEqual(copy.tags);
    expect(saved.created_at).toBe(NOW);
  });

  it("puts back what it was given when asked: what the caller does to the copy after changes nothing", async () => {
    const copy = copyOf();
    const tags = structuredClone(copy.tags);
    const w = everywhere([shrunk()]);

    const putting = putBack(w, copy);
    copy.tags.length = 1;
    copy.tags[0]![1] = ABSENT;
    copy.content = "";

    const saved = savedBy(await putting);
    expect(saved.tags).toEqual(tags);
    expect(saved.content).toBe(FOLLOW_LIST_CONTENT);
  });

  it("puts back an empty list, when that is what the copy is", async () => {
    const copy = asSent(finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [] }, SECRET));
    const w = everywhere([buildFollowList(SECRET, FOLLOW_LIST_TIME + 100)]);

    const saved = savedBy(await putBack(w, copy));

    expect(saved.tags).toEqual([]);
    expect(saved.content).toBe("");
  });

  it("takes a copy with nostr-tools' own mark of a checked event, or with more beside its seven fields, and sends the seven fields of a new one", async () => {
    const copy = Object.assign(buildFollowList(SECRET), { relays: [OWN] }) as NostrEvent;
    const w = everywhere([shrunk()]);

    const saved = savedBy(await putBack(w, copy));

    expect(saved.tags).toEqual(copy.tags);
    expect(Object.keys(saved).sort()).toEqual(["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
    expect(Object.getOwnPropertySymbols(saved)).toEqual([]);
  });
});

describe("the list that is replaced, kept first", () => {
  it("is kept before the signer is asked, as the relays sent it, as a copy kept before one was put back", async () => {
    const now = shrunk();
    const w = everywhere([now]);
    const order: string[] = [];
    const keep = vi.fn(async (_list: NostrEvent, _why: KeptFor, _spare?: string) => {
      order.push("kept");
      return true;
    });
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => {
      order.push("signer");
      return finalizeEvent(structuredClone(asked), SECRET);
    });

    const copy = copyOf();
    const outcome = await putBack(w, copy, { by, keep });

    expect(order).toEqual(["kept", "signer"]);
    expect(keep).toHaveBeenCalledTimes(1);
    // With the copy that is being put back named, by its id: it does not give way to this keeping.
    expect(keep.mock.calls[0]).toEqual([asSent(now), { did: "put-back" }, copy.id]);
    expect(JSON.stringify(keep.mock.calls[0]![0])).toBe(JSON.stringify(asSent(now)));
    expect(outcome).toMatchObject({ kind: "saved", kept: true });
  });

  it("keeps the newest of the lists the relays hold: the one that is replaced everywhere", async () => {
    const older = shrunk(500);
    const newest = shrunk(1_000);
    const w = world({ [NOS]: relay([older]), [DIRECTORY]: relay([newest]), [BIG]: relay([older]) });
    const keep = keeper();

    await putBack(w, copyOf(), { keep });

    expect(keep.mock.calls.map(([list]) => list.id)).toEqual([newest.id]);
  });

  it.each<[string, FollowDeps["keep"] | null]>([
    ["says it could not keep it", async () => false],
    ["fails", () => Promise.reject(new DOMException("The quota has been exceeded.", "QuotaExceededError"))],
    [
      "throws as it is asked",
      () => {
        throw new Error("no storage");
      },
    ],
    ["answers with something that is no yes", (async () => 1) as unknown as FollowDeps["keep"]],
    ["is not there at all", null],
  ])("is not kept, and nothing is signed or sent, when what keeps it %s: a whole list is never replaced without a net, and it says which of the two went wrong", async (_, keep) => {
    const now = shrunk();
    const w = everywhere([now]);
    const by = signer();

    // The list was read: it is the keeping that failed, and the outcome says so.
    expect(await putBack(w, copyOf(), { by, keep })).toEqual({ kind: "not-kept" });

    expectNothingWritten(w, by);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.held).toEqual([now]);
  });

  it("is not held up for ever by a keeping that never ends: stopped, it ends at once, with nothing signed, and the next write is free to go", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const w = everywhere([shrunk()]);
    const by = signer();
    const stop = new AbortController();
    const ended = track(putBack(w, copyOf(), { by, signal: stop.signal, keep: () => new Promise<never>(() => {}) }));

    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS - 1);
    expect(ended).toEqual({});
    expect(by.signEvent).not.toHaveBeenCalled();

    const reason = new Error("signed out");
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.error).toBe(reason);
    expectNothingWritten(w, by);

    expect((await putBack(w, copyOf())).kind).toBe("saved");
    expect(locks.requests).toEqual([FOLLOW_LOCK, FOLLOW_LOCK]);
  });

  it("is not kept once the keeping has not answered in its time, whatever keeps it: the list was not kept, and nothing is signed or sent", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const now = shrunk();
    const w = everywhere([now]);
    const by = signer();
    const ended = track(putBack(w, copyOf(), { by, keep: () => new Promise<never>(() => {}) }));

    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS - 1);
    expect(ended).toEqual({});

    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome).toEqual({ kind: "not-kept" });
    expectNothingWritten(w, by);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.held).toEqual([now]);
    // The tab's turn and the lock are free: the next write is made.
    expect(vi.getTimerCount()).toBe(0);
    expect((await putBack(w, copyOf())).kind).toBe("saved");
    expect(locks.requests).toEqual([FOLLOW_LOCK, FOLLOW_LOCK]);
  });

  it("keeps it in the browser when given the app's own keeping, so that putting back can itself be put back", async () => {
    const copy = copyOf();
    const now = shrunk();
    const w = everywhere([now]);
    const keep = (list: NostrEvent, why: KeptFor, spare?: string) => keepCopy(ME, list, why, NOW, spare);

    const back = savedBy(await putBack(w, copy, { keep }));

    // The list that was replaced is the person's newest copy, and is the event the relays held.
    const copies = await keptCopies(ME);
    expect(copies).toEqual([{ list: asSent(now), at: NOW, for: { did: "put-back" } }]);

    // Putting that one back replaces the list just saved, which is kept in its turn.
    const again = savedBy(await putBack(w, copies[0]!.list, { keep, now: NOW + 60 }));
    expect(again.tags).toEqual(now.tags);
    expect(again.content).toBe(now.content);
    expect((await keptCopies(ME)).map((kept) => kept.list.id)).toEqual([back.id, now.id]);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([back, again]);
  });

  describe("with ten copies kept, and the oldest of them put back", () => {
    /** Ten lists of the person's kept a minute apart, in this browser's storage, the newest first; and the app's own keeping. */
    async function tenKept() {
      const lists = Array.from({ length: KEPT_COPIES }, (_, at) => asSent(finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + at, content: "", tags: [["p", pubkeyAt(at)]] }, SECRET)));
      for (const [at, list] of lists.entries()) expect(await keepCopy(ME, list, { did: "follow", who: pubkeyAt(at) }, NOW - 1_000 + at)).toBe(true);
      const keep = (list: NostrEvent, why: KeptFor, spare?: string) => keepCopy(ME, list, why, NOW, spare);
      return { newestFirst: [...lists].reverse(), oldest: lists[0]!, keep };
    }
    const ids = async () => (await keptCopies(ME)).map((kept) => kept.list.id);

    /** The copies after a putting back of the oldest that kept the list it would have replaced, and did not save: the oldest is still there, the last. */
    async function expectOldestStillKept(newestFirst: NostrEvent[], oldest: NostrEvent, replaced: NostrEvent) {
      // The list that would have been replaced is the newest copy; the oldest other copy made room for it.
      expect(await ids()).toEqual([replaced.id, ...newestFirst.slice(0, KEPT_COPIES - 2).map((list) => list.id), oldest.id]);
      expect((await keptCopies(ME)).at(-1)!.list).toEqual(oldest);
    }

    it("keeps that copy though the signer then says no: the relays are as they were, and it can be put back again", async () => {
      const { newestFirst, oldest, keep } = await tenKept();
      const now = shrunk();
      const w = everywhere([now]);
      const refusing = signer();
      refusing.signEvent.mockRejectedValueOnce(new Error("The person said no"));

      expect(await putBack(w, oldest, { by: refusing, keep })).toEqual({ kind: "not-approved" });

      expect(w.published()).toEqual([]);
      await expectOldestStillKept(newestFirst, oldest, now);
      // Tried again, with the copy as the storage holds it now: it is put back, and no other copy gives way for it.
      const again = (await keptCopies(ME)).at(-1)!.list;
      const saved = savedBy(await putBack(w, again, { keep, now: NOW + 60 }));
      expect(saved.tags).toEqual(oldest.tags);
      await expectOldestStillKept(newestFirst, oldest, now);
    });

    it("keeps that copy though no relay then takes the list", async () => {
      const { newestFirst, oldest, keep } = await tenKept();
      const now = shrunk();
      const refusing = () => relay([now], { writes: { refuse: "blocked: not on the list" } });
      const w = world({ [NOS]: refusing(), [DIRECTORY]: refusing(), [BIG]: refusing() });

      expect(await putBack(w, oldest, { keep })).toEqual({ kind: "not-saved" });

      await expectOldestStillKept(newestFirst, oldest, now);
    });

    it("keeps that copy though the putting back is stopped while the signer is asked", async () => {
      const { newestFirst, oldest, keep } = await tenKept();
      const now = shrunk();
      const w = everywhere([now]);
      const never = signer();
      never.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
      const stop = new AbortController();
      const ended = track(putBack(w, oldest, { by: never, keep, signal: stop.signal }));
      await vi.waitFor(() => expect(never.signEvent).toHaveBeenCalledTimes(1));

      const reason = new Error("signed out");
      stop.abort(reason);
      await vi.waitFor(() => expect(ended.error).toBe(reason));

      expect(w.published()).toEqual([]);
      await expectOldestStillKept(newestFirst, oldest, now);
    });

    it("lets the oldest go, as ever, when a newer copy is the one put back", async () => {
      const { newestFirst, keep } = await tenKept();
      const now = shrunk();
      const w = everywhere([now]);

      expect((await putBack(w, newestFirst[3]!, { keep })).kind).toBe("saved");

      expect(await ids()).toEqual([now.id, ...newestFirst.slice(0, KEPT_COPIES - 1).map((list) => list.id)]);
    });
  });

  it("waits no longer for the lock than a putting back can take, the keeping with it", () => {
    const longest = 3 * FOLLOW_READ_MS + KEEP_WAIT_MS + REQUEST_TIMEOUT_MS + 2 * PUBLISH_TIMEOUT_MS;
    expect(FOLLOW_LOCK_WAIT_MS).toBeGreaterThan(longest);
  });
});

describe("what may be put back: the person's own valid follow list, and nothing else", () => {
  const mine = () => copyOf();
  /** Another event the person's key truly signed: its id and its signature are a pair, of other fields. */
  const other = () => asSent(finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "another", tags: [["p", ABSENT]] }, SECRET));

  const cases: Array<[string, () => unknown]> = [
    ["a list with a tag changed after it was signed", () => ({ ...mine(), tags: [["p", ABSENT]] })],
    ["a list with one entry more than was signed", () => ({ ...mine(), tags: [...mine().tags, ["p", ABSENT]] })],
    ["a list with one entry fewer than was signed", () => ({ ...mine(), tags: mine().tags.slice(1) })],
    ["a list with a content changed after it was signed", () => ({ ...mine(), content: "" })],
    ["a list with a time changed after it was signed", () => ({ ...mine(), created_at: FOLLOW_LIST_TIME + 1 })],
    ["a list with a signature that is not over it", () => ({ ...mine(), sig: other().sig })],
    ["a list with a signature of another key's", () => ({ ...mine(), sig: asSent(buildFollowList(OTHER_SECRET)).sig })],
    ["a list with an id that is not the hash of its fields", () => ({ ...mine(), id: other().id })],
    ["a list with the id and the signature of another event of theirs", () => ({ ...mine(), id: other().id, sig: other().sig })],
    // nostr-tools marks an event it has signed or checked, and takes its own mark at its word.
    ["a list changed under nostr-tools' own mark of a checked event", () => Object.assign(buildFollowList(SECRET), { tags: [["p", ABSENT]] })],
    ["another person's list, though it is truly signed", () => asSent(buildFollowList(OTHER_SECRET))],
    ["another person's list given this person's key", () => ({ ...asSent(buildFollowList(OTHER_SECRET)), pubkey: ME })],
    ["an event of the person's that is no follow list: their profile", () => asSent(finalizeEvent({ kind: 0, created_at: FOLLOW_LIST_TIME, content: "{}", tags: [] }, SECRET))],
    ["an event of the person's that is no follow list: their relay list", () => asSent(finalizeEvent({ kind: 10002, created_at: FOLLOW_LIST_TIME, content: "", tags: [["r", OWN]] }, SECRET))],
    ["a truly signed event given the kind of a follow list", () => ({ ...asSent(finalizeEvent({ kind: 30000, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", ABSENT]] }, SECRET)), kind: 3 })],
    ["a list that was never signed", () => ({ kind: 3, pubkey: ME, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", ABSENT]] })],
    ["a list with a tag that is no list of words", () => ({ ...mine(), tags: [["p", 7]] })],
    ["a list whose key is written in upper-case hex", () => ({ ...mine(), pubkey: ME.toUpperCase() })],
    ["nothing", () => null],
    ["words", () => "my list"],
  ];

  it("tells a true copy from each of these: nostr-tools checks the true one as valid", () => {
    expect(verifyEvent({ ...mine() })).toBe(true);
  });

  it.each(cases)("rejects %s with a TypeError, before anything is read, locked, kept, signed or sent", async (_, given) => {
    const locks = new FakeLocks();
    useLocks(locks);
    const now = shrunk();
    const w = everywhere([now]);
    const by = signer();
    const keep = keeper();

    await expect(putBack(w, given() as NostrEvent, { by, keep })).rejects.toBeInstanceOf(TypeError);

    expect(locks.requests).toEqual([]);
    expect(w.asked()).toEqual([]);
    expect(keep).not.toHaveBeenCalled();
    expectNothingWritten(w, by);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.held).toEqual([now]);
  });

  it("rejects a copy for an account whose key is no key, as a change does", async () => {
    const w = everywhere([shrunk()]);
    const by = signer();
    const account: Account = { pubkey: "not-a-key", signer: by, how: "browser" };

    await expect(putBackList(account, mine(), depsOf(w, {}), life.signal)).rejects.toBeInstanceOf(TypeError);
    expect(w.asked()).toEqual([]);
    expectNothingWritten(w, by);
  });

  it("leaves the next write free to go after a copy that was no copy", async () => {
    const w = everywhere([shrunk()]);
    await expect(putBack(w, { ...mine(), content: "" })).rejects.toBeInstanceOf(TypeError);

    expect(savedBy(await putBack(w, mine())).tags).toEqual(mine().tags);
  });
});

describe("the fresh read a copy is put back over", () => {
  it("is not loaded, and nothing is kept, signed or sent, when no relay answers", async () => {
    const w = world({ [NOS]: down(), [DIRECTORY]: down(), [BIG]: down() }, down());
    const by = signer();
    const keep = keeper();

    expect(await putBack(w, copyOf(), { by, keep })).toEqual({ kind: "not-loaded" });

    expect(keep).not.toHaveBeenCalled();
    expectNothingWritten(w, by);
  });

  it("is not loaded when the person's relay list could not be read, though relays that hold a list would answer: where their list is kept is not known", async () => {
    const w = world({ [NOS]: relay([shrunk()]), [DIRECTORY]: down(), [BIG]: relay([shrunk()]) });
    const by = signer();
    const keep = keeper();

    expect(await putBack(w, copyOf(), { by, keep })).toEqual({ kind: "not-loaded" });

    expect(keep).not.toHaveBeenCalled();
    expectNothingWritten(w, by);
    // No relay was asked for the list.
    expect(w.asked().filter(asksForList)).toEqual([]);
  });

  it("is not loaded when the relay list is read and no relay answers the read of the list", async () => {
    const lists = () => relay([shrunk()], { reads: failingWhen(asksForList) });
    const w = world({ [NOS]: lists(), [DIRECTORY]: lists(), [BIG]: lists() });
    const by = signer();

    expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("is not loaded when the app has no relay to read a list from, as in development", async () => {
    config.followListRelays = [];
    const w = everywhere([shrunk()]);
    const by = signer();

    expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("needs no read a change could be built on: with the relay the person writes to out, the copy is put back over what the others hold, and sent to that relay too", async () => {
    const now = shrunk();
    const w = world({ [NOS]: relay([now]), [DIRECTORY]: relay([now, relayList([[OWN, "write"]])]), [BIG]: relay([now]), [OWN]: down() });
    // A change of one entry does not go on here: an old copy on the app's relays may not be the person's
    // newest list, and as every one of them holds it, the person is asked.
    expect(await follow(w, ALSO_ABSENT)).toEqual({ kind: "ask", copy: { id: now.id, changed: now.created_at } });
    const keep = keeper();
    const copy = copyOf();

    const outcome = await putBack(w, copy, { keep });

    // The person replaces the list on purpose, with a list known to be theirs; what the relays hold is kept first.
    const saved = savedBy(outcome);
    expect(saved.tags).toEqual(copy.tags);
    expect(keep.mock.calls.map(([list]) => list.id)).toEqual([now.id]);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([saved]);
    // Their own relay is sent it, answered or not: twice, as its failure may pass.
    expect(w.relays[OWN]!.writer.signals).toHaveLength(2);
  });

  it("is saved and not confirmed when it was put back over a read that is not one to trust, though every relay that took it sends it back: what the person's own relays hold could not be read", async () => {
    const now = shrunk();
    const copy = copyOf();
    const w = world({ [NOS]: relay([now]), [DIRECTORY]: relay([now, relayList([[OWN, "write"]])]), [BIG]: relay([now]), [OWN]: down() });

    const outcome = await putBack(w, copy);

    // Saved, and read back as the newest on the relays that took it: and still not said to be their list everywhere.
    const saved = savedBy(outcome);
    expect(outcome).toEqual({ kind: "saved", list: saved, confirmed: false, kept: true });
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.held.filter((event) => event.kind === 3).at(-1)).toEqual(saved);

    // The same putting back, once the relay they write to answers, is confirmed.
    forgetFollowFloor();
    const answers = world({ [NOS]: relay([now]), [DIRECTORY]: relay([now, relayList([[OWN, "write"]])]), [BIG]: relay([now]), [OWN]: relay([now]) });
    expect(await putBack(answers, copy)).toMatchObject({ kind: "saved", confirmed: true, kept: true });
  });

  it("puts a copy back where the relays answer with no list at all, keeping nothing, though the account shows use: this list is known to be theirs", async () => {
    const profile = shapedEvent({ kind: 0, pubkey: ME, content: "{}" });
    const w = everywhere([profile]);
    const keep = keeper();
    const copy = copyOf();
    // To a follow this account's list is somewhere else, and nothing is written.
    expect(await follow(w, ALSO_ABSENT)).toEqual({ kind: "not-loaded" });

    const aboutUse = () => w.asked().filter((filter) => asksForProfile(filter) || asksForFollower(filter)).length;
    const askedByTheFollow = aboutUse();
    expect(askedByTheFollow).toBeGreaterThan(0);

    const outcome = await putBack(w, copy, { keep });

    const saved = savedBy(outcome);
    expect(outcome).toEqual({ kind: "saved", list: saved, confirmed: true, kept: false });
    expect(saved.tags).toEqual(copy.tags);
    expect(saved.created_at).toBe(NOW);
    expect(keep).not.toHaveBeenCalled();
    // No relay was asked whether the account has been used: nothing is guessed here.
    expect(aboutUse()).toBe(askedByTheFollow);
  });

  it("is not loaded, and nothing is signed or sent, when no list is found by a read that cannot be trusted: with nothing to keep, a whole list would be written without a net", async () => {
    // The relay the person writes to, which is where their newest list is, is out; the others answer, with no list.
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay([relayList([[OWN, "write"]])]), [BIG]: relay(), [OWN]: down() });
    const by = signer();
    const keep = keeper();

    expect(await putBack(w, copyOf(), { by, keep })).toEqual({ kind: "not-loaded" });

    expect(keep).not.toHaveBeenCalled();
    expectNothingWritten(w, by);
    // Once that relay answers, with no list either, the read is one to trust: there is nothing to lose, and the copy is put back.
    w.relays[OWN]!.reader = relay().reader;
    w.relays[OWN]!.writer = relay().writer;
    expect((await putBack(w, copyOf(), { by, keep })).kind).toBe("saved");
    expect(keep).not.toHaveBeenCalled();
  });

  it("puts a copy back where a read that can be trusted finds no list: the relay the person writes to answers, with none", async () => {
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay([relayList([[OWN, "write"]])]), [BIG]: relay(), [OWN]: relay() });
    const keep = keeper();
    const copy = copyOf();

    const outcome = await putBack(w, copy, { keep });

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: true, kept: false });
    expect(savedBy(outcome).tags).toEqual(copy.tags);
    expect(keep).not.toHaveBeenCalled();
    expect(w.relays[OWN]!.writer.published).toEqual([savedBy(outcome)]);
  });

  it("puts a copy back with nothing to keep a list by, where there is no list to keep", async () => {
    const copy = copyOf();

    expect(savedBy(await putBack(everywhere([]), copy, { keep: null })).tags).toEqual(copy.tags);
  });

  describe("when no list is found: a kept copy is itself a sign that there was one, so enough of the app's relays must say there is none", () => {
    const SIX = [NOS, DIRECTORY, BIG, "wss://fourth.example.test", "wss://fifth.example.test", "wss://sixth.example.test"];
    /** Six follow-list relays, as production has: those of `answering` answer with no list, and the rest are out. The directory always answers. */
    function sixWith(answering: number): World {
      config.followListRelays = [...SIX];
      const first = [DIRECTORY, ...SIX.filter((url) => url !== DIRECTORY)].slice(0, answering);
      return world(Object.fromEntries(SIX.map((url) => [url, first.includes(url) ? relay() : down()])));
    }

    it("is not loaded, and nothing is signed or sent, when one of the app's relays answers with nothing and the others are out: one relay's nothing proves nothing", async () => {
      // The person is known to have no relay list, so the read is one to trust; and one relay answered it.
      const w = world({ [NOS]: down(), [DIRECTORY]: relay(), [BIG]: down() });
      const by = signer();
      const keep = keeper();

      expect(await putBack(w, copyOf(), { by, keep })).toEqual({ kind: "not-loaded" });

      expect(keep).not.toHaveBeenCalled();
      expectNothingWritten(w, by);
    });

    it.each([1, 2, 3])("is not loaded when %i of six answer with nothing: the list may be on the ones that are out", async (answering) => {
      const w = sixWith(answering);
      const by = signer();

      expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-loaded" });
      expectNothingWritten(w, by);
    });

    it("puts the copy back when four of six answer with nothing: as many as a first list needs", async () => {
      const w = sixWith(4);
      const keep = keeper();
      const copy = copyOf();

      const outcome = await putBack(w, copy, { keep });

      expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: true, kept: false });
      expect(savedBy(outcome).tags).toEqual(copy.tags);
      expect(keep).not.toHaveBeenCalled();
    });

    it("does not count the person's own relays among them: the relay they write to answers with nothing, and one of the app's three", async () => {
      const w = world({ [NOS]: down(), [DIRECTORY]: relay([relayList([[OWN, "write"]])]), [BIG]: down(), [OWN]: relay() });
      const by = signer();

      // A read to trust, as their own relay was heard from; and two relays answered it, one of them the app's.
      expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-loaded" });
      expectNothingWritten(w, by);

      // With the app's other two answering as well, the copy is put back.
      w.relays[NOS] = relay();
      w.relays[BIG] = relay();
      expect((await putBack(w, copyOf(), { by })).kind).toBe("saved");
    });

    it("needs no such number where a list is found: one relay's list is a list, and it is kept first", async () => {
      const now = shrunk();
      const w = world({ [NOS]: down(), [DIRECTORY]: relay([now]), [BIG]: down() });
      const keep = keeper();

      expect(savedBy(await putBack(w, copyOf(), { keep })).tags).toEqual(copyOf().tags);
      expect(keep.mock.calls.map(([list]) => list.id)).toEqual([now.id]);
    });
  });

  it("goes to the relays that answered and the relays the person writes to, and to no other", async () => {
    const now = shrunk();
    const ALSO_OWN = "wss://also-own.example.test";
    const READS = "wss://reads.example.test";
    const w = world({
      [NOS]: relay([now]),
      [DIRECTORY]: relay([now, relayList([[OWN, "write"], [ALSO_OWN, "write"], [READS, "read"]])]),
      // One of the app's that does not answer the read, and is not one the person writes to: it is sent nothing.
      [BIG]: relay([], { reads: failingWhen(() => true) }),
      [OWN]: relay([], { reads: failingWhen(() => true) }),
      [ALSO_OWN]: relay([now]),
      [READS]: relay(),
    });

    const saved = savedBy(await putBack(w, copyOf()));

    for (const url of [NOS, DIRECTORY, OWN, ALSO_OWN, READS]) expect(w.relays[url]!.writer.published).toEqual([saved]);
    expect(w.relays[BIG]!.writer.published).toEqual([]);
    // The review relay keeps no follow lists: it is asked for none, and sent none.
    expect(w.reviews.asked.filter(asksForList)).toEqual([]);
    expect(w.reviews.writer.published).toEqual([]);
  });
});

describe("a list older than one this tab has seen", () => {
  it("is not loaded, and nothing is kept, signed or sent, when the fresh read is older than the list on screen", async () => {
    const shown = shrunk(1_000);
    raiseFollowFloor(ME, shown);
    const w = everywhere([shrunk(500)]);
    const by = signer();
    const keep = keeper();

    expect(await putBack(w, copyOf(), { by, keep })).toEqual({ kind: "not-loaded" });

    expect(keep).not.toHaveBeenCalled();
    expectNothingWritten(w, by);
  });

  it("is not loaded when the relays send no list, and this tab has seen one", async () => {
    raiseFollowFloor(ME, shrunk());
    const w = everywhere([]);
    const by = signer();

    expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("goes on from the list on screen, or a newer one", async () => {
    const shown = shrunk(1_000);
    raiseFollowFloor(ME, shown);

    expect((await putBack(everywhere([shown]), copyOf())).kind).toBe("saved");
    forgetFollowFloor();
    raiseFollowFloor(ME, shown);
    expect((await putBack(everywhere([shrunk(2_000)]), copyOf())).kind).toBe("saved");
  });

  it("holds the next write to the list it saved: a change that finds only the list it replaced is not loaded", async () => {
    const now = shrunk();
    // The relays take the list that is put back, and go on sending the one before it.
    const w = everywhere([now], { lags: true });
    const outcome = await putBack(w, copyOf());
    expect(outcome).toMatchObject({ kind: "saved", confirmed: false });
    const by = signer();

    expect(await follow(w, ALSO_ABSENT, { by, now: NOW + 10 })).toEqual({ kind: "not-loaded" });
    expect(await putBack(w, copyOf(), { by, now: NOW + 10 })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
  });

  it("holds the next write to the list it read, though it saved nothing", async () => {
    const newer = shrunk(1_000);
    let nosDown = false;
    const w = world({ [NOS]: relay([newer], { reads: failingWhen(() => nosDown) }), [DIRECTORY]: relay([shrunk(500)]), [BIG]: relay([shrunk(500)]) });
    const refusing = signer();
    refusing.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    expect(await putBack(w, copyOf(), { by: refusing })).toEqual({ kind: "not-approved" });
    nosDown = true;
    const by = signer();

    expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("is looked at again just before the copy is sent: a newer list seen while the signer signs stops it, which sends nothing and is not loaded, and the relays keep that list", async () => {
    const w = everywhere([shrunk(1_000)]);
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent(structuredClone(asked), SECRET));
        }),
    );
    const ended = track(putBack(w, copyOf(), { by }));
    await vi.waitFor(() => expect(by.signEvent).toHaveBeenCalledTimes(1));

    // While the signer is still signing, another app saves a newer list, and this tab sees it, as its page reads the list meanwhile.
    const newer = shrunk(2_000);
    for (const url of [NOS, DIRECTORY, BIG]) w.relays[url]!.held.push(newer);
    raiseFollowFloor(ME, newer);
    sign();
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS);

    expect(ended.outcome).toEqual({ kind: "not-loaded" });
    // The copy it signed was sent to no relay, dated later than the newer list: sent, it would have taken that list's place.
    expect(w.published()).toEqual([]);
    expect(by.signEvent.mock.calls[0]![0].created_at).toBeGreaterThan(newer.created_at);
    // Each relay holds the newer list as its newest still.
    for (const url of [NOS, DIRECTORY, BIG]) {
      expect(w.relays[url]!.held.filter((event) => event.kind === 3).sort((a, b) => b.created_at - a.created_at)[0]).toEqual(newer);
    }
  });
});

describe("when the list is as the copy says already", () => {
  it("is unchanged, keeping, signing and sending nothing, when the newest list has the copy's content and tags", async () => {
    const copy = copyOf();
    // Another app saved the same list again since: another event, and the same list.
    const same = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + 100, content: copy.content, tags: copy.tags }, SECRET);
    const w = everywhere([same]);
    const by = signer();
    const keep = keeper();

    expect(await putBack(w, copy, { by, keep })).toEqual({ kind: "unchanged", list: asSent(same) });

    expect(keep).not.toHaveBeenCalled();
    expectNothingWritten(w, by);
  });

  it("is unchanged when the copy is the very list the relays hold", async () => {
    const copy = copyOf();
    const w = everywhere([copy]);
    const by = signer();

    expect(await putBack(w, copy, { by })).toEqual({ kind: "unchanged", list: copy });
    expectNothingWritten(w, by);
  });

  describe("with the relay the person writes to named by their relay list", () => {
    /** The app's three relays hold `held` (the directory their relay list too), and their own relay holds `own`. */
    const withOwn = (held: NostrEvent, own: Relay): World =>
      world({ [NOS]: relay([held]), [DIRECTORY]: relay([held, relayList([[OWN, "write"]])]), [BIG]: relay([held]), [OWN]: own });

    it("is unchanged over a read to trust: their relay answers, and its newest list has the copy's content and tags, as the others' does", async () => {
      const copy = copyOf();
      const same = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + 100, content: copy.content, tags: copy.tags }, SECRET);
      const w = withOwn(same, relay([same]));
      const by = signer();
      const keep = keeper();

      expect(await putBack(w, copy, { by, keep })).toEqual({ kind: "unchanged", list: asSent(same) });

      expect(keep).not.toHaveBeenCalled();
      expectNothingWritten(w, by);
    });

    it("is not loaded, and never unchanged, over a read that is not one to trust: the others' newest list has the copy's content and tags, and their relay, which may hold a newer one, is out", async () => {
      const copy = copyOf();
      const same = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + 100, content: copy.content, tags: copy.tags }, SECRET);
      // Their own relay holds a newer list, which the read cannot reach.
      const own = down();
      own.held.push(shrunk(2_000));
      const w = withOwn(same, own);
      const by = signer();
      const keep = keeper();

      expect(await putBack(w, copy, { by, keep })).toEqual({ kind: "not-loaded" });

      expect(keep).not.toHaveBeenCalled();
      expectNothingWritten(w, by);
    });
  });

  it("is unchanged the second time a copy is put back", async () => {
    const copy = copyOf();
    const w = everywhere([shrunk()]);
    const first = savedBy(await putBack(w, copy));
    const by = signer();

    expect(await putBack(w, copy, { by, now: NOW + 60 })).toEqual({ kind: "unchanged", list: asSent(first) });
    expect(by.signEvent).not.toHaveBeenCalled();
  });
});

describe("a signer that returns something else than the copy it was asked to sign", () => {
  const changed: Array<[string, (asked: EventTemplate) => EventTemplate]> = [
    ["adds a tag of its own", (asked) => ({ ...asked, tags: [...asked.tags, ["client", "an-app"]] })],
    ["leaves an entry out", (asked) => ({ ...asked, tags: asked.tags.slice(1) })],
    ["puts two entries in each other's place", (asked) => ({ ...asked, tags: [asked.tags[1]!, asked.tags[0]!, ...asked.tags.slice(2)] })],
    ["changes one value of one entry", (asked) => ({ ...asked, tags: asked.tags.map((tag, i) => (i === 2 ? [...tag.slice(0, -1), "another-name"] : tag)) })],
    ["empties the content", (asked) => ({ ...asked, content: "" })],
    ["changes the time", (asked) => ({ ...asked, created_at: asked.created_at + 1 })],
    ["changes the kind", (asked) => ({ ...asked, kind: 30_000 })],
  ];

  it.each(changed)("is not saved, and nothing is sent, when the signer %s", async (_, change) => {
    const now = shrunk();
    const w = everywhere([now]);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => finalizeEvent(change(structuredClone(asked)), SECRET));

    expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-saved" });

    expect(w.published()).toEqual([]);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.held).toEqual([now]);
  });

  it("is not saved when the signer signs as someone else", async () => {
    const w = everywhere([shrunk()]);

    expect(await putBack(w, copyOf(), { by: signer(OTHER_SECRET) })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("is not saved when the signer returns the copy itself: an old event is not sent again in place of a new one", async () => {
    const copy = copyOf();
    const w = everywhere([shrunk()]);
    const by = signer();
    by.signEvent.mockResolvedValueOnce(copy);

    expect(await putBack(w, copy, { by })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it.each<[string, (signed: NostrEvent, other: NostrEvent) => NostrEvent]>([
    ["the right fields with a signature that is not over them", (signed, other) => ({ ...asSent(signed), sig: other.sig })],
    ["the right fields with an id that is not their hash", (signed, other) => ({ ...asSent(signed), id: other.id })],
    ["a wrong signature under nostr-tools' own mark of a checked event", (signed, other) => ({ ...signed, sig: other.sig })],
  ])("is not saved when the signer returns %s", async (_, forged) => {
    const w = everywhere([shrunk()]);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => {
      const signed = finalizeEvent(structuredClone(asked), SECRET);
      const other = finalizeEvent({ ...structuredClone(asked), content: "another event" }, SECRET);
      return forged(signed, other);
    });

    expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("is not saved when the signer changes what it was handed, and signs that", async () => {
    const w = everywhere([shrunk()]);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => {
      asked.tags.pop();
      return finalizeEvent(asked, SECRET);
    });

    expect(await putBack(w, copyOf(), { by })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("is not approved, and nothing is sent, when the signer says no: the list that was kept stays kept", async () => {
    const now = shrunk();
    const w = everywhere([now]);
    const by = signer();
    by.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    const keep = keeper();

    expect(await putBack(w, copyOf(), { by, keep })).toEqual({ kind: "not-approved" });

    expect(w.published()).toEqual([]);
    expect(keep).toHaveBeenCalledTimes(1);
  });
});

describe("one write at a time", () => {
  /** A signer that takes `ms` to sign. */
  function slowSigner(ms: number) {
    const by = signer();
    by.signEvent.mockImplementation(async (asked) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return finalizeEvent(structuredClone(asked), SECRET);
    });
    return by;
  }

  /** A tab of the app: a copy of the code of its own, as another tab has, set up as this one is. */
  async function openTab() {
    vi.resetModules();
    const tab = await import("../src/follow/change");
    setUpRelays((await import("../src/config")).config);
    return tab;
  }

  it("makes a follow tapped while a copy is being put back wait, and build on the list that was put back (no Web Locks)", async () => {
    const copy = copyOf();
    const w = everywhere([shrunk()]);

    const first = putBack(w, copy, { by: slowSigner(1_000) });
    const second = follow(w, ALSO_ABSENT);
    await vi.advanceTimersByTimeAsync(1_000);

    const back = savedBy(await first);
    const followed = savedBy(await second);
    expect(back.tags).toEqual(copy.tags);
    expect(followed.tags).toEqual([...copy.tags, ["p", ALSO_ABSENT]]);
    expect(followed.created_at).toBe(back.created_at + 1);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([back, followed]);
  });

  it("makes a copy put back while a follow is being saved wait, and replace the list the follow saved, which is kept first", async () => {
    const copy = copyOf();
    const now = shrunk();
    const w = everywhere([now]);
    const keep = keeper();

    const first = follow(w, ALSO_ABSENT, { by: slowSigner(1_000), keep });
    const second = putBack(w, copy, { keep });
    await vi.advanceTimersByTimeAsync(1_000);

    const followed = savedBy(await first);
    const back = savedBy(await second);
    expect(followed.tags).toEqual([...now.tags, ["p", ALSO_ABSENT]]);
    expect(back.tags).toEqual(copy.tags);
    expect(keep.mock.calls.map(([list, why]) => [list.id, why.did])).toEqual([
      [now.id, "follow"],
      [followed.id, "put-back"],
    ]);
  });

  it("holds the browser's follow lock, the one a change holds", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const w = everywhere([shrunk()]);

    await putBack(w, copyOf());

    expect(locks.requests).toEqual([FOLLOW_LOCK]);
  });

  it("holds it across tabs: a follow in a second tab waits for the first tab's putting back, and builds on what it saved", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const copy = copyOf();
    const w = everywhere([shrunk()]);
    const firstTab = await openTab();
    const secondTab = await openTab();
    // Two copies of the code: neither knows of the other's writes but through the browser's lock.
    expect(secondTab.changeFollow).not.toBe(firstTab.changeFollow);

    const slow = slowSigner(1_000);
    const first = putBack(w, copy, { by: slow }, firstTab.putBackList);
    // The first tab's putting back is with its signer, and holds the lock, when the second tab's follow is tapped.
    await vi.waitFor(() => expect(slow.signEvent).toHaveBeenCalledTimes(1));
    const second = follow(w, ALSO_ABSENT, {}, secondTab.changeFollow);
    await vi.advanceTimersByTimeAsync(1_000);

    const back = savedBy(await first);
    expect(savedBy(await second).tags).toEqual([...copy.tags, ["p", ALSO_ABSENT]]);
    expect(locks.requests).toEqual([FOLLOW_LOCK, FOLLOW_LOCK]);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published[0]).toEqual(back);
  });

  it("holds it across tabs the other way: a copy put back in a second tab waits for the first tab's follow, and replaces the list it saved", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const copy = copyOf();
    const now = shrunk();
    const w = everywhere([now]);
    const firstTab = await openTab();
    const secondTab = await openTab();
    const keep = keeper();

    const first = follow(w, ALSO_ABSENT, { by: slowSigner(1_000) }, firstTab.changeFollow);
    const second = putBack(w, copy, { keep }, secondTab.putBackList);
    await vi.advanceTimersByTimeAsync(1_000);

    const followed = savedBy(await first);
    expect(savedBy(await second).tags).toEqual(copy.tags);
    // What the second tab kept is the list the first tab's follow saved, not the one before it.
    expect(keep.mock.calls.map(([list]) => list.id)).toEqual([followed.id]);
    expect(locks.requests).toEqual([FOLLOW_LOCK, FOLLOW_LOCK]);
  });

  it("reads the list afresh under the lock, once to put the copy back over and once to read it back", async () => {
    const w = everywhere([shrunk()]);

    await putBack(w, copyOf());

    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.asked.filter(asksForList)).toHaveLength(2);
  });
});

describe("reading it back", () => {
  it("is saved but not confirmed when no relay that took it sends it back yet", async () => {
    const w = everywhere([shrunk()], { lags: true });

    const outcome = await putBack(w, copyOf());

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: false, kept: true });
  });

  it("is saved but not confirmed when the read-back finds a newer list, saved by another app meanwhile", async () => {
    const w = everywhere([shrunk()]);
    const theirs = finalizeEvent({ kind: 3, created_at: NOW + 5, content: "", tags: [["p", pubkeyAt(7)]] }, SECRET);
    const nos = w.relays[NOS]!;
    const taking = nos.writer.publish.bind(nos.writer);
    nos.writer.publish = async (event, signal) => {
      await taking(event, signal);
      nos.held.push(theirs);
    };

    const outcome = await putBack(w, copyOf());

    expect(outcome).toMatchObject({ kind: "saved", confirmed: false });
    expect(savedBy(outcome).tags).toEqual(copyOf().tags);
  });

  it("is saved but not confirmed when a relay refuses it as holding a newer one", async () => {
    const now = shrunk();
    const w = world({ [NOS]: relay([now], { writes: { refuse: "replaced: have newer event" } }), [DIRECTORY]: relay([now]), [BIG]: relay([now]) });

    expect(await putBack(w, copyOf())).toMatchObject({ kind: "saved", confirmed: false });
  });

  it("is not saved when no relay takes it", async () => {
    const now = shrunk();
    const refusing = () => relay([now], { writes: { refuse: "blocked: not on the list" } });
    const w = world({ [NOS]: refusing(), [DIRECTORY]: refusing(), [BIG]: refusing() });

    expect(await putBack(w, copyOf())).toEqual({ kind: "not-saved" });
    for (const each of Object.values(w.relays)) expect(each.held).toEqual([now]);
  });
});

describe("stopping it", () => {
  const reason = new Error("signed out");

  it("rejects at once, having read nothing, when its signal has aborted already", async () => {
    const w = everywhere([shrunk()]);
    const stop = new AbortController();
    stop.abort(reason);

    await expect(putBack(w, copyOf(), { signal: stop.signal })).rejects.toBe(reason);
    expect(w.asked()).toEqual([]);
  });

  it("rejects with the signal's reason when stopped while the signer is asked, and then sends nothing", async () => {
    const w = everywhere([shrunk()]);
    const stop = new AbortController();
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent(structuredClone(asked), SECRET));
        }),
    );
    const ended = track(putBack(w, copyOf(), { by, signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(10);
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.error).toBe(reason);

    sign();
    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);
    expect(w.published()).toEqual([]);
  });
});
