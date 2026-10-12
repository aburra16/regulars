import type { NostrEvent } from "@nostrify/nostrify";
import type { EventTemplate } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Account, type How, REQUEST_TIMEOUT_MS } from "../src/account/session";
import { config } from "../src/config";
import {
  changeFollow,
  FOLLOW_LOCK,
  FOLLOW_LOCK_WAIT_MS,
  FOLLOW_SETTLE_MS,
  type FollowDeps,
  type FollowOutcome,
  forgetFollowFloor,
  raiseFollowFloor,
} from "../src/follow/change";
import { FOLLOW_READ_MS, NEW_LIST_QUORUM } from "../src/follow/read";
import type { RelayReader, RelayWriter } from "../src/nostr/events";
import { PUBLISH_TIMEOUT_MS, SIGN_TIMEOUT_MS } from "../src/nostr/send";
import {
  ABSENT,
  buildFollowList,
  DUPLICATE_AGAIN_AT,
  DUPLICATE_AT,
  DUPLICATED,
  FOLLOW_LIST_SIZE,
  FOLLOW_LIST_TIME,
  pubkeyAt,
  UPPER_CASE_AT,
  UPPER_CASE_KEY,
} from "./fixtures/follow-list";
import { shapedEvent } from "./support/events";
import {
  asksForFollower,
  asksForList,
  asksForProfile,
  asksForRelayList,
  BIG,
  DIRECTORY,
  everywhere,
  failingWhen,
  NOS,
  OWN,
  type Relay,
  relay,
  setUpRelays,
  silentWhen,
  strangers,
  type World,
  world,
} from "./support/followWorld";
import { FakeLocks, useLocks } from "./support/locks";

/*
 * Changing a follow list (kind 3): `changeFollow`, the only code that writes one. A list is one
 * record, and saving it replaces the whole of it in every app the person uses, so these hold the
 * change to its safeguards: one at a time, read fresh, never a guessed list, one entry changed and
 * the rest as it was, the signed event exactly what was built, saved where it was read, read back.
 * Relays are held in memory, the keys are thrown away, and the clock is fake; nothing opens a socket.
 */

/** Three more follow-list relays, for the tests that have six of them, as production has. */
const FOURTH = "wss://fourth.example.test";
const FIFTH = "wss://fifth.example.test";
const SIXTH = "wss://sixth.example.test";
/** A relay the person only reads from. */
const READS = "wss://reads.example.test";
/** A second relay the person writes to. */
const ALSO_OWN = "wss://also-own.example.test";

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const SOMEONE_ELSE = generateSecretKey();

/** A second person the synthetic list does not name. */
const ALSO_ABSENT = pubkeyAt(20_001);

/** The clock, in seconds: after the synthetic list was made. */
const NOW = FOLLOW_LIST_TIME + 500;

const down = () => relay([], { reads: failingWhen(() => true), writes: { refuse: "error: down" } });

/** The person's relay list (kind 10002): each entry is `[url]`, `[url, "read"]` or `[url, "write"]`. */
const relayList = (entries: string[][]) => shapedEvent({ kind: 10002, pubkey: ME, tags: entries.map((entry) => ["r", ...entry]) });

// ---------------------------------------------------------------------------------------------
// The person, and their signer.
// ---------------------------------------------------------------------------------------------

/** A signer as an add-on is: it signs what it is asked to with the person's key. */
function signer(key = SECRET) {
  return {
    getPublicKey: async () => getPublicKey(key),
    signEvent: vi.fn(async (asked: EventTemplate): Promise<NostrEvent> => finalizeEvent(structuredClone(asked), key)),
  };
}

interface Options {
  by?: ReturnType<typeof signer>;
  signal?: AbortSignal;
  now?: number;
  signWithin?: number;
  how?: How;
}

/**
 * Aborts when each test ends. Every change is stopped by it, so that one a failed test left under
 * way ends there: the code keeps a tab's changes in turn, and it would hold up every test after it.
 */
let life: AbortController;

/** What a change does: a follow, an unfollow, or putting back what an unfollow took out. */
type Action = Parameters<typeof changeFollow>[2];

/** The person follows or unfollows `who`, or has what an unfollow took out of their list put back, over the relays of `w`. */
function change(w: World, who: string, action: Action, opts: Options = {}, tab = changeFollow): Promise<FollowOutcome> {
  const account: Account = { pubkey: ME, signer: opts.by ?? signer(), how: opts.how ?? "browser" };
  const deps: FollowDeps = { readers: w.readers, writers: w.writers, now: () => opts.now ?? NOW, signWithin: opts.signWithin };
  const signal = opts.signal === undefined ? life.signal : AbortSignal.any([opts.signal, life.signal]);
  return tab(account, who, action, deps, signal);
}

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** How a change ended, once it has: its outcome, or what it threw. Neither while it goes on. */
function track(changing: Promise<FollowOutcome>) {
  const ended: { outcome?: FollowOutcome; error?: unknown } = {};
  changing.then(
    (outcome) => (ended.outcome = outcome),
    (error: unknown) => (ended.error = error),
  );
  return ended;
}

/** The list a change saved; fails the test when it did not save one. */
function savedBy(outcome: FollowOutcome | undefined): NostrEvent {
  if (outcome?.kind !== "saved") throw new Error(`Not saved: ${JSON.stringify(outcome?.kind)}`);
  return outcome.list;
}

/** What the app logs, on any level: nothing here may be, as a list and its relays are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  life = new AbortController();
  setUpRelays(config);
  // Each test starts as a tab just opened: no list seen yet.
  forgetFollowFloor();
  logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    // No timer of a change outlives it.
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    life.abort(new Error("The test is over"));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    useLocks(undefined);
  }
});

// ---------------------------------------------------------------------------------------------

describe("a follow, on a list of 1,200 entries", () => {
  it("saves the old list with one p tag more, at its end, and everything else as it was", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const by = signer();

    const outcome = await change(w, ABSENT, "follow", { by });

    const saved = savedBy(outcome);
    expect(outcome).toEqual({ kind: "saved", list: saved, confirmed: true });
    expect(verifyEvent(saved)).toBe(true);
    expect(saved.pubkey).toBe(ME);
    expect(saved.kind).toBe(3);
    expect(saved.content).toBe(old.content);
    expect(saved.created_at).toBe(NOW);
    // Every tag the old list had, each as it was and in its place, and then the one new entry.
    expect(saved.tags).toHaveLength(FOLLOW_LIST_SIZE + 1);
    expect(saved.tags.slice(0, FOLLOW_LIST_SIZE)).toEqual(old.tags);
    expect(saved.tags[FOLLOW_LIST_SIZE]).toEqual(["p", ABSENT]);
  });

  it("asks the signer once, for exactly that, and sends what it signed once to each relay that answered", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const by = signer();

    const saved = savedBy(await change(w, ABSENT, "follow", { by }));

    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(by.signEvent).toHaveBeenCalledWith({ kind: 3, created_at: NOW, content: old.content, tags: [...old.tags, ["p", ABSENT]] });
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([saved]);
  });

  it("is made one second after the old list when the clock is behind it", async () => {
    const w = everywhere([buildFollowList(SECRET)]);

    expect(savedBy(await change(w, ABSENT, "follow", { now: FOLLOW_LIST_TIME - 1_000 })).created_at).toBe(FOLLOW_LIST_TIME + 1);
  });

  it("builds on the newest list the relays hold, and sends the result to the relay that held an older one too", async () => {
    const older = buildFollowList(SECRET, FOLLOW_LIST_TIME - 100);
    const newest = finalizeEvent(
      { kind: 3, created_at: FOLLOW_LIST_TIME, content: older.content, tags: [...older.tags, ["p", ALSO_ABSENT]] },
      SECRET,
    );
    const w = world({ [NOS]: relay([older]), [DIRECTORY]: relay([newest]), [BIG]: relay() });

    const saved = savedBy(await change(w, ABSENT, "follow"));

    expect(saved.tags).toEqual([...newest.tags, ["p", ABSENT]]);
    expect(w.relays[NOS]!.writer.published).toEqual([saved]);
    expect(w.relays[BIG]!.writer.published).toEqual([saved]);
  });

  it("adds a person asked for in upper-case hex in lower case", async () => {
    const w = everywhere([buildFollowList(SECRET)]);

    expect(savedBy(await change(w, ABSENT.toUpperCase(), "follow")).tags.at(-1)).toEqual(["p", ABSENT]);
  });
});

describe("an unfollow, on a list of 1,200 entries", () => {
  it("saves the old list without the entries that name the person, and everything else as it was", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const by = signer();

    const outcome = await change(w, DUPLICATED, "unfollow", { by });

    const saved = savedBy(outcome);
    // With what it took out, each entry as the list wrote it and where it was, for Undo (ruling R20).
    expect(outcome).toEqual({
      kind: "saved",
      list: saved,
      confirmed: true,
      removed: [
        { index: DUPLICATE_AT, tag: ["p", DUPLICATED] },
        { index: DUPLICATE_AGAIN_AT, tag: ["p", DUPLICATED, "wss://relay.example.test", "met twice"] },
      ],
    });
    expect(verifyEvent(saved)).toBe(true);
    expect(saved.content).toBe(old.content);
    expect(saved.created_at).toBe(NOW);
    // The person was named twice: both entries go, and every other tag stays, each as it was and in its place.
    expect(saved.tags).toHaveLength(FOLLOW_LIST_SIZE - 2);
    expect(saved.tags).toEqual(old.tags.filter((_, place) => place !== DUPLICATE_AT && place !== DUPLICATE_AGAIN_AT));
    expect(by.signEvent).toHaveBeenCalledTimes(1);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([saved]);
  });

  it("takes out a person the list wrote in upper-case hex, asked for in either case", async () => {
    const old = buildFollowList(SECRET);

    const saved = savedBy(await change(everywhere([old]), UPPER_CASE_KEY.toUpperCase(), "unfollow"));

    expect(saved.tags).toEqual(old.tags.filter((_, place) => place !== UPPER_CASE_AT));
  });

  it("then a follow brings the list back, entry for entry", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);

    await change(w, pubkeyAt(1_199), "unfollow");
    const back = savedBy(await change(w, pubkeyAt(1_199), "follow", { now: NOW + 10 }));

    // The last entry carried a petname, which an unfollow and a follow do not keep; the rest is as it was.
    expect(back.tags.slice(0, -1)).toEqual(old.tags.slice(0, -1));
    expect(back.tags.at(-1)).toEqual(["p", pubkeyAt(1_199)]);
    expect(back.content).toBe(old.content);
  });
});

describe("Undo: putting back what an unfollow took out (ruling R20)", () => {
  /** The person unfollows `who`: the list that left, and what Undo is given of it. */
  async function unfollowed(w: World, who: string, opts: Options = {}) {
    const outcome = await change(w, who, "unfollow", opts);
    if (outcome.kind !== "saved" || outcome.removed === undefined) throw new Error("Not an unfollow that saved");
    return { left: outcome.list, undo: { restore: outcome.removed, left: outcome.list.id } };
  }

  it.each([
    ["with a relay hint and a petname", pubkeyAt(10)],
    ["named twice, once plainly and once with a hint and a petname: both entries, each in its place", DUPLICATED],
    ["written in upper-case hex, as the list wrote it", UPPER_CASE_KEY],
    ["at the end of the list, with a petname", pubkeyAt(FOLLOW_LIST_SIZE - 1)],
  ])("returns the list to what it was before the unfollow, byte for byte and in order, for a person %s", async (_, who) => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const { left, undo } = await unfollowed(w, who);
    expect(left.tags).not.toEqual(old.tags);

    const outcome = await change(w, who, undo, { now: NOW + 5 });

    const back = savedBy(outcome);
    // Saved as any change is, and with nothing to undo in its turn.
    expect(outcome).toEqual({ kind: "saved", list: back, confirmed: true });
    expect(verifyEvent(back)).toBe(true);
    expect(JSON.stringify(back.tags)).toBe(JSON.stringify(old.tags));
    expect(back.content).toBe(old.content);
    expect(back.kind).toBe(3);
    expect(back.pubkey).toBe(ME);
    // Only its time is later: after the unfollow's, which was after the old list's.
    expect(back.created_at).toBe(NOW + 5);
    expect(back.created_at).toBeGreaterThan(left.created_at);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([left, back]);
  });

  it("asks the signer once, for exactly the list as it was", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const { undo } = await unfollowed(w, DUPLICATED);
    const by = signer();

    await change(w, DUPLICATED, undo, { by, now: NOW + 5 });

    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(by.signEvent).toHaveBeenCalledWith({ kind: 3, created_at: NOW + 5, content: old.content, tags: old.tags });
  });

  it("is not saved, and nothing is sent, when the signer adds a tag of its own to it, as for any change", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const { undo } = await unfollowed(w, DUPLICATED);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => finalizeEvent({ ...asked, tags: [...asked.tags, ["client", "an-app"]] }, SECRET));
    const sent = w.published().length;

    expect(await change(w, DUPLICATED, undo, { by, now: NOW + 5 })).toEqual({ kind: "not-saved" });
    expect(w.published()).toHaveLength(sent);
  });

  it("puts them at the end, not among other neighbours, when another change has landed since the unfollow", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const { left, undo } = await unfollowed(w, DUPLICATED);
    // Another app has since taken out the first entry of the list, and followed someone: every place after it has moved.
    const since = finalizeEvent(
      { kind: 3, created_at: left.created_at + 1, content: left.content, tags: [...left.tags.slice(1), ["p", ABSENT]] },
      SECRET,
    );
    for (const url of [NOS, DIRECTORY, BIG]) w.relays[url]!.held.push(since);

    const back = savedBy(await change(w, DUPLICATED, undo, { now: NOW + 5 }));

    expect(back.tags).toEqual([...since.tags, ["p", DUPLICATED], ["p", DUPLICATED, "wss://relay.example.test", "met twice"]]);
    expect(back.content).toBe(old.content);
  });

  it("puts them at the end when this tab has followed someone else since, too", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const { left, undo } = await unfollowed(w, pubkeyAt(10));
    await change(w, ABSENT, "follow", { now: NOW + 2 });

    const back = savedBy(await change(w, pubkeyAt(10), undo, { now: NOW + 5 }));

    expect(back.tags).toEqual([...left.tags, ["p", ABSENT], ["p", pubkeyAt(10), "wss://relay.example.test", "petname-10"]]);
  });

  it("is unchanged, signing and sending nothing, when the list names the person again already", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const { undo } = await unfollowed(w, pubkeyAt(10));
    const again = savedBy(await change(w, pubkeyAt(10), "follow", { now: NOW + 2 }));
    const by = signer();
    const sent = w.published().length;

    expect(await change(w, pubkeyAt(10), undo, { by, now: NOW + 5 })).toEqual({ kind: "unchanged", list: asSent(again) });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toHaveLength(sent);
  });

  it("reads the list afresh, under the lock, as any change does", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const { undo } = await unfollowed(w, pubkeyAt(10));
    const readsBefore = w.relays[NOS]!.asked.filter(asksForList).length;

    await change(w, pubkeyAt(10), undo, { now: NOW + 5 });

    expect(locks.requests).toEqual([FOLLOW_LOCK, FOLLOW_LOCK]);
    // Once to build on, and once to read it back.
    expect(w.relays[NOS]!.asked.filter(asksForList)).toHaveLength(readsBefore + 2);
  });

  it("is not loaded, and nothing is signed, when only a list older than the unfollow's is found (ruling R9)", async () => {
    const old = buildFollowList(SECRET);
    // The relays take the unfollow's list, and go on sending the one before it.
    const w = world({ [NOS]: relay([old], { lags: true }), [DIRECTORY]: relay([old], { lags: true }), [BIG]: relay([old], { lags: true }) });
    const { undo } = await unfollowed(w, pubkeyAt(10));
    const by = signer();

    expect(await change(w, pubkeyAt(10), undo, { by, now: NOW + 5 })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
  });

  describe("when no relay sends a list to put them back into", () => {
    /** What an unfollow of `who` took out of the list, and the list it left, as Undo is given them; and relays that hold `held` now. */
    async function undoOver(held: NostrEvent[], who = pubkeyAt(10)) {
      const { undo } = await unfollowed(everywhere([buildFollowList(SECRET)]), who);
      return { who, undo, w: everywhere(held) };
    }

    it("is not loaded, and nothing is signed or sent, though every relay answers and shows no sign of the account: the list the unfollow left is known to be somewhere", async () => {
      // The relays answer, all three, with no list, no profile and nobody who follows the account: to
      // a follow, this is a new account. But this tab saved the list the unfollow left, a moment ago.
      const { who, undo, w } = await undoOver([]);
      const by = signer();

      expect(await change(w, who, undo, { by, now: NOW + 5 })).toEqual({ kind: "not-loaded" });

      expect(by.signEvent).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
    });

    it("makes no list out of what it was to put back even in a tab that has seen no list: a new account has nothing to put back", async () => {
      const { who, undo, w } = await undoOver([]);
      // As at sign-out, or in another tab: nothing this tab saw of the list holds the change back.
      forgetFollowFloor();
      const by = signer();

      expect(await change(w, who, undo, { by, now: NOW + 5 })).toEqual({ kind: "not-loaded" });

      // Nothing was signed, so no list of that one entry replaced whatever the person has elsewhere.
      expect(by.signEvent).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
      // The same relays, asked for a follow, do take the account for new: the difference is the Undo's alone.
      expect((await change(w, ABSENT, "follow", { now: NOW + 6 })).kind).toBe("saved");
    });

    it("is not loaded when the account shows use, as for any change", async () => {
      const { who, undo, w } = await undoOver([shapedEvent({ kind: 0, pubkey: ME, content: "{}" })]);
      forgetFollowFloor();
      const by = signer();

      expect(await change(w, who, undo, { by, now: NOW + 5 })).toEqual({ kind: "not-loaded" });
      expect(by.signEvent).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
    });

    it("is not loaded when no relay answers at all", async () => {
      const { who, undo } = await undoOver([]);
      forgetFollowFloor();
      const w = world({ [NOS]: down(), [DIRECTORY]: down(), [BIG]: down() });
      const by = signer();

      expect(await change(w, who, undo, { by, now: NOW + 5 })).toEqual({ kind: "not-loaded" });
      expect(by.signEvent).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
    });
  });

  it("is not approved, and nothing is sent, when the signer says no", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const { undo } = await unfollowed(w, pubkeyAt(10));
    const by = signer();
    by.signEvent.mockRejectedValueOnce(new Error("User rejected"));
    const sent = w.published().length;

    expect(await change(w, pubkeyAt(10), undo, { by, now: NOW + 5 })).toEqual({ kind: "not-approved" });
    expect(w.published()).toHaveLength(sent);
  });

  it("puts back what it was given when asked: what the caller does to that after changes nothing", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const { undo } = await unfollowed(w, pubkeyAt(10));

    const changing = change(w, pubkeyAt(10), undo, { now: NOW + 5 });
    undo.restore[0]!.tag[1] = ABSENT;
    undo.restore[0]!.index = 0;
    undo.restore.push({ index: 1, tag: ["p", ALSO_ABSENT] });

    expect(savedBy(await changing).tags).toEqual(old.tags);
  });

  const mine = (index = 10): { index: number; tag: string[] } => ({ index, tag: ["p", pubkeyAt(10), "wss://relay.example.test", "petname-10"] });
  it.each<[string, unknown]>([
    ["an entry for someone else", { restore: [mine(), { index: 11, tag: ["p", ABSENT] }], left: "0".repeat(64) }],
    ["only an entry for someone else", { restore: [{ index: 10, tag: ["p", ABSENT] }], left: "0".repeat(64) }],
    ["a tag that is not a p tag", { restore: [mine(), { index: 11, tag: ["e", pubkeyAt(10)] }], left: "0".repeat(64) }],
    ["a tag that is no list of words", { restore: [{ index: 10, tag: ["p", pubkeyAt(10), 7] }], left: "0".repeat(64) }],
    ["a tag that is no tag", { restore: [{ index: 10, tag: "p" }], left: "0".repeat(64) }],
    ["an entry that is none", { restore: [null], left: "0".repeat(64) }],
    ["nothing", { restore: [], left: "0".repeat(64) }],
    ["no entries at all", { left: "0".repeat(64) }],
    ["entries that are no list", { restore: "p", left: "0".repeat(64) }],
    ["a place before the list's first", { restore: [mine(-1)], left: "0".repeat(64) }],
    ["a place that is no whole number", { restore: [mine(1.5)], left: "0".repeat(64) }],
    ["no list that the unfollow left", { restore: [mine()] }],
    ["something that is no list's id for the one it left", { restore: [mine()], left: "the last one" }],
    ["nothing to do", null],
  ])("rejects a putting back of %s with a TypeError, before anything is read, locked, signed or sent", async (_, action) => {
    const locks = new FakeLocks();
    useLocks(locks);
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();

    await expect(change(w, pubkeyAt(10), action as Action, { by })).rejects.toBeInstanceOf(TypeError);
    expect(locks.requests).toEqual([]);
    expect(Object.values(w.relays).flatMap((each) => each.asked)).toEqual([]);
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });
});

describe("where a changed list goes", () => {
  it("goes to the relays that answered and to the relays the person writes to, answered or not, and to no other", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay([old]),
      [DIRECTORY]: relay([old, relayList([[OWN, "write"], [ALSO_OWN, "write"], [READS, "read"]])]),
      // One of the app's that does not answer the read, and is not one the person writes to: it is sent nothing.
      [BIG]: relay([], { reads: failingWhen(() => true) }),
      // One the person writes to, which does not answer the read: it is sent the list all the same.
      [OWN]: relay([], { reads: failingWhen(() => true) }),
      // Another they write to, which answers: one of theirs was heard from, so the read is one to build on (ruling R44).
      [ALSO_OWN]: relay([old]),
      [READS]: relay(),
    });

    const saved = savedBy(await change(w, ABSENT, "follow"));

    for (const url of [NOS, DIRECTORY, OWN, ALSO_OWN, READS]) expect(w.relays[url]!.writer.published).toEqual([saved]);
    expect(w.relays[BIG]!.writer.published).toEqual([]);
  });

  it("reads the list from the relays the person's relay list names, with the follow-list relays", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay(),
      [DIRECTORY]: relay([relayList([[OWN, "write"]])]),
      [BIG]: relay(),
      // Only the person's own relay holds their list.
      [OWN]: relay([old]),
    });

    const saved = savedBy(await change(w, ABSENT, "follow"));

    expect(saved.tags).toEqual([...old.tags, ["p", ABSENT]]);
  });

  it("uses the person's relay list that one relay sent, though another never answers: once that one's time is up (ruling R11)", async () => {
    const old = buildFollowList(SECRET);
    const w = world(
      { [NOS]: relay([old]), [DIRECTORY]: relay([old, relayList([[OWN, "write"]])]), [BIG]: relay([old]), [OWN]: relay() },
      // The review relay never answers for the relay list; the directory has sent it.
      relay([], { reads: silentWhen(asksForRelayList) }),
    );
    const ended = track(change(w, ABSENT, "follow"));

    // Each relay has the time every read of a follow list gives a relay, on a tap as on the page (ruling R45).
    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS - 1);
    // Still within the stalled relay's time: the follow list has not been asked for.
    expect(Object.values(w.relays).flatMap((each) => each.asked.filter(asksForList))).toEqual([]);
    expect(ended).toEqual({});

    await vi.advanceTimersByTimeAsync(1);
    const saved = savedBy(ended.outcome);
    // The relay the person writes to was learned of all the same: it is read, and sent the list.
    expect(w.relays[OWN]!.asked.filter(asksForList)).toHaveLength(2);
    for (const url of [NOS, DIRECTORY, BIG, OWN]) expect(w.relays[url]!.writer.published).toEqual([saved]);
    expect(FOLLOW_READ_MS).toBe(6_000);
  });

  it("is not loaded when no relay sends the person's relay list in time: the relays it names were never learned of, and what the app's relays hold is not built on (ruling R43)", async () => {
    const old = buildFollowList(SECRET);
    const w = world(
      {
        [NOS]: relay([old]),
        [DIRECTORY]: relay([old, relayList([[OWN, "write"]])], { reads: silentWhen(asksForRelayList) }),
        [BIG]: relay([old]),
        [OWN]: relay(),
      },
      relay([], { reads: silentWhen(asksForRelayList) }),
    );
    const by = signer();
    const ended = track(change(w, ABSENT, "follow", { by }));

    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS - 1);
    expect(ended).toEqual({});

    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome).toEqual({ kind: "not-loaded" });
    // Nothing was signed, and nothing sent to any relay.
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
    // The relay the person writes to was never learned of: nothing is read from it. Nor was any relay asked for the list.
    expect(w.relays[OWN]!.asked).toEqual([]);
    expect(w.asked().filter(asksForList)).toEqual([]);
  });

  it("never asks a review relay for a follow list, and never sends it one, though it holds one (ruling R12)", async () => {
    const old = buildFollowList(SECRET);
    // The review relay holds a list of the person's, newer than the others': it is not where lists are read.
    const elsewhere = buildFollowList(SECRET, FOLLOW_LIST_TIME + 100);
    const w = world({ [NOS]: relay([old]), [DIRECTORY]: relay([old]), [BIG]: relay([old]) }, relay([elsewhere]));

    const saved = savedBy(await change(w, ABSENT, "follow"));

    expect(saved.tags).toEqual([...old.tags, ["p", ABSENT]]);
    // It was asked for the person's relay list, and for nothing else.
    expect(w.reviews.asked.length).toBeGreaterThan(0);
    expect(w.reviews.asked.every(asksForRelayList)).toBe(true);
    expect(w.reviews.writer.published).toEqual([]);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([saved]);
  });
});

describe("a signer that signs something other than what was built (Review Focus 2)", () => {
  const cases: Array<[string, (asked: EventTemplate) => EventTemplate]> = [
    ["adds a tag after the list's own", (asked) => ({ ...asked, tags: [...asked.tags, ["client", "an-app"]] })],
    ["puts a tag before the list's own", (asked) => ({ ...asked, tags: [["client", "an-app"], ...asked.tags] })],
    ["puts two tags in each other's place", (asked) => ({ ...asked, tags: [asked.tags[1]!, asked.tags[0]!, ...asked.tags.slice(2)] })],
    ["leaves a tag out", (asked) => ({ ...asked, tags: asked.tags.slice(1) })],
    ["leaves the new entry out", (asked) => ({ ...asked, tags: asked.tags.slice(0, -1) })],
    ["changes one value of one tag", (asked) => ({ ...asked, tags: asked.tags.map((tag, i) => (i === 2 ? [...tag.slice(0, -1), "another-name"] : tag)) })],
    ["drops the last value of one tag", (asked) => ({ ...asked, tags: asked.tags.map((tag, i) => (i === 2 ? tag.slice(0, -1) : tag)) })],
    ["edits the content", (asked) => ({ ...asked, content: "" })],
    ["changes the time", (asked) => ({ ...asked, created_at: asked.created_at + 1 })],
    ["changes the kind", (asked) => ({ ...asked, kind: 30_000 })],
  ];

  it.each(cases)("is not saved, and nothing is sent, when the signer %s", async (_, changed) => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => finalizeEvent(changed(structuredClone(asked)), SECRET));

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("is not saved, and nothing is sent, when the signer signs as someone else", async () => {
    const w = everywhere([buildFollowList(SECRET)]);

    expect(await change(w, ABSENT, "follow", { by: signer(SOMEONE_ELSE) })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it.each<[string, (asked: EventTemplate) => void]>([
    ["adds a tag to it", (asked) => asked.tags.push(["client", "an-app"])],
    ["takes a tag out of it", (asked) => asked.tags.shift()],
    ["changes who one of its tags names", (asked) => (asked.tags[0]![1] = ALSO_ABSENT)],
    ["empties its content", (asked) => (asked.content = "")],
    ["moves its time", (asked) => (asked.created_at += 60)],
  ])("is not saved when the signer changes what it was handed, and signs that: it %s", async (_, alter) => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    // What it signs is what it was handed, changed: only a copy of its own kept apart from that tells.
    by.signEvent.mockImplementationOnce(async (asked) => {
      alter(asked);
      return finalizeEvent(asked, SECRET);
    });

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it.each([
    ["nothing", null],
    ["something that is no event", { kind: 3, tags: [], content: "" }],
  ])("is not saved when the signer gives back %s", async (_, given) => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    by.signEvent.mockResolvedValueOnce(given as unknown as NostrEvent);

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("sends the event's seven fields and nothing a signer put beside them", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => ({ ...finalizeEvent(structuredClone(asked), SECRET), relays: [OWN] }) as NostrEvent);

    const saved = savedBy(await change(w, ABSENT, "follow", { by }));

    expect(Object.keys(saved).sort()).toEqual(["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
    expect(w.relays[NOS]!.writer.published).toEqual([saved]);
    expect(Object.keys(w.relays[NOS]!.writer.published[0]!)).toHaveLength(7);
  });
});

describe("a signer whose answer is no valid event (ruling R41)", () => {
  /** What a signer returns in place of what it signed: `signed` is the list as built and truly signed, `other` another event the person's key truly signed. */
  type Forged = (signed: NostrEvent, other: NostrEvent) => NostrEvent;

  const cases: Array<[string, Forged]> = [
    ["the right fields with a signature that is not over them", (signed, other) => ({ ...asSent(signed), sig: other.sig })],
    ["the right fields with a signature of another key's", (signed) => ({ ...asSent(signed), sig: finalizeEvent(asTemplate(signed), SOMEONE_ELSE).sig })],
    ["the right fields with an id that is not their hash", (signed, other) => ({ ...asSent(signed), id: other.id })],
    ["the right fields with the id and the signature of another event", (signed, other) => ({ ...asSent(signed), id: other.id, sig: other.sig })],
    // nostr-tools marks an event it has signed or checked, and takes its own mark at its word: a
    // signer that hands the mark on with other fields is not believed for it.
    ["a wrong signature under nostr-tools' own mark of a checked event", (signed, other) => ({ ...signed, sig: other.sig })],
    ["a wrong id under that mark", (signed, other) => ({ ...signed, id: other.id })],
  ];

  /** What `signed` was signed from. */
  const asTemplate = ({ kind, created_at, tags, content }: NostrEvent): EventTemplate => ({ kind, created_at, tags, content });

  /** A signer that signs what it is asked to, truly, and returns `forged` of that in its place, once. */
  function forging(forged: Forged) {
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => {
      const signed = finalizeEvent(structuredClone(asked), SECRET);
      // Another event of the person's own, truly signed: its id and its signature are a pair, of other fields.
      const other = finalizeEvent({ ...structuredClone(asked), content: "another event" }, SECRET);
      return forged(signed, other);
    });
    return by;
  }

  it("tells a true signature from each of these: what is forged below is checked by nostr-tools as not valid, and the true one as valid", () => {
    const signed = finalizeEvent({ kind: 3, created_at: NOW, tags: [["p", ABSENT]], content: "" }, SECRET);
    const other = finalizeEvent({ kind: 3, created_at: NOW, tags: [["p", ABSENT]], content: "another event" }, SECRET);

    expect(verifyEvent(asSent(signed))).toBe(true);
    for (const [, forged] of cases) expect(verifyEvent(asSent(forged(signed, other)))).toBe(false);
  });

  it.each(cases)("is not saved, and nothing is sent to any relay, when the signer returns %s", async (_, forged) => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = forging(forged);

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-saved" });

    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(w.published()).toEqual([]);
    for (const each of Object.values(w.relays)) expect(each.writer.published).toEqual([]);
  });

  it.each(cases)("is not saved for an unfollow either, when the signer returns %s", async (_, forged) => {
    const w = everywhere([buildFollowList(SECRET)]);

    expect(await change(w, pubkeyAt(8), "unfollow", { by: forging(forged) })).toEqual({ kind: "not-saved" });
    expect(w.published()).toEqual([]);
  });

  it("is not saved for a new account's first list, nor for what Undo puts back", async () => {
    const [, forged] = cases[0]!;
    const fresh = everywhere([]);
    expect(await change(fresh, ABSENT, "follow", { by: forging(forged) })).toEqual({ kind: "not-saved" });
    expect(fresh.published()).toEqual([]);

    const w = everywhere([buildFollowList(SECRET)]);
    const unfollowed = await change(w, pubkeyAt(8), "unfollow");
    const sent = w.published().length;
    if (unfollowed.kind !== "saved" || unfollowed.removed === undefined) throw new Error("The unfollow did not save");
    const undo = { restore: unfollowed.removed, left: unfollowed.list.id };
    expect(await change(w, pubkeyAt(8), undo, { by: forging(forged), now: NOW + 5 })).toEqual({ kind: "not-saved" });
    expect(w.published()).toHaveLength(sent);
  });

  it("leaves the next change free to go: the list is as it was, and a true signature saves", async () => {
    const list = buildFollowList(SECRET);
    const w = everywhere([list]);
    expect(await change(w, ABSENT, "follow", { by: forging(cases[0]![1]) })).toEqual({ kind: "not-saved" });

    const saved = savedBy(await change(w, ABSENT, "follow"));

    expect(saved.tags).toEqual([...list.tags, ["p", ABSENT]]);
    expect(verifyEvent(asSent(saved))).toBe(true);
    // What is sent is the event's seven fields still: the check leaves no mark of its own on it.
    expect(Object.getOwnPropertySymbols(saved)).toEqual([]);
  });
});

describe("one change at a time (Review Focus 3)", () => {
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
  async function openTab(): Promise<typeof changeFollow> {
    vi.resetModules();
    const tab = await import("../src/follow/change");
    setUpRelays((await import("../src/config")).config);
    return tab.changeFollow;
  }

  /** Two follows started together, the first with a signer that takes a second, and how they ended. */
  async function twoAtOnce(w: World, firstTab = changeFollow, secondTab = changeFollow) {
    const first = change(w, ABSENT, "follow", { by: slowSigner(1_000) }, firstTab);
    const second = change(w, ALSO_ABSENT, "follow", {}, secondTab);
    const both = Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(1_000);
    return both;
  }

  /** The second change was built on the list the first saved, and each relay was sent them in that order. */
  function expectInTurn(w: World, old: NostrEvent, one: FollowOutcome, two: FollowOutcome) {
    const first = savedBy(one);
    const second = savedBy(two);
    expect(first.tags).toEqual([...old.tags, ["p", ABSENT]]);
    expect(second.tags).toEqual([...old.tags, ["p", ABSENT], ["p", ALSO_ABSENT]]);
    // Both at the same second by the clock: the second is made a second after the first, so it is the newer everywhere.
    expect(second.created_at).toBe(first.created_at + 1);
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([first, second]);
  }

  it("makes a second tap in the same tab wait for the first, and build on the list the first saved (no Web Locks)", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);

    const [one, two] = await twoAtOnce(w);

    expectInTurn(w, old, one, two);
  });

  it("holds the browser's follow lock, so a second tap in the same tab waits for the first", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);

    const [one, two] = await twoAtOnce(w);

    expectInTurn(w, old, one, two);
    expect(locks.requests).toEqual([FOLLOW_LOCK, FOLLOW_LOCK]);
    expect(FOLLOW_LOCK).toBe("regulars.follow");
  });

  it("holds it across tabs: a change in a second tab waits for the first tab's, and builds on what it saved", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);

    const firstTab = await openTab();
    const secondTab = await openTab();
    // Two copies of the code: neither knows of the other's changes but through the browser's lock.
    expect(secondTab).not.toBe(firstTab);

    const [one, two] = await twoAtOnce(w, firstTab, secondTab);

    expectInTurn(w, old, one, two);
    expect(locks.requests).toEqual([FOLLOW_LOCK, FOLLOW_LOCK]);
  });

  it("reads the list afresh for each change: nothing read before is built on", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);

    await change(w, ABSENT, "follow");
    // Another app of the person's saves a list of its own in between.
    const theirs = finalizeEvent({ kind: 3, created_at: NOW + 50, content: "theirs", tags: [["p", pubkeyAt(7)]] }, SECRET);
    for (const each of Object.values(w.relays)) each.held.push(theirs);
    const saved = savedBy(await change(w, ALSO_ABSENT, "follow", { now: NOW + 100 }));

    expect(saved.tags).toEqual([["p", pubkeyAt(7)], ["p", ALSO_ABSENT]]);
    expect(saved.content).toBe("theirs");
  });

  it("lets the next change go ahead when one ends without saving, or is stopped", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const refusing = signer();
    refusing.signEvent.mockRejectedValue(new Error("The person said no"));
    const stop = new AbortController();
    const never = signer();
    never.signEvent.mockImplementation(() => new Promise<never>(() => {}));

    const refused = change(w, ABSENT, "follow", { by: refusing });
    const stopped = track(change(w, ABSENT, "follow", { by: never, signal: stop.signal, signWithin: 3_600_000 }));
    const last = change(w, ALSO_ABSENT, "follow");
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error("signed out");
    stop.abort(reason);

    expect(await refused).toEqual({ kind: "not-approved" });
    expect(savedBy(await last).tags).toEqual([...old.tags, ["p", ALSO_ABSENT]]);
    expect(stopped.error).toBe(reason);
  });

  it("does not wait for ever on a lock another tab never lets go: after a while it goes ahead", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    // Another tab holds the lock and never lets go.
    void locks.request(FOLLOW_LOCK, {}, () => new Promise<never>(() => {}));
    const w = everywhere([buildFollowList(SECRET)]);
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS - 1);
    expect(Object.values(w.relays).flatMap((each) => each.asked)).toEqual([]);
    expect(ended).toEqual({});

    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome?.kind).toBe("saved");
  });

  it("waits for the lock longer than the longest change can take", () => {
    // The relay list, the list, the signs of use and the read-back, each a relay's time at most.
    const longest = 4 * FOLLOW_READ_MS + REQUEST_TIMEOUT_MS + 2 * PUBLISH_TIMEOUT_MS;
    expect(FOLLOW_LOCK_WAIT_MS).toBeGreaterThan(longest);
  });

  it("stops waiting for the lock when its signal aborts, and then reads and writes nothing", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    void locks.request(FOLLOW_LOCK, {}, () => new Promise<never>(() => {}));
    const w = everywhere([buildFollowList(SECRET)]);
    const stop = new AbortController();
    const by = signer();
    const ended = track(change(w, ABSENT, "follow", { by, signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error("signed out");
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.error).toBe(reason);
    // It has left the queue for the lock: nothing of it is still waiting.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);
    expect(Object.values(w.relays).flatMap((each) => each.asked)).toEqual([]);
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("reads nothing when the browser lends the lock to a change that was stopped while it waited", async () => {
    // A browser that takes no notice of the signal: the lock comes once the change has been stopped.
    let lend!: () => void;
    const lent = new Promise<void>((resolve) => {
      lend = resolve;
    });
    useLocks({ request: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => lent.then(callback) });
    const w = everywhere([buildFollowList(SECRET)]);
    const stop = new AbortController();
    const ended = track(change(w, ABSENT, "follow", { signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error("signed out");
    stop.abort(reason);
    lend();
    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);

    expect(ended.error).toBe(reason);
    expect(Object.values(w.relays).flatMap((each) => each.asked)).toEqual([]);
    expect(w.published()).toEqual([]);
  });

  it("does not start a change over, without the lock, when it fails while it holds the lock", async () => {
    useLocks(new FakeLocks());
    const w = everywhere([buildFollowList(SECRET)]);
    const broken = new Error("no clock");
    const deps: FollowDeps = {
      readers: w.readers,
      writers: w.writers,
      now: () => {
        throw broken;
      },
    };

    await expect(changeFollow({ pubkey: ME, signer: signer(), how: "browser" }, ABSENT, "follow", deps, life.signal)).rejects.toBe(broken);

    // Read once: the change was not run a second time.
    for (const each of Object.values(w.relays)) expect(each.asked.filter(asksForList)).toHaveLength(1);
    expect(w.published()).toEqual([]);
  });

  it("rejects a change stopped while it waits its turn in the tab at once, and never starts it", async () => {
    const locks = new FakeLocks();
    useLocks(locks);
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const stop = new AbortController();
    const waiting = signer();

    const first = change(w, ABSENT, "follow", { by: slowSigner(1_000) });
    const second = track(change(w, ALSO_ABSENT, "follow", { by: waiting, signal: stop.signal }));
    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error("signed out");
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    // At once: the first is still with its signer.
    expect(second.error).toBe(reason);
    expect(w.published()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(savedBy(await first).tags).toEqual([...old.tags, ["p", ABSENT]]);
    // The second never took the lock, read a relay or asked its signer: all of this is the first's.
    expect(locks.requests).toEqual([FOLLOW_LOCK]);
    expect(waiting.signEvent).not.toHaveBeenCalled();
    for (const each of Object.values(w.relays)) {
      expect(each.asked.filter(asksForList)).toHaveLength(2);
      expect(each.writer.published).toHaveLength(1);
    }
  });
});

describe("when the relays send no list (Review Focus 4)", () => {
  /** Nothing was asked of the signer, and nothing sent. */
  function expectNothingWritten(w: World, by: ReturnType<typeof signer>) {
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  }

  it("is not loaded when one relay has a profile by the account: its list is somewhere, and is not replaced", async () => {
    const w = world({ [NOS]: relay([shapedEvent({ kind: 0, pubkey: ME, content: "{}" })]), [DIRECTORY]: relay(), [BIG]: relay() });
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("is not loaded when one relay has a list by someone that names the account", async () => {
    const follower = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", ME]] }, SOMEONE_ELSE);
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay(), [BIG]: relay([follower]) });
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("makes a fresh list of the one person when three relays answer and none shows any sign of the account", async () => {
    // What the relays hold of other people is no sign of this one.
    const others = [
      shapedEvent({ kind: 0, pubkey: getPublicKey(SOMEONE_ELSE), content: "{}" }),
      finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: "", tags: [["p", ABSENT]] }, SOMEONE_ELSE),
    ];
    const w = everywhere(others);
    const by = signer();

    const outcome = await change(w, ABSENT, "follow", { by });

    const saved = savedBy(outcome);
    expect(outcome).toEqual({ kind: "saved", list: saved, confirmed: true });
    expect(by.signEvent).toHaveBeenCalledWith({ kind: 3, created_at: NOW, content: "", tags: [["p", ABSENT]] });
    expect(saved).toMatchObject({ kind: 3, pubkey: ME, created_at: NOW, content: "", tags: [["p", ABSENT]] });
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([saved]);
    // The review relay was asked for signs of the account, never for its list, and is sent nothing.
    expect(w.reviews.asked.filter(asksForProfile)).toHaveLength(1);
    expect(w.reviews.asked.filter(asksForList)).toEqual([]);
    expect(w.reviews.writer.published).toEqual([]);
    expect(NEW_LIST_QUORUM).toBe(3);
  });

  it("is not loaded when only a review relay has a profile by the account: it keeps no follow lists, and a profile there is a sign all the same", async () => {
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay(), [BIG]: relay() }, relay([shapedEvent({ kind: 0, pubkey: ME, content: "{}" })]));
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("does not count a review relay's nothing among the three: it stands behind no no (ruling R12)", async () => {
    // Two follow-list relays answer both questions; the third does not answer for a profile; the review relay answers both.
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay(), [BIG]: relay([], { reads: failingWhen(asksForProfile) }) });
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
    expect(w.reviews.asked.filter(asksForProfile)).toHaveLength(1);
    expect(w.reviews.asked.filter(asksForFollower)).toHaveLength(1);
  });

  describe("with six follow-list relays, as production has: more than half must answer (ruling R16)", () => {
    const SIX = [NOS, DIRECTORY, BIG, FOURTH, FIFTH, SIXTH];
    /** Six relays that hold nothing of the account, of which `out` are as `outAs` makes them. */
    function six(out: string[], outAs: () => Relay): World {
      config.followListRelays = [...SIX];
      return world(Object.fromEntries(SIX.map((url) => [url, out.includes(url) ? outAs() : relay()])));
    }

    it("is not loaded when three answer with no list and three do not answer: those three may be the ones that hold it", async () => {
      const w = six([FOURTH, FIFTH, SIXTH], down);
      const by = signer();

      expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
      expectNothingWritten(w, by);
    });

    it("is not loaded when only three answer the read of the list, though all six answer for the account", async () => {
      const w = six([FOURTH, FIFTH, SIXTH], () => relay([], { reads: failingWhen(asksForList) }));
      const by = signer();

      expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
      expectNothingWritten(w, by);
    });

    it("makes a fresh list when four answer, and sends it to those four", async () => {
      const w = six([FIFTH, SIXTH], down);

      const saved = savedBy(await change(w, ABSENT, "follow"));

      expect(saved.tags).toEqual([["p", ABSENT]]);
      for (const url of [NOS, DIRECTORY, BIG, FOURTH]) expect(w.relays[url]!.writer.published).toEqual([saved]);
      for (const url of [FIFTH, SIXTH]) expect(w.relays[url]!.writer.published).toEqual([]);
    });

    it.each([
      ["for its profile", asksForProfile],
      ["for who follows it", asksForFollower],
    ])("is not loaded when all six answer the read of the list, and only three answer %s", async (_, question) => {
      const w = six([FOURTH, FIFTH, SIXTH], () => relay([], { reads: failingWhen(question) }));
      const by = signer();

      expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
      expectNothingWritten(w, by);
    });

    it("makes a fresh list when four of the six answer both questions about the account", async () => {
      const w = six([FIFTH, SIXTH], () => relay([], { reads: failingWhen(asksForProfile) }));

      expect(savedBy(await change(w, ABSENT, "follow")).tags).toEqual([["p", ABSENT]]);
    });
  });

  it("makes a fresh list when three of four follow-list relays answer: more than half, and no fewer than three (ruling R16)", async () => {
    config.followListRelays = [NOS, DIRECTORY, BIG, FOURTH];
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay(), [BIG]: relay(), [FOURTH]: down() });

    expect(savedBy(await change(w, ABSENT, "follow")).tags).toEqual([["p", ABSENT]]);
  });

  it.each([
    ["that names a relay", [[OWN, "write"]]],
    ["that names none", []],
  ])("is not loaded when the person has a relay list %s: it is a sign the account has been used (ruling R16)", async (_, entries) => {
    // No follow list, no profile, nobody following: but for the relay list, a new account.
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay([relayList(entries)]), [BIG]: relay(), [OWN]: relay() });
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("reads no follow list and is not loaded when the app has no follow-list relays and the person no relay list, as in development (ruling R17)", async () => {
    config.followListRelays = [];
    // Relays that hold the person's list, were they asked.
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
    // Nothing was asked but the person's relay list, of the relays that keep those.
    for (const each of [...Object.values(w.relays), w.reviews]) expect(each.asked.every(asksForRelayList)).toBe(true);
  });

  it("is not loaded when only two relays answer the read of the list, though three answer for the account (ruling R7)", async () => {
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay(), [BIG]: relay([], { reads: failingWhen(asksForList) }) });
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it.each([
    ["for its profile", asksForProfile],
    ["for who follows it", asksForFollower],
  ])("is not loaded when three relays answer the read of the list, and only two answer %s (ruling R7)", async (_, question) => {
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay([], { reads: failingWhen(question) }), [BIG]: relay() });
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("is not loaded when no relay answers the read of the list: one fails, and the others never answer", async () => {
    // The directory answers that there is no relay list, and fails the read of the list itself.
    const w = world({
      [NOS]: relay([], { reads: silentWhen(asksForList) }),
      [DIRECTORY]: relay([], { reads: failingWhen(asksForList) }),
      [BIG]: relay([], { reads: silentWhen(asksForList) }),
    });
    const by = signer();
    const ended = track(change(w, ABSENT, "follow", { by }));

    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS - 1);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(ended.outcome).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("is not loaded for an unfollow either, when the account shows use: it is not said to be unchanged", async () => {
    const w = world({ [NOS]: relay([shapedEvent({ kind: 0, pubkey: ME, content: "{}" })]), [DIRECTORY]: relay(), [BIG]: relay() });
    const by = signer();

    expect(await change(w, ABSENT, "unfollow", { by })).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("is unchanged, with no list, for an unfollow by an account that has none", async () => {
    const w = everywhere();
    const by = signer();

    expect(await change(w, ABSENT, "unfollow", { by })).toEqual({ kind: "unchanged", list: null });
    expectNothingWritten(w, by);
  });

  it("needs only one relay to send the list to build on it: the others fail, or hold none", async () => {
    const old = buildFollowList(SECRET);
    // The directory answers that the person has no relay list, and fails the read of the list.
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay([], { reads: failingWhen(asksForList) }), [BIG]: relay([old]) });

    const saved = savedBy(await change(w, ABSENT, "follow"));

    expect(saved.tags).toEqual([...old.tags, ["p", ABSENT]]);
    // No relay was asked whether the account has been used: its list was found.
    expect(Object.values(w.relays).flatMap((each) => each.asked.filter((filter) => asksForProfile(filter) || asksForFollower(filter)))).toEqual([]);
  });
});

describe("a read of the person's own list that cannot be trusted (rulings R43, R44 and R45)", () => {
  const SIX = [NOS, DIRECTORY, BIG, FOURTH, FIFTH, SIXTH];
  /** The person's list as it was years ago, which one of the app's relays still holds; and their list now, on the relay they write to. */
  const OLD_AT = FOLLOW_LIST_TIME - 60 * 60 * 24 * 900;
  const yearsOld = () => finalizeEvent({ kind: 3, created_at: OLD_AT, content: "", tags: [["p", pubkeyAt(1)], ["p", pubkeyAt(2)]] }, SECRET);
  const theirs = () => relayList([[OWN, "write"]]);

  /** Nothing was asked of the signer, and no relay was sent anything. */
  function expectNothingWritten(w: World, by: ReturnType<typeof signer>) {
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
    for (const each of [...Object.values(w.relays), w.reviews]) expect(each.writer.published).toEqual([]);
  }

  /**
   * Scenario A. The person's newest list and their relay list are on the relay they write to and on
   * the directory, and nowhere else; one of the app's follow-list relays holds a copy years old. The
   * directory is out, and the review relay answers that it has no relay list of theirs.
   */
  function directoryOutWithAnOldCopy(): World {
    const now = buildFollowList(SECRET);
    return world({ [NOS]: relay([yearsOld()]), [DIRECTORY]: down(), [BIG]: relay(), [OWN]: relay([now, theirs()]) });
  }

  /**
   * Scenario B. The same person with no old copy anywhere, and no sign of the account on the relays
   * that answer: five of the app's six follow-list relays, which is enough of them for a new account.
   */
  function directoryOutWithNoCopy(): World {
    config.followListRelays = [...SIX];
    const answering = Object.fromEntries(SIX.filter((url) => url !== DIRECTORY).map((url) => [url, relay()]));
    return world({ ...answering, [DIRECTORY]: down(), [OWN]: relay([buildFollowList(SECRET), theirs()]) });
  }

  /**
   * Scenario C. The relay list is read, and names the relay the person writes to, which holds their
   * newest list and is as `own` makes it: out, or too slow. One of the app's relays holds the old copy.
   */
  function writeRelayNotAnswering(own: () => Relay): World {
    return world({ [NOS]: relay([yearsOld()]), [DIRECTORY]: relay([theirs()]), [BIG]: relay(), [OWN]: own() });
  }
  const slow = () => relay([buildFollowList(SECRET)], { reads: silentWhen(asksForList) });

  it.each<[string, Action]>([
    ["a follow", "follow"],
    ["an unfollow of someone the old copy names", "unfollow"],
  ])("is not loaded for %s when the relay list could not be read: the old copy one of the app's relays holds is not built on (scenario A)", async (_, action) => {
    const w = directoryOutWithAnOldCopy();
    const by = signer();
    const who = action === "follow" ? ABSENT : pubkeyAt(1);

    expect(await change(w, who, action, { by })).toEqual({ kind: "not-loaded" });

    expectNothingWritten(w, by);
    // Nor was any relay asked for the list: it is not known where it is.
    expect(w.asked().filter(asksForList)).toEqual([]);
  });

  it("starts no list for an account that looks new when the relay list could not be read: enough relays answer with nothing, and none of them is where the list is (scenario B)", async () => {
    const w = directoryOutWithNoCopy();
    const by = signer();

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });

    expectNothingWritten(w, by);
    // The same relays, once the directory answers that there is no relay list, do take the account for new.
    w.relays[DIRECTORY]!.reader = relay().reader;
    w.relays[DIRECTORY]!.writer = relay().writer;
    expect((await change(w, ABSENT, "follow")).kind).toBe("saved");
  });

  it.each([
    ["is out", down],
    ["does not answer in its time", slow],
  ])("is not loaded when the relay list is read and the relay it writes to %s: the old copy is not built on (scenario C)", async (_, own) => {
    const w = writeRelayNotAnswering(own);
    const by = signer();
    const ended = track(change(w, ABSENT, "follow", { by }));

    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

    expect(ended.outcome).toEqual({ kind: "not-loaded" });
    expectNothingWritten(w, by);
  });

  it("is not loaded for what Undo puts back either, when the read cannot be trusted", async () => {
    const w = world({ [NOS]: relay([buildFollowList(SECRET)]), [DIRECTORY]: relay([buildFollowList(SECRET)]), [BIG]: relay([buildFollowList(SECRET)]) });
    const unfollowed = await change(w, pubkeyAt(10), "unfollow");
    if (unfollowed.kind !== "saved" || unfollowed.removed === undefined) throw new Error("The unfollow did not save");
    const sent = w.published().length;
    w.relays[DIRECTORY]!.down = true;
    const by = signer();

    expect(await change(w, pubkeyAt(10), { restore: unfollowed.removed, left: unfollowed.list.id }, { by, now: NOW + 5 })).toEqual({ kind: "not-loaded" });

    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toHaveLength(sent);
  });

  it("does not take a list it could not trust for the newest this tab has seen: a later change is not held to it", async () => {
    // The relay the person writes to is out, and the app's relays hold a list.
    const stale = buildFollowList(SECRET);
    const w = world({ [NOS]: relay([stale]), [DIRECTORY]: relay([stale, theirs()]), [BIG]: relay([stale]), [OWN]: down() });
    expect(await change(w, ABSENT, "follow")).toEqual({ kind: "not-loaded" });

    // Their relay answers now, and every relay holds an older list than the one that was not trusted.
    // Were that one remembered, this read would be older than it, and stop.
    const older = buildFollowList(SECRET, FOLLOW_LIST_TIME - 100);
    for (const url of [NOS, DIRECTORY, BIG]) w.relays[url]!.held.splice(0, Number.POSITIVE_INFINITY, older, theirs());
    w.relays[OWN]!.reader = relay([older]).reader;

    const saved = savedBy(await change(w, ABSENT, "follow"));

    expect(saved.tags).toEqual([...older.tags, ["p", ABSENT]]);
  });

  describe("and the ways through that are as they were", () => {
    it("builds on the list the app's relays hold when the directory answers that there is no relay list", async () => {
      const old = buildFollowList(SECRET);
      const w = world({ [NOS]: relay([old]), [DIRECTORY]: relay(), [BIG]: relay() });

      const saved = savedBy(await change(w, ABSENT, "follow"));

      expect(saved.tags).toEqual([...old.tags, ["p", ABSENT]]);
    });

    it("builds on the newest list when the relay list is found and one relay it writes to answers, though another is out", async () => {
      const now = buildFollowList(SECRET);
      const ANOTHER = "wss://another.example.test";
      const w = world({
        [NOS]: relay([yearsOld()]),
        [DIRECTORY]: relay([relayList([[ANOTHER, "write"], [OWN, "write"]])]),
        [BIG]: relay(),
        [ANOTHER]: down(),
        [OWN]: relay([now]),
      });

      const saved = savedBy(await change(w, ABSENT, "follow"));

      expect(saved.tags).toEqual([...now.tags, ["p", ABSENT]]);
      // It goes to the relay they write to that did not answer, too, as before.
      expect(w.relays[ANOTHER]!.writer.signals).toHaveLength(2);
    });

    it("builds on what the relay it writes to and the app's relays hold when that relay answers with no list", async () => {
      const old = buildFollowList(SECRET);
      const w = world({ [NOS]: relay([old]), [DIRECTORY]: relay([theirs()]), [BIG]: relay(), [OWN]: relay() });

      const saved = savedBy(await change(w, ABSENT, "follow"));

      expect(saved.tags).toEqual([...old.tags, ["p", ABSENT]]);
      expect(w.relays[OWN]!.writer.published).toEqual([saved]);
    });

    it.each([
      ["only addresses the app cannot use", [["ws://plain.example.test", "write"], ["wss://localhost", "write"], ["wss://192.168.1.4"]]],
      ["only relays to read from", [[READS, "read"]]],
    ])("stands on the app's relays when the relay list names %s to write to", async (_, entries) => {
      strangers.length = 0;
      const old = buildFollowList(SECRET);
      const w = world({ [NOS]: relay([old]), [DIRECTORY]: relay([old, relayList(entries)]), [BIG]: relay([old]), [READS]: relay() });

      const saved = savedBy(await change(w, ABSENT, "follow"));

      expect(saved.tags).toEqual([...old.tags, ["p", ABSENT]]);
      // No address the app cannot use was so much as asked for a reader or a writer.
      expect(strangers).toEqual([]);
    });

    it("makes a first list for a brand-new account when the directory answers that there is no relay list and enough relays answer with nothing", async () => {
      config.followListRelays = [...SIX];
      const w = world(Object.fromEntries(SIX.map((url) => [url, url === SIXTH || url === FIFTH ? down() : relay()])));

      const saved = savedBy(await change(w, ABSENT, "follow"));

      expect(saved.tags).toEqual([["p", ABSENT]]);
    });

    it("finds the relay list on a review relay though the directory is out, and then the relay it writes to decides", async () => {
      const now = buildFollowList(SECRET);
      const answers = world({ [NOS]: relay([yearsOld()]), [DIRECTORY]: down(), [BIG]: relay(), [OWN]: relay([now]) }, relay([theirs()]));
      expect(savedBy(await change(answers, ABSENT, "follow")).tags).toEqual([...now.tags, ["p", ABSENT]]);

      forgetFollowFloor();
      const isOut = world({ [NOS]: relay([yearsOld()]), [DIRECTORY]: down(), [BIG]: relay(), [OWN]: down() }, relay([theirs()]));
      const by = signer();
      expect(await change(isOut, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
      expectNothingWritten(isOut, by);
    });
  });
});

describe("a list older than one this tab has seen (ruling R9)", () => {
  /**
   * Three relays that hold the list, and a first follow saved to NOS and DIRECTORY: BIG refuses
   * that one, and so keeps the older list. `down` takes a relay's reads of the list away, as when it
   * cannot send one; it still answers for the person's relay list, so the read is one to trust, and
   * what stops a change here is the list this tab has seen.
   */
  async function afterAFollow() {
    const old = buildFollowList(SECRET);
    const down = new Set<string>();
    const unlessDown = (url: string) => failingWhen((filter) => down.has(url) && asksForList(filter));
    const w = world({
      [NOS]: relay([old], { reads: unlessDown(NOS) }),
      [DIRECTORY]: relay([old], { reads: unlessDown(DIRECTORY) }),
      [BIG]: relay([old], { writes: { answers: [{ refuse: "blocked: not this time" }] } }),
    });
    const first = savedBy(await change(w, ABSENT, "follow"));
    expect(w.relays[NOS]!.held).toContainEqual(first);
    expect(w.relays[DIRECTORY]!.held).toContainEqual(first);
    expect(w.relays[BIG]!.held).toEqual([old]);
    return { old, w, down, first };
  }

  it("is not loaded, and nothing is signed or sent, when only the relay with the older list answers", async () => {
    const { w, down } = await afterAFollow();
    down.add(NOS).add(DIRECTORY);
    const by = signer();
    const sent = w.published().length;

    expect(await change(w, ALSO_ABSENT, "follow", { by, now: NOW + 10 })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toHaveLength(sent);
  });

  it("goes on from the list it saved when a relay that took it answers", async () => {
    const { w, down, first } = await afterAFollow();
    down.add(DIRECTORY);

    const second = savedBy(await change(w, ALSO_ABSENT, "follow", { now: NOW + 10 }));

    expect(second.tags).toEqual([...first.tags, ["p", ALSO_ABSENT]]);
  });

  it("takes the older list again once what it had seen is forgotten, as at sign-out", async () => {
    const { old, w, down } = await afterAFollow();
    down.add(NOS).add(DIRECTORY);

    forgetFollowFloor();
    const second = savedBy(await change(w, ALSO_ABSENT, "follow", { now: NOW + 10 }));

    expect(second.tags).toEqual([...old.tags, ["p", ALSO_ABSENT]]);
  });

  it("holds an unfollow to it too", async () => {
    const { w, down } = await afterAFollow();
    down.add(NOS).add(DIRECTORY);
    const by = signer();

    // On the older list there is nothing to take out: it is not said to be unchanged, as that list is not the newest.
    expect(await change(w, ABSENT, "unfollow", { by, now: NOW + 10 })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
  });

  it("is not held to a list no relay took: the next change builds on the list the relays hold", async () => {
    const old = buildFollowList(SECRET);
    // Each relay refuses the first list it is sent, and takes the next.
    const refusingOnce = () => relay([old], { writes: { answers: [{ refuse: "blocked: not this time" }] } });
    const w = world({ [NOS]: refusingOnce(), [DIRECTORY]: refusingOnce(), [BIG]: refusingOnce() });

    expect(await change(w, ABSENT, "follow")).toEqual({ kind: "not-saved" });
    const again = savedBy(await change(w, ABSENT, "follow", { now: NOW + 10 }));

    expect(again.tags).toEqual([...old.tags, ["p", ABSENT]]);
  });

  it("does not remember a list a relay took once the change was stopped: its session is over, and the next starts afresh", async () => {
    const old = buildFollowList(SECRET);
    let nosDown = false;
    // The other two never answer the first list they are sent, and take the next.
    const slowOnce = () => relay([old], { writes: { answers: [{ silent: true }] } });
    const w = world({ [NOS]: relay([old], { reads: failingWhen(() => nosDown) }), [DIRECTORY]: slowOnce(), [BIG]: slowOnce() });
    const stop = new AbortController();
    const stopped = track(change(w, ABSENT, "follow", { signal: stop.signal }));
    // NOS has taken it, and the others have not answered, when the person signs out: the change is
    // stopped, and what the tab had seen is forgotten, there and then.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.relays[NOS]!.held).toHaveLength(2);
    const reason = new Error("stopped");
    stop.abort(reason);
    forgetFollowFloor();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped.error).toBe(reason);
    nosDown = true;

    // The relays that answer now hold only the older list. Nothing the stopped change did is held
    // against it: the next change is built on that list.
    const next = savedBy(await change(w, ALSO_ABSENT, "follow", { now: NOW + 10 }));
    expect(next.tags).toEqual([...old.tags, ["p", ALSO_ABSENT]]);
  });

  it("remembers the newest list it read, though it saved nothing", async () => {
    const older = buildFollowList(SECRET, FOLLOW_LIST_TIME - 100);
    const newer = buildFollowList(SECRET);
    let nosDown = false;
    const w = world({ [NOS]: relay([newer], { reads: failingWhen(() => nosDown) }), [DIRECTORY]: relay([older]), [BIG]: relay([older]) });
    const by = signer();

    expect((await change(w, pubkeyAt(0), "follow", { by })).kind).toBe("unchanged");
    nosDown = true;

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is not loaded when the relays send no list at all after one was saved: no fresh list replaces it", async () => {
    // A new account, and relays that take a list and do not send it back yet.
    const lagging = () => relay([], { lags: true });
    const w = world({ [NOS]: lagging(), [DIRECTORY]: lagging(), [BIG]: lagging() });
    const first = savedBy(await change(w, ABSENT, "follow"));
    expect(first.tags).toEqual([["p", ABSENT]]);
    const by = signer();

    // The relays still show no list and no sign of the account: but for the list it saved, a fresh one of one entry would be made.
    expect(await change(w, ALSO_ABSENT, "follow", { by, now: NOW + 10 })).toEqual({ kind: "not-loaded" });
    expect(by.signEvent).not.toHaveBeenCalled();
    for (const each of Object.values(w.relays)) expect(each.writer.published).toEqual([first]);
  });

  it("goes on from a newer list than the one it saved: another app's, read afresh", async () => {
    const { w, first } = await afterAFollow();
    const theirs = finalizeEvent({ kind: 3, created_at: first.created_at + 5, content: "", tags: [["p", pubkeyAt(7)]] }, SECRET);
    w.relays[BIG]!.held.push(theirs);

    const second = savedBy(await change(w, ALSO_ABSENT, "follow", { now: NOW + 10 }));

    expect(second.tags).toEqual([["p", pubkeyAt(7)], ["p", ALSO_ABSENT]]);
  });

  describe("raised by a reader, with the list it shows (ruling R18)", () => {
    const older = () => buildFollowList(SECRET, FOLLOW_LIST_TIME - 100);
    const shown = () => buildFollowList(SECRET);
    const newer = () => buildFollowList(SECRET, FOLLOW_LIST_TIME + 100);

    it("holds a change to the list on screen: one built on an older list the relays send is not loaded", async () => {
      raiseFollowFloor(ME, shown());
      const w = everywhere([older()]);
      const by = signer();

      expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-loaded" });
      expect(by.signEvent).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
    });

    it("lets a change go on from the list on screen, or a newer one", async () => {
      raiseFollowFloor(ME, shown());

      expect(savedBy(await change(everywhere([shown()]), ABSENT, "follow")).tags).toEqual([...shown().tags, ["p", ABSENT]]);
      forgetFollowFloor();
      raiseFollowFloor(ME, shown());
      expect(savedBy(await change(everywhere([newer()]), ABSENT, "follow")).tags).toEqual([...newer().tags, ["p", ABSENT]]);
    });

    it("never lowers: an older list shown after a newer one changes nothing", async () => {
      raiseFollowFloor(ME, newer());
      raiseFollowFloor(ME, older());
      raiseFollowFloor(ME, shown());

      expect(await change(everywhere([shown()]), ABSENT, "follow")).toEqual({ kind: "not-loaded" });
    });

    it("rises: a newer list shown after an older one is the one a change is held to", async () => {
      raiseFollowFloor(ME, older());
      raiseFollowFloor(ME, shown());

      expect(await change(everywhere([older()]), ABSENT, "follow")).toEqual({ kind: "not-loaded" });
    });

    it("takes the lower id as the newer of two lists made in the same second, as relays do", async () => {
      const [low, high] = [finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, tags: [["p", pubkeyAt(1)]], content: "" }, SECRET), finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, tags: [["p", pubkeyAt(2)]], content: "" }, SECRET)].sort((a, b) => (a.id < b.id ? -1 : 1));
      raiseFollowFloor(ME, low!);
      raiseFollowFloor(ME, high!);

      expect(await change(everywhere([high!]), ABSENT, "follow")).toEqual({ kind: "not-loaded" });
    });

    it("is forgotten with the rest", async () => {
      raiseFollowFloor(ME, shown());
      forgetFollowFloor();

      expect((await change(everywhere([older()]), ABSENT, "follow")).kind).toBe("saved");
    });

    it("takes no notice of a list that is not this person's follow list", async () => {
      // Another person's list, and an event of the person's that is no follow list: neither is a floor for them.
      raiseFollowFloor(ME, buildFollowList(SOMEONE_ELSE, FOLLOW_LIST_TIME + 100));
      raiseFollowFloor(ME, finalizeEvent({ kind: 10002, created_at: FOLLOW_LIST_TIME + 100, tags: [], content: "" }, SECRET));

      expect((await change(everywhere([shown()]), ABSENT, "follow")).kind).toBe("saved");
    });
  });

  it("is each person's own: what was seen of one account's list does not hold back another's", async () => {
    const { w } = await afterAFollow();
    // Someone else signs in, in the same tab, whose list is older than the first person's.
    const theirs = buildFollowList(SOMEONE_ELSE, FOLLOW_LIST_TIME - 1_000);
    for (const each of Object.values(w.relays)) each.held.push(theirs);
    const account: Account = { pubkey: getPublicKey(SOMEONE_ELSE), signer: signer(SOMEONE_ELSE), how: "browser" };
    const deps: FollowDeps = { readers: w.readers, writers: w.writers, now: () => NOW };

    const saved = savedBy(await changeFollow(account, ABSENT, "follow", deps, life.signal));

    expect(saved.tags).toEqual([...theirs.tags, ["p", ABSENT]]);
  });
});

describe("when nothing would change", () => {
  it("is unchanged, signing and sending nothing, for a follow of someone the list names already", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const by = signer();

    expect(await change(w, pubkeyAt(0), "follow", { by })).toEqual({ kind: "unchanged", list: asSent(old) });
    expect(await change(w, UPPER_CASE_KEY, "follow", { by })).toEqual({ kind: "unchanged", list: asSent(old) });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is unchanged, signing and sending nothing, for an unfollow of someone the list does not name", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const by = signer();

    expect(await change(w, ABSENT, "unfollow", { by })).toEqual({ kind: "unchanged", list: asSent(old) });
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });
});

describe("a person who is not one (ruling R5)", () => {
  it.each(["", "not-a-key", "z".repeat(64), pubkeyAt(1).slice(1), `${ABSENT}0`, "npub1example"])(
    "rejects %j with a TypeError, before anything is read, locked, signed or sent",
    async (who) => {
      const locks = new FakeLocks();
      useLocks(locks);
      const w = everywhere([buildFollowList(SECRET)]);
      const by = signer();

      await expect(change(w, who, "follow", { by })).rejects.toBeInstanceOf(TypeError);
      await expect(change(w, who, "unfollow", { by })).rejects.toBeInstanceOf(TypeError);
      expect(locks.requests).toEqual([]);
      expect(Object.values(w.relays).flatMap((each) => each.asked)).toEqual([]);
      expect(by.signEvent).not.toHaveBeenCalled();
      expect(w.published()).toEqual([]);
    },
  );

  it("rejects a change that is neither a follow nor an unfollow, rather than take it for one", async () => {
    const w = everywhere([buildFollowList(SECRET)]);

    await expect(change(w, pubkeyAt(0), "Follow" as "follow")).rejects.toBeInstanceOf(TypeError);
    expect(Object.values(w.relays).flatMap((each) => each.asked)).toEqual([]);
    expect(w.published()).toEqual([]);
  });
});

describe("the signer", () => {
  it("is not approved, and nothing is sent, when the signer says no", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    by.signEvent.mockRejectedValueOnce(new Error("The person said no"));

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-approved" });
    expect(w.published()).toEqual([]);
  });

  it("is not approved when the signer throws rather than answers", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(() => {
      throw new Error("No add-on");
    });

    expect(await change(w, ABSENT, "follow", { by })).toEqual({ kind: "not-approved" });
    expect(w.published()).toEqual([]);
  });

  it("gives an add-on 60 seconds, then is not approved, and nothing is sent", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const ended = track(change(w, ABSENT, "follow", { by, how: "browser" }));

    await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS - 1);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome).toEqual({ kind: "not-approved" });
    expect(w.published()).toEqual([]);
    expect(SIGN_TIMEOUT_MS).toBe(60_000);
  });

  it("gives the signer the time it is told to, whoever it is", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    by.signEvent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const ended = track(change(w, ABSENT, "follow", { by, how: "phone", signWithin: 5_000 }));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome).toEqual({ kind: "not-approved" });
  });

  it("gives a phone app no time limit of its own: the app's own holds", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent(structuredClone(asked), SECRET));
        }),
    );
    const ended = track(change(w, ABSENT, "follow", { by, how: "phone" }));

    await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS * 3);
    expect(ended).toEqual({});
    sign();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.outcome?.kind).toBe("saved");
  });
});

describe("saving", () => {
  it("is not saved when no relay takes it, and a relay that refuses it for good is not sent it again", async () => {
    const old = buildFollowList(SECRET);
    const refusing = () => relay([old], { writes: { refuse: "blocked: not on the list" } });
    const w = world({ [NOS]: refusing(), [DIRECTORY]: refusing(), [BIG]: refusing() });

    expect(await change(w, ABSENT, "follow")).toEqual({ kind: "not-saved" });
    for (const each of Object.values(w.relays)) expect(each.writer.published).toHaveLength(1);
  });

  it("is saved when one relay takes it and the others refuse, and is read back from the one that took it alone", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay([old], { writes: { refuse: "blocked: not on the list" } }),
      [DIRECTORY]: relay([old]),
      [BIG]: relay([old], { writes: { refuse: "invalid: too big" } }),
    });

    const outcome = await change(w, ABSENT, "follow");

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: true });
    expect(w.relays[DIRECTORY]!.asked.filter(asksForList)).toHaveLength(2);
    expect(w.relays[NOS]!.asked.filter(asksForList)).toHaveLength(1);
    expect(w.relays[BIG]!.asked.filter(asksForList)).toHaveLength(1);
  });

  it.each([
    ["loses its connection before it answers", { closes: true }],
    ["refuses it for now", { refuse: "rate-limited: slow down" }],
    ["refuses it for a fault of its own", { refuse: "error: could not save" }],
  ])("sends it once more to a relay that %s, and it is saved when that try is taken", async (_, firstAnswer) => {
    const old = buildFollowList(SECRET);
    const flaky = () => relay([old], { writes: { answers: [firstAnswer] } });
    const w = world({ [NOS]: flaky(), [DIRECTORY]: flaky(), [BIG]: flaky() });

    const outcome = await change(w, ABSENT, "follow");

    const saved = savedBy(outcome);
    expect(outcome).toEqual({ kind: "saved", list: saved, confirmed: true });
    for (const each of Object.values(w.relays)) expect(each.writer.published).toEqual([saved, saved]);
  });

  it("sends it once more and no more: a relay that fails twice is left", async () => {
    const old = buildFollowList(SECRET);
    const failing = () => relay([old], { writes: { answers: [{ closes: true }, { refuse: "error: could not save" }] } });
    const w = world({ [NOS]: failing(), [DIRECTORY]: failing(), [BIG]: failing() });

    expect(await change(w, ABSENT, "follow")).toEqual({ kind: "not-saved" });
    for (const each of Object.values(w.relays)) expect(each.writer.published).toHaveLength(2);
  });

  it("is saved 3 seconds after the first relay takes it, without waiting on a silent one, whose send goes on to the end of its time (ruling R10)", async () => {
    const old = buildFollowList(SECRET);
    const w = world({ [NOS]: relay([old], { writes: { silent: true } }), [DIRECTORY]: relay([old]), [BIG]: relay([old]) });
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(FOLLOW_SETTLE_MS - 1);
    expect(ended).toEqual({});

    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome).toEqual({ kind: "saved", list: savedBy(ended.outcome), confirmed: true });
    // Read back from the two that had taken it by then, and not from the silent one.
    expect(w.relays[DIRECTORY]!.asked.filter(asksForList)).toHaveLength(2);
    expect(w.relays[BIG]!.asked.filter(asksForList)).toHaveLength(2);
    expect(w.relays[NOS]!.asked.filter(asksForList)).toHaveLength(1);
    // The silent one's send is not stopped: it has the rest of its 15 seconds.
    expect(w.relays[NOS]!.writer.signals[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS - FOLLOW_SETTLE_MS - 1);
    expect(w.relays[NOS]!.writer.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Its time is up: given up on, and not sent again. Nothing of the change is left running.
    expect(w.relays[NOS]!.writer.signals[0]?.aborted).toBe(true);
    expect(w.relays[NOS]!.writer.published).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(FOLLOW_SETTLE_MS).toBe(3_000);
    expect(PUBLISH_TIMEOUT_MS).toBe(15_000);
  });

  it("does not wait 3 seconds when every relay takes it at once (ruling R10)", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(0);

    expect(ended.outcome).toEqual({ kind: "saved", list: savedBy(ended.outcome), confirmed: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes on as soon as the last relay has answered, within the 3 seconds, and reads back from it too", async () => {
    const old = buildFollowList(SECRET);
    const w = world({ [NOS]: relay([old], { writes: { delayMs: 2_000 } }), [DIRECTORY]: relay([old]), [BIG]: relay([old]) });
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(ended.outcome).toEqual({ kind: "saved", list: savedBy(ended.outcome), confirmed: true });
    expect(w.relays[NOS]!.asked.filter(asksForList)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the 3 seconds once, from the first relay that takes it: one that takes it later does not start them again", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay([old], { writes: { silent: true } }),
      [DIRECTORY]: relay([old]),
      [BIG]: relay([old], { writes: { delayMs: 2_000 } }),
    });
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(FOLLOW_SETTLE_MS - 1);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome).toEqual({ kind: "saved", list: savedBy(ended.outcome), confirmed: true });
    // Both that had taken it by then are read back.
    expect(w.relays[DIRECTORY]!.asked.filter(asksForList)).toHaveLength(2);
    expect(w.relays[BIG]!.asked.filter(asksForList)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the 3 seconds from the first relay that takes it, however late that one is", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay([old], { writes: { silent: true } }),
      [DIRECTORY]: relay([old], { writes: { delayMs: 10_000 } }),
      [BIG]: relay([old], { writes: { refuse: "blocked: not on the list" } }),
    });
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(10_000 + FOLLOW_SETTLE_MS - 1);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect(ended.outcome).toEqual({ kind: "saved", list: savedBy(ended.outcome), confirmed: true });

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a relay that takes it after the outcome keep it, and one that failed for now have its second try", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      // Slow: it takes the list 5 seconds on.
      [NOS]: relay([old], { writes: { delayMs: 5_000 } }),
      [DIRECTORY]: relay([old]),
      // Loses its connection 4 seconds on, and takes the list when it is sent again.
      [BIG]: relay([old], { writes: { answers: [{ closes: true, delayMs: 4_000 }] } }),
    });
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(FOLLOW_SETTLE_MS);
    const saved = savedBy(ended.outcome);
    expect(w.relays[NOS]!.held).not.toContainEqual(saved);
    expect(w.relays[BIG]!.held).not.toContainEqual(saved);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(w.relays[NOS]!.held).toContainEqual(saved);
    expect(w.relays[BIG]!.writer.published).toEqual([saved, saved]);
    expect(w.relays[BIG]!.held).toContainEqual(saved);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("builds a second change on the list the first saved, while the first is still being sent to a slow relay", async () => {
    const old = buildFollowList(SECRET);
    // NOS does not answer the first list it is sent, and takes the next at once.
    const w = world({ [NOS]: relay([old], { writes: { answers: [{ silent: true }] } }), [DIRECTORY]: relay([old]), [BIG]: relay([old]) });
    const first = track(change(w, ABSENT, "follow"));
    const second = track(change(w, ALSO_ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(FOLLOW_SETTLE_MS - 1);
    expect(first).toEqual({});
    expect(second).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    const one = savedBy(first.outcome);
    const two = savedBy(second.outcome);
    // The second ran while NOS still had the first under way: it was not stopped, and has not answered.
    expect(w.relays[NOS]!.writer.signals[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    // It was built on the first's list, read from the relays that had taken it, and the final list has both.
    expect(two.tags).toEqual([...old.tags, ["p", ABSENT], ["p", ALSO_ABSENT]]);
    expect(two.created_at).toBe(one.created_at + 1);
    expect(second.outcome).toEqual({ kind: "saved", list: two, confirmed: true });
    for (const url of [NOS, DIRECTORY, BIG]) expect(w.relays[url]!.writer.published).toEqual([one, two]);
    // NOS holds the second, the newer, and never took the first.
    expect(w.relays[NOS]!.held).toContainEqual(two);
    expect(w.relays[NOS]!.held).not.toContainEqual(one);

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is not saved only once every relay has answered or run out of time, when none takes it: there is no 3 seconds to count", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay([old], { writes: { silent: true } }),
      [DIRECTORY]: relay([old], { writes: { refuse: "blocked: not on the list" } }),
      [BIG]: relay([old], { writes: { refuse: "invalid: too big" } }),
    });
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS - 1);
    expect(ended).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(ended.outcome).toEqual({ kind: "not-saved" });
    expect(w.relays[NOS]!.writer.published).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is not saved when a relay's writer cannot be made, as when it refuses", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    const writers = () => {
      throw new Error("no writer for this one");
    };

    expect(await change({ ...w, writers }, ABSENT, "follow")).toEqual({ kind: "not-saved" });
  });

  it("counts a relay whose writer fails with something that cannot be read as not having taken it, and does not wait on it for ever", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    // What it throws has no text and cannot be made into any: reading why it failed fails too.
    const writers = (): RelayWriter => ({ publish: () => Promise.reject(Object.create(null)) });

    expect(await change({ ...w, writers }, ABSENT, "follow")).toEqual({ kind: "not-saved" });
  });
});

describe("reading it back", () => {
  it("is saved but not confirmed when the read-back finds a newer list, saved by another app meanwhile", async () => {
    const old = buildFollowList(SECRET);
    const w = everywhere([old]);
    // Another app of the person's saves a list of its own as this one's arrives.
    const theirs = finalizeEvent({ kind: 3, created_at: NOW + 5, content: "", tags: [["p", pubkeyAt(7)]] }, SECRET);
    const nos = w.relays[NOS]!;
    const taking = nos.writer.publish.bind(nos.writer);
    nos.writer.publish = async (event, signal) => {
      await taking(event, signal);
      nos.held.push(theirs);
    };

    const outcome = await change(w, ABSENT, "follow");

    const saved = savedBy(outcome);
    expect(outcome).toEqual({ kind: "saved", list: saved, confirmed: false });
    // The list it gives is the one it saved, not the other app's.
    expect(saved.tags).toEqual([...old.tags, ["p", ABSENT]]);
  });

  it("is saved but not confirmed when no relay that took it sends it back yet", async () => {
    const old = buildFollowList(SECRET);
    const lagging = () => relay([old], { lags: true });
    const w = world({ [NOS]: lagging(), [DIRECTORY]: lagging(), [BIG]: lagging() });

    const outcome = await change(w, ABSENT, "follow");

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: false });
  });

  it("is confirmed when one relay that took it sends it back as the newest, though another lags", async () => {
    const old = buildFollowList(SECRET);
    const w = world({ [NOS]: relay([old], { lags: true }), [DIRECTORY]: relay([old]), [BIG]: relay([old], { lags: true }) });

    const outcome = await change(w, ABSENT, "follow");

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: true });
  });

  it.each([
    ["replaced: have newer event"],
    ["replaced: this list has been superseded"],
    ["invalid: a newer version of this list is stored"],
    ["Replaced: by a later one"],
    ["error: Newer event exists"],
  ])(
    "is saved but not confirmed when a relay refuses it with %j, though those that took it send it back as the newest (ruling R13)",
    async (refusal) => {
      const old = buildFollowList(SECRET);
      const w = world({ [NOS]: relay([old], { writes: { refuse: refusal } }), [DIRECTORY]: relay([old]), [BIG]: relay([old]) });

      const outcome = await change(w, ABSENT, "follow");

      // That relay holds a newer list than the one built on: this one is saved, and is not the newest everywhere.
      expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: false });
      expect(w.relays[DIRECTORY]!.held).toContainEqual(savedBy(outcome));
    },
  );

  it("is not confirmed either when a relay says so on its second try", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay([old], { writes: { answers: [{ closes: true }, { refuse: "replaced: have newer event" }] } }),
      [DIRECTORY]: relay([old]),
      [BIG]: relay([old]),
    });

    const outcome = await change(w, ABSENT, "follow");

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: false });
    expect(w.relays[NOS]!.writer.published).toHaveLength(2);
  });

  it("is not confirmed when a relay says it holds a newer one, is tried again, and refuses for another reason", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      // Said under a reason that may pass, so it is sent the list once more: what it said the first time stands.
      [NOS]: relay([old], { writes: { answers: [{ refuse: "error: a newer list is stored" }, { refuse: "blocked: not on the list" }] } }),
      [DIRECTORY]: relay([old]),
      [BIG]: relay([old]),
    });

    const outcome = await change(w, ABSENT, "follow");

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: false });
    expect(w.relays[NOS]!.writer.published).toHaveLength(2);
  });

  it("is not confirmed when a relay says it holds a newer one and then takes it, and that relay is read back with the rest", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      [NOS]: relay([old], { writes: { answers: [{ refuse: "rate-limited: a newer event exists" }] } }),
      [DIRECTORY]: relay([old]),
      [BIG]: relay([old]),
    });

    const outcome = await change(w, ABSENT, "follow");

    expect(outcome).toEqual({ kind: "saved", list: savedBy(outcome), confirmed: false });
    expect(w.relays[NOS]!.held).toContainEqual(savedBy(outcome));
    expect(w.relays[NOS]!.asked.filter(asksForList)).toHaveLength(2);
  });

  it("is not saved when every relay refuses it as replaced", async () => {
    const old = buildFollowList(SECRET);
    const newerThere = () => relay([old], { writes: { refuse: "replaced: have newer event" } });
    const w = world({ [NOS]: newerThere(), [DIRECTORY]: newerThere(), [BIG]: newerThere() });

    expect(await change(w, ABSENT, "follow")).toEqual({ kind: "not-saved" });
  });

  it("is saved but not confirmed when the relays that took it do not answer the read-back", async () => {
    const old = buildFollowList(SECRET);
    let reads = 0;
    // Each answers the first read of the list, and never the second.
    const once = (reader: RelayReader): RelayReader => silentWhen((filter) => asksForList(filter) && ++reads > 3)(reader);
    const w = world({ [NOS]: relay([old], { reads: once }), [DIRECTORY]: relay([old], { reads: once }), [BIG]: relay([old], { reads: once }) });
    const ended = track(change(w, ABSENT, "follow"));

    await vi.advanceTimersByTimeAsync(FOLLOW_READ_MS);

    expect(ended.outcome).toEqual({ kind: "saved", list: savedBy(ended.outcome), confirmed: false });
  });
});

describe("stopping a change", () => {
  const reason = new Error("signed out");

  it("rejects at once, having read nothing, when its signal has aborted already", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const stop = new AbortController();
    stop.abort(reason);

    await expect(change(w, ABSENT, "follow", { signal: stop.signal })).rejects.toBe(reason);
    expect(Object.values(w.relays).flatMap((each) => each.asked)).toEqual([]);
  });

  it("rejects with the signal's reason when stopped while it reads, and then signs and sends nothing", async () => {
    const old = buildFollowList(SECRET);
    // The relays never answer the read of the list, whatever the signal does.
    const stuck = () => relay([old], { reads: silentWhen(asksForList) });
    const w = world({ [NOS]: stuck(), [DIRECTORY]: stuck(), [BIG]: stuck() });
    const stop = new AbortController();
    const by = signer();
    const ended = track(change(w, ABSENT, "follow", { by, signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(10);
    expect(ended).toEqual({});
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.error).toBe(reason);

    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);
    expect(by.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("rejects with the signal's reason when stopped while the signer is asked, and then sends nothing", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const stop = new AbortController();
    const by = signer();
    let sign!: () => void;
    by.signEvent.mockImplementationOnce(
      (asked) =>
        new Promise((resolve) => {
          sign = () => resolve(finalizeEvent(structuredClone(asked), SECRET));
        }),
    );
    const ended = track(change(w, ABSENT, "follow", { by, signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(10);
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.error).toBe(reason);

    // The signer answers after all: it is too late.
    sign();
    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);
    expect(w.published()).toEqual([]);
  });

  it("hands the list to no relay when stopped while what the signer returned is checked: not even to a writer that takes no notice of being stopped", async () => {
    const w = everywhere([buildFollowList(SECRET)]);
    const stop = new AbortController();
    /** A writer that takes whatever it is handed, whatever its signal says. */
    const handed: NostrEvent[] = [];
    const careless: RelayWriter = {
      async publish(event) {
        handed.push(event);
      },
    };
    const by = signer();
    by.signEvent.mockImplementationOnce(async (asked) => {
      const signed = asSent(finalizeEvent(structuredClone(asked), SECRET));
      // Stopped as the answer is read: once the signer has answered, and before the list is sent.
      return Object.defineProperty({ ...signed }, "sig", {
        enumerable: true,
        get() {
          stop.abort(reason);
          return signed.sig;
        },
      });
    });
    const ended = track(change({ ...w, writers: () => careless }, ABSENT, "follow", { by, signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);

    expect(ended.error).toBe(reason);
    expect(by.signEvent).toHaveBeenCalledTimes(1);
    expect(handed).toEqual([]);
  });

  it("rejects with the signal's reason when stopped while it sends, stops the relays it was sending to, and sends nothing more", async () => {
    const old = buildFollowList(SECRET);
    const w = world({
      // One that would fail in a way that may pass, a second later: stopped first, it is not sent the list again.
      [NOS]: relay([old], { writes: { answers: [{ closes: true, delayMs: 1_000 }] } }),
      [DIRECTORY]: relay([old], { writes: { silent: true } }),
      [BIG]: relay([old], { writes: { silent: true } }),
    });
    const stop = new AbortController();
    const ended = track(change(w, ABSENT, "follow", { signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(500);
    expect(ended).toEqual({});
    for (const each of Object.values(w.relays)) expect(each.writer.published).toHaveLength(1);

    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.error).toBe(reason);
    for (const each of Object.values(w.relays)) expect(each.writer.signals[0]?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);
    for (const each of Object.values(w.relays)) expect(each.writer.published).toHaveLength(1);
    // Nor is it read back.
    for (const each of Object.values(w.relays)) expect(each.asked.filter(asksForList)).toHaveLength(1);
  });

  it("rejects when stopped while it waits out the 3 seconds for the other relays, stops their sends, and reads nothing back", async () => {
    const old = buildFollowList(SECRET);
    const w = world({ [NOS]: relay([old], { writes: { silent: true } }), [DIRECTORY]: relay([old]), [BIG]: relay([old]) });
    const stop = new AbortController();
    const ended = track(change(w, ABSENT, "follow", { signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ended).toEqual({});
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(ended.error).toBe(reason);
    expect(w.relays[NOS]!.writer.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);
    for (const each of Object.values(w.relays)) expect(each.asked.filter(asksForList)).toHaveLength(1);
  });

  it("still stops a send that goes on after the outcome, when the caller stops (ruling R10)", async () => {
    const old = buildFollowList(SECRET);
    const w = world({ [NOS]: relay([old], { writes: { silent: true } }), [DIRECTORY]: relay([old]), [BIG]: relay([old]) });
    const stop = new AbortController();
    const ended = track(change(w, ABSENT, "follow", { signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(FOLLOW_SETTLE_MS);
    expect(ended.outcome?.kind).toBe("saved");
    expect(w.relays[NOS]!.writer.signals[0]?.aborted).toBe(false);

    // The person signs out: the send still under way ends there, and leaves nothing running.
    stop.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.relays[NOS]!.writer.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(ended.error).toBeUndefined();
  });

  it("does not take its own stopping for a failure that may pass, whatever the reason reads as: no relay is tried again", async () => {
    const old = buildFollowList(SECRET);
    const quiet = () => relay([old], { writes: { silent: true } });
    const w = world({ [NOS]: quiet(), [DIRECTORY]: quiet(), [BIG]: quiet() });
    const writers = vi.fn(w.writers);
    const stop = new AbortController();
    const ended = track(change({ ...w, writers }, ABSENT, "follow", { signal: stop.signal }));

    await vi.advanceTimersByTimeAsync(500);
    expect(writers).toHaveBeenCalledTimes(3);
    // A reason that reads as a connection lost, which from a relay is a failure that may pass.
    const lost = new DOMException("The tab went offline", "NetworkError");
    stop.abort(lost);
    await vi.advanceTimersByTimeAsync(FOLLOW_LOCK_WAIT_MS);

    expect(ended.error).toBe(lost);
    expect(writers).toHaveBeenCalledTimes(3);
  });
});
