import type { NostrEvent } from "@nostrify/nostrify";
import { cleanup, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { forgetFollowFloor } from "../src/follow/change";
import { FOLLOW_REREAD_MS, UNDO_MS } from "../src/follow/FollowProvider";
import { FOLLOW_READ_MS } from "../src/follow/read";
import { keepCopy, keptCopies } from "../src/follow/kept";
import { TOWNS_WAIT_MS } from "../src/places/store";
import { ABSENT, buildFollowList, FOLLOW_LIST_TIME, FOLLOWED_IN_LIST, pubkeyAt } from "./fixtures/follow-list";
import { shapedEvent } from "./support/events";
import { asksForList, BIG, DIRECTORY, FOLLOW_RELAYS, NOS, OWN, relay, setUpRelays, strangers, type World, world } from "./support/followWorld";
import {
  after,
  asksFirst,
  followedNow,
  forgetFollowedSeen,
  gate,
  installAddOn,
  openInShell,
  openSignedIn,
  says,
  settle,
  signedInAs,
  signedInNow,
  tap,
  tapSession,
} from "./support/followPage";

/*
 * The session's own follow list when no relay the person writes to answers, and several of the
 * app's relays hold the same list: `FollowProvider` holds that list for the buttons to draw from,
 * and for nothing else; a press comes back asking; and only the person's own answer, Use this copy,
 * makes the change, the very one that asked, on the very list they were asked about
 * (tests/followChange.test.ts holds `changeFollow` to that; tests/followButton.test.tsx has the
 * button and its words). Relays are held in memory, the keys are thrown away, and nothing opens a
 * socket.
 */

vi.mock("../src/follow/kept", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/follow/kept")>();
  return { ...actual, keepCopy: vi.fn(actual.keepCopy) };
});
/** Each copy kept in the device's storage: the real keeping, unless a test plays the next. */
const storageWrites = vi.mocked(keepCopy);

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const OTHER_SECRET = generateSecretKey();

/** A year, in seconds. */
const YEAR = 60 * 60 * 24 * 365;
/** The person's list as it was a year ago, of 1,200 entries: the copy the app's relays hold. */
const OLD_AT = FOLLOW_LIST_TIME - YEAR;
const OLD = buildFollowList(SECRET, OLD_AT);
/** Someone that copy names, with nothing after the key; and two it does not name. */
const FRIEND_AT = 8;
const FRIEND = pubkeyAt(FRIEND_AT);
const ALSO_ABSENT = pubkeyAt(20_001);
/** Their list now, which names one person more, followed last week: only the relay they write to holds it. */
const NEWEST = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME, content: OLD.content, tags: [...OLD.tags, ["p", ALSO_ABSENT]] }, SECRET);
/** Their relay list: they write to a relay of their own. */
const theirs = shapedEvent({ kind: 10002, pubkey: ME, tags: [["r", OWN, "write"]] });

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** The newest follow list the relay at `url` holds. */
const newestOn = (w: World, url: string) =>
  w.relays[url]!.held.filter((event) => event.kind === 3).sort((a, b) => b.created_at - a.created_at)[0];

/** How many times each follow-list relay was asked for a follow list, in their order. */
const listReads = (w: World) => FOLLOW_RELAYS.map((url) => w.relays[url]!.asked.filter(asksForList).length);

/**
 * Each of the app's three relays holds `held` (the directory their relay list too), and the relay
 * they write to holds their newest list, and is out: it takes what it is sent, and sends nothing.
 */
function ownOut(held: NostrEvent = OLD): World {
  const w = world({ [NOS]: relay([held]), [DIRECTORY]: relay([held, theirs]), [BIG]: relay([held]), [OWN]: relay([NEWEST]) });
  w.relays[OWN]!.down = true;
  return w;
}

/** Every event any of the app's three relays, and the relay they write to, was sent. */
const sentAnywhere = (w: World) => w.published();

/** What the app warns of or reports as an error: nothing here may be. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  setUpRelays(config);
  config.houseTrustRelays = [];
  strangers.length = 0;
  forgetFollowedSeen();
  forgetFollowFloor();
  storageWrites.mockClear();
  logs = (["warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    cleanup();
    await vi.advanceTimersByTimeAsync(TOWNS_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "nostr");
    window.sessionStorage.clear();
  }
});

/** The page, for the person signed in, once the buttons have drawn from the copy. */
async function opened(w: World, people: Record<string, string> = { stranger: ABSENT, friend: FRIEND }) {
  const addOn = signedInAs(SECRET);
  const page = await openSignedIn(w, people, { lists: true });
  await waitFor(() => expect(says(Object.keys(people)[0]!)).not.toBe("unknown"));
  return { ...page, addOn };
}

// ---------------------------------------------------------------------------------------------

describe("the list held for the buttons, from a read that is not one to trust", () => {
  it("is the list three of the app's relays hold, when no relay the person writes to answers: the buttons draw from it, and nothing is signed or sent", async () => {
    const w = ownOut();

    const { addOn } = await opened(w);

    expect(says("friend")).toBe("following");
    expect(says("stranger")).toBe("not-following");
    // It is for the buttons alone: what reads other people's records from the person's list is told of none.
    expect(followedNow()).toBeNull();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    expect(await keptCopies(ME)).toEqual([]);
  });

  it.each<[string, () => World]>([
    [
      "two of the three hold it",
      () => {
        const w = ownOut();
        w.relays[BIG]!.held.length = 0;
        return w;
      },
    ],
    [
      "the three hold it, and the relay list could not be read",
      () => {
        const w = world({ [NOS]: relay([OLD]), [DIRECTORY]: relay([OLD, theirs]), [BIG]: relay([OLD]), [OWN]: relay([NEWEST]) });
        w.relays[DIRECTORY]!.down = true;
        return w;
      },
    ],
    ["no list is found, and all three answer with nothing", () => ownOut(shapedEvent({ kind: 0, pubkey: ME, content: "{}" }))],
  ])("holds nothing when %s: no button draws, as before", async (_, relaysOf) => {
    signedInAs(SECRET);
    const w = relaysOf();

    await openSignedIn(w, { stranger: ABSENT, friend: FRIEND }, { lists: true });
    await waitFor(() => expect(w.asked().length).toBeGreaterThan(0));
    await settle();

    expect(says("friend")).toBe("unknown");
    expect(says("stranger")).toBe("unknown");
    expect(followedNow()).toBeNull();
  });

  it.each<[string, () => number]>([
    ["more than a day after the device's clock", () => Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60],
    ["before 2020", () => Date.UTC(2019, 11, 31) / 1000],
  ])("holds nothing when the list the three hold is dated %s: no button draws, and a press asks nothing", async (_, at) => {
    const addOn = signedInAs(SECRET);
    const w = ownOut(buildFollowList(SECRET, at()));

    await openSignedIn(w, { stranger: ABSENT, friend: FRIEND }, { lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();

    expect(says("friend")).toBe("unknown");
    expect(says("stranger")).toBe("unknown");
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("unknown trouble:not-loaded"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
  });

  it("is taken for a list this tab has seen: a change that finds only an older list, once their relay answers, is not made", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);

    const older = buildFollowList(SECRET, OLD_AT - YEAR);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.splice(0, Number.POSITIVE_INFINITY, older, theirs);
    w.relays[OWN]!.held.splice(0, Number.POSITIVE_INFINITY, older);
    w.relays[OWN]!.down = false;

    tap("stranger", "follow");

    // A read to trust, and it has missed the list on screen: a change built on the older one would take that list's place.
    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-loaded"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    expect(await keptCopies(ME)).toEqual([]);
  });

  it("is what a press is held to when the relays that hold it stop answering: three others hold an older list, and the person is not asked about that one", async () => {
    // The app has six relays: three hold a list of this year, three the copy of a year ago. Their own relay is out.
    const SIX = [...FOLLOW_RELAYS, "wss://fourth.example.test", "wss://fifth.example.test", "wss://sixth.example.test"];
    config.followListRelays = [...SIX];
    const newer = finalizeEvent({ kind: 3, created_at: OLD_AT + 30 * 24 * 60 * 60, content: OLD.content, tags: [...OLD.tags, ["p", ALSO_ABSENT]] }, SECRET);
    const w = ownOut(newer);
    for (const url of SIX.slice(3)) w.relays[url] = relay([OLD]);
    const { addOn } = await opened(w, { stranger: ABSENT, another: ALSO_ABSENT });
    // The buttons draw from the newer one.
    expect(says("another")).toBe("following");

    // The three that hold it no longer send a list. The newest found is the older one, with three agreeing.
    for (const url of FOLLOW_RELAYS) w.relays[url]!.listsDown = true;
    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-loaded"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    expect(await keptCopies(ME)).toEqual([]);
  });

  it("is read again once thirty seconds have passed and a button next appears, and gives way to the newer list their own relay then sends", async () => {
    const w = ownOut();
    const page = await opened(w);
    expect(listReads(w)).toEqual([1, 1, 1]);

    // Inside the wait: a button that appears has nothing read.
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });
    await settle();
    expect(listReads(w)).toEqual([1, 1, 1]);
    expect(says("another")).toBe("not-following");

    // Their relay is back, with their list as it is now: older than nothing here, and it names one person more.
    w.relays[OWN]!.down = false;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT, late: pubkeyAt(3) });
    await waitFor(() => expect(says("another")).toBe("following"));
    expect(listReads(w)).toEqual([2, 2, 2]);
    expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ALSO_ABSENT]);

    // Known for sure now: it is not read again, however long the page stays open.
    await after(2 * FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND });
    await settle();
    expect(listReads(w)).toEqual([2, 2, 2]);
  });

  it("gives way to the very same list, once a read to trust finds it: it is their list then, and what reads other people's records from it is told", async () => {
    const w = ownOut();
    const page = await opened(w);
    expect(followedNow()).toBeNull();

    // Their relay answers, with no newer list than the copy: the copy is the newest there is.
    w.relays[OWN]!.held.splice(0, Number.POSITIVE_INFINITY, OLD);
    w.relays[OWN]!.down = false;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });

    await waitFor(() => expect(followedNow()).toEqual(FOLLOWED_IN_LIST));
    expect(says("friend")).toBe("following");
  });

  it.each<[string, boolean, number]>([
    ["a read to trust: their relay answers with it", true, 3],
    ["a read that is not: three of the app's relays hold it, and their relay is out still", false, 3],
    ["a read that can be neither trusted nor asked about: two of the app's relays hold it", false, 2],
  ])("stays when a later read finds only an older list (%s): that read has missed the copy, which this tab has seen", async (_, ownAnswers, holders) => {
    const w = ownOut();
    const page = await opened(w);
    const { addOn } = page;
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe(`following asking:${OLD_AT}`));

    // The relays no longer hold the copy: what answers has an older list, which names the stranger and not the friend.
    const older = finalizeEvent({ kind: 3, created_at: OLD_AT - YEAR, content: "", tags: [["p", ABSENT]] }, SECRET);
    FOLLOW_RELAYS.forEach((url, at) => w.relays[url]!.held.splice(0, Number.POSITIVE_INFINITY, ...(at < holders ? [older, theirs] : [theirs])));
    w.relays[OWN]!.held.splice(0, Number.POSITIVE_INFINITY, older);
    w.relays[OWN]!.down = !ownAnswers;
    const reads = listReads(w);
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual(reads.map((count) => count + 1)));
    await settle();

    // Drawn from the copy still, and asked about it still: nothing is shown from a list known not to be the newest.
    expect(says("friend")).toBe(`following asking:${OLD_AT}`);
    expect(says("stranger")).toBe("not-following");
    expect(followedNow()).toBeNull();
    // And their answer builds nothing on the older list.
    tap("friend", "use");
    await waitFor(() => expect(says("friend")).toBe("following trouble:not-loaded"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
  });

  it("stays as it is, and what they are asked about with it, when a later read finds the same list on fewer relays: nothing is taken from the page for it", async () => {
    const w = ownOut();
    const page = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`));
    expect(listReads(w)).toEqual([2, 2, 2]);

    // One of the three no longer answers: two agree, which is too few to ask about. It is the same list still.
    w.relays[BIG]!.down = true;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual([3, 3, 3]));
    await settle();

    expect(says("friend")).toBe("following");
    expect(says("another")).toBe("not-following");
    expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`);
    // And it is read again after as long, not before.
    w.relays[BIG]!.down = false;
    page.show({ stranger: ABSENT, friend: FRIEND });
    await settle();
    expect(listReads(w)).toEqual([3, 3, 3]);
  });

  it("stays as it is when a later read can tell nothing: their relay list could not be read", async () => {
    const w = ownOut();
    const page = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    w.relays[DIRECTORY]!.down = true;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });
    await settle();
    await after(FOLLOW_READ_MS);

    expect(says("friend")).toBe("following");
    expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`);
  });

  it("is let go of, with what they were asked about, when a later read finds another list the newest, on too few relays to ask about: no button draws from a list that is known not to be the newest", async () => {
    const w = ownOut();
    const page = await opened(w);
    const { addOn } = page;
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`));

    // Another app's change has reached one of the app's relays: a newer list than the copy, on one relay.
    const since = finalizeEvent({ kind: 3, created_at: OLD_AT + 500, content: OLD.content, tags: OLD.tags.slice(0, 40) }, SECRET);
    w.relays[NOS]!.held.push(since);
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });

    await waitFor(() => expect(says("friend")).toBe("unknown"));
    for (const name of ["stranger", "another"]) expect(says(name)).toBe("unknown");
    expect(followedNow()).toBeNull();
    // Their answer has gone with it: it was for a copy that is not the newest.
    tap("stranger", "use");
    await settle();
    expect(says("stranger")).toBe("unknown");
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);

    // It is read again as a list that is not known is: once the others hold the newer one too, the buttons draw from that.
    for (const url of [DIRECTORY, BIG]) w.relays[url]!.held.push(since);
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT, late: pubkeyAt(3) });
    await waitFor(() => expect(says("late")).toBe("following"));
    // The friend is among the forty entries the newer list keeps.
    expect(says("friend")).toBe("following");
    expect(says("stranger")).toBe("not-following");
  });

  it("gives way to another copy, and lets go of what they were asked about the first, when a later read finds another list on three relays", async () => {
    const w = ownOut();
    const page = await opened(w);
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe(`following asking:${OLD_AT}`));

    // A newer list, which no longer names the friend, on every one of the app's relays.
    const since = finalizeEvent({ kind: 3, created_at: OLD_AT + 500, content: OLD.content, tags: OLD.tags.filter((_, at) => at !== FRIEND_AT) }, SECRET);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.push(since);
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });

    // Drawn from the newer copy, with nothing asked: the date they were shown was the older one's.
    await waitFor(() => expect(says("friend")).toBe("not-following"));
    expect(says("stranger")).toBe("not-following");
  });

  it("is not read again before thirty seconds have passed since a read that could neither be trusted nor asked about", async () => {
    const w = ownOut();
    const page = await opened(w);

    w.relays[BIG]!.down = true;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual([2, 2, 2]));
    await settle();

    expect(says("friend")).toBe("following");
    expect(says("another")).toBe("not-following");
    // And it is read again after as long, not before.
    w.relays[BIG]!.down = false;
    page.show({ stranger: ABSENT, friend: FRIEND });
    await settle();
    expect(listReads(w)).toEqual([2, 2, 2]);
  });

  it("does not take the place of a list a change saved while it was being read", async () => {
    signedInAs(SECRET);
    // Their relay answers for the change, and the page's own read, begun before, ends after it with
    // the copy: the app's relays take the changed list, and go on sending the old one.
    const lagging = { lags: true };
    const w = world({ [NOS]: relay([OLD], lagging), [DIRECTORY]: relay([OLD, theirs], lagging), [BIG]: relay([OLD], lagging), [OWN]: relay([NEWEST]) });
    const held = gate();
    for (const url of FOLLOW_RELAYS) w.relays[url]!.holds = held.closed;
    w.relays[OWN]!.down = true;
    await openSignedIn(w, { stranger: ABSENT, another: ALSO_ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));

    w.relays[OWN]!.down = false;
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(says("another")).toBe("following");
    // Now the page's own read ends, with the copy the app's relays still send.
    await held.open();
    await settle();

    // The list the change saved stays, on their newest: the one person more it names is followed still.
    expect(says("stranger")).toBe("following just");
    expect(says("another")).toBe("following");
  });
});

describe("a press, when the list held is not one to trust", () => {
  it("comes back asking, with when the copy was last changed: the button is as it was, and nothing is signed, sent or kept", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);

    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");

    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`));
    // Nobody else is asked anything.
    expect(says("friend")).toBe("following");
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    expect(await keptCopies(ME)).toEqual([]);
  });

  it("is let go of on Not now: nothing was sent to any relay, and no copy was kept", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    tap("stranger", "not now");

    expect(says("stranger")).toBe("not-following");
    await settle();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    expect(await keptCopies(ME)).toEqual([]);
    // Nor does Use this copy do anything after it: there is nothing they were asked about.
    tap("stranger", "use");
    await settle();
    expect(says("stranger")).toBe("not-following");
    expect(addOn.signEvent).not.toHaveBeenCalled();
  });

  it("makes the follow on Use this copy: the list saved is the copy with one entry more, and the copy was kept first, byte for byte", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));
    const asked = asksFirst(addOn, SECRET);

    tap("stranger", "use");
    expect(says("stranger")).toBe("saving");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    // Kept already, before the person has approved anything: the copy as the relays sent it.
    const copies = await keptCopies(ME);
    expect(copies.map((copy) => [copy.list, copy.for])).toEqual([[asSent(OLD), { did: "follow", who: ABSENT }]]);
    expect(JSON.stringify(copies[0]!.list)).toBe(JSON.stringify(asSent(OLD)));

    await asked.yes();
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    for (const url of [...FOLLOW_RELAYS, OWN]) {
      expect(w.relays[url]!.writer.published).toHaveLength(1);
      expect(w.relays[url]!.writer.published[0]!.tags).toEqual([...OLD.tags, ["p", ABSENT]]);
      expect(w.relays[url]!.writer.published[0]!.content).toBe(OLD.content);
    }
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ABSENT]);
  });

  it("asks again on a second press of the button: it is not their answer, and does not use the copy", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");

    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`));
    expect(listReads(w)).toEqual([3, 3, 3]);
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
  });

  it("is never made on the strength of the list held: with their relay back, the follow is made on their newest list, and asks nothing", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    w.relays[OWN]!.down = false;

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(newestOn(w, OWN)?.tags).toEqual([...NEWEST.tags, ["p", ABSENT]]);
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    // The one person more their newest list names is followed, as the list the change saved has it.
    expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ALSO_ABSENT, ABSENT]);
  });

  it("is not loaded, and asks nothing, when fewer relays hold the copy by the time of the press", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    w.relays[BIG]!.down = true;

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-loaded"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
  });

  it("asks again, about the list now found, when Use this copy finds another list the newest: the answer was for the one they were shown", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`));

    // Another app's change reaches the app's relays before they answer.
    const since = finalizeEvent({ kind: 3, created_at: OLD_AT + 500, content: OLD.content, tags: OLD.tags.slice(0, 40) }, SECRET);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.push(since);
    tap("stranger", "use");

    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT + 500}`));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    expect(await keptCopies(ME)).toEqual([]);

    // And their answer for that one makes the follow on it.
    tap("stranger", "use");
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(newestOn(w, NOS)?.tags).toEqual([...since.tags, ["p", ABSENT]]);
  });

  it("says a copy could not be kept when the copy cannot be kept first, and signs nothing: no net, no leap", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));
    // The device's storage refuses the write.
    storageWrites.mockResolvedValueOnce(false);

    tap("stranger", "use");

    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-kept"));
    expect(storageWrites).toHaveBeenCalledTimes(1);
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    // Try again asks them again, and with the storage back their answer makes the follow.
    tap("stranger", "retry");
    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`));
    tap("stranger", "use");
    await waitFor(() => expect(says("stranger")).toBe("following just"));
  });
});

describe("a change made by their say that changes nothing", () => {
  it("leaves the copy as one they have not agreed to build on: the buttons draw from it, nothing else is told who it names, and it is read again as before", async () => {
    // Their relay answers as the page opens: the list held is their newest, by a read to trust.
    const w = ownOut();
    w.relays[OWN]!.down = false;
    const page = await opened(w);
    const { addOn } = page;
    expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ALSO_ABSENT]);
    // Then it is out, and another app's newer list, which names the stranger, is on each of the app's relays.
    w.relays[OWN]!.down = true;
    const since = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + 500, content: OLD.content, tags: [...NEWEST.tags, ["p", ABSENT]] }, SECRET);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.push(since);

    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${since.created_at}`));
    tap("stranger", "use");

    // Found to be so already on that copy: the button says so, and nothing was signed, sent or kept.
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
    expect(await keptCopies(ME)).toEqual([]);
    // Nothing was saved: the list held is a copy found elsewhere, newer than the one before it, for the buttons alone.
    expect(says("friend")).toBe("following");
    expect(followedNow()).toBeNull();
    // And the next change asks: nothing of this tab's making is there to go on from.
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe(`following asking:${since.created_at}`));
    tap("friend", "not now");

    // It is read for again once the wait is over, and gives way to what a read to trust then finds.
    const reads = listReads(w);
    w.relays[OWN]!.down = false;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });
    await waitFor(() => expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ALSO_ABSENT, ABSENT]));
    expect(listReads(w)).toEqual(reads.map((count) => count + 1));
  });
});

describe("Use this copy makes the very change that asked", () => {
  it("unfollows when an unfollow asked, and offers Undo for what it took out", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);

    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe(`following asking:${OLD_AT}`));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    tap("friend", "use");

    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    expect(newestOn(w, NOS)?.tags).toEqual(OLD.tags.filter((_, at) => at !== FRIEND_AT));
    expect((await keptCopies(ME)).map((copy) => [copy.list.id, copy.for])).toEqual([[OLD.id, { did: "unfollow", who: FRIEND }]]);
  });

  it("puts back exactly what the unfollow took out when Undo asked, where it was, though Undo's ten seconds end while they are asked", async () => {
    // Their relay answers for the unfollow, which is an ordinary change; and is out by the time of Undo.
    const w = world({ [NOS]: relay([OLD]), [DIRECTORY]: relay([OLD, theirs]), [BIG]: relay([OLD]), [OWN]: relay([OLD]) });
    const { addOn } = await opened(w, { friend: FRIEND, stranger: ABSENT });
    expect(says("friend")).toBe("following");
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    const left = newestOn(w, NOS)!;
    w.relays[OWN]!.down = true;

    tap("friend", "undo");
    await waitFor(() => expect(says("friend")).toContain(`asking:${left.created_at}`));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    // The ten seconds are over, and nothing was put back meanwhile.
    await after(UNDO_MS);
    expect(says("friend")).toBe(`not-following asking:${left.created_at}`);

    tap("friend", "use");

    await waitFor(() => expect(says("friend")).toBe("following"));
    // As the list wrote them, where they were: the list is the one the unfollow was made on, entry for entry.
    expect(newestOn(w, NOS)?.tags).toEqual(OLD.tags);
    expect(addOn.signEvent).toHaveBeenCalledTimes(2);
  });

  it("puts the entry back with its hint and its name, in its place, when the button is pressed again once Undo has asked and its ten seconds are over: the press repeats what asked, and is no plain follow", async () => {
    const HINTED_AT = 10;
    const HINTED = pubkeyAt(HINTED_AT);
    expect(OLD.tags[HINTED_AT]).toEqual(["p", HINTED, "wss://relay.example.test", "petname-10"]);
    // Their relay answers for the unfollow, which is an ordinary change; and is out by the time of Undo.
    const w = world({ [NOS]: relay([OLD]), [DIRECTORY]: relay([OLD, theirs]), [BIG]: relay([OLD]), [OWN]: relay([OLD]) });
    const { addOn } = await opened(w, { hinted: HINTED, stranger: ABSENT });
    tap("hinted", "unfollow");
    await waitFor(() => expect(says("hinted")).toBe("not-following undo"));
    w.relays[OWN]!.down = true;
    tap("hinted", "undo");
    await waitFor(() => expect(says("hinted")).toContain("asking"));
    await after(UNDO_MS);
    expect(says("hinted")).toMatch(/^not-following asking:\d+$/);

    // The button, which says Follow, pressed in place of an answer: asked again, about the same change.
    tap("hinted", "follow");
    expect(says("hinted")).toBe("saving");
    await waitFor(() => expect(says("hinted")).toMatch(/^not-following asking:\d+$/));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    tap("hinted", "use");

    await waitFor(() => expect(says("hinted")).toBe("following"));
    // As the list wrote it, where it was: not a bare entry at the list's end.
    expect(newestOn(w, NOS)?.tags[HINTED_AT]).toEqual(["p", HINTED, "wss://relay.example.test", "petname-10"]);
    expect(newestOn(w, NOS)?.tags).toEqual(OLD.tags);
  });

  it("puts the entry back with its hint and its name when Try again is pressed after their answer was not approved, once Undo's ten seconds are over: Try again is that change, and no plain follow", async () => {
    const HINTED_AT = 10;
    const HINTED = pubkeyAt(HINTED_AT);
    const w = world({ [NOS]: relay([OLD]), [DIRECTORY]: relay([OLD, theirs]), [BIG]: relay([OLD]), [OWN]: relay([OLD]) });
    const { addOn } = await opened(w, { hinted: HINTED, stranger: ABSENT });
    tap("hinted", "unfollow");
    await waitFor(() => expect(says("hinted")).toBe("not-following undo"));
    w.relays[OWN]!.down = true;
    tap("hinted", "undo");
    await waitFor(() => expect(says("hinted")).toContain("asking"));
    await after(UNDO_MS);
    // Their answer, and their add-on says no.
    addOn.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    tap("hinted", "use");
    await waitFor(() => expect(says("hinted")).toBe("not-following trouble:not-approved"));

    // Try again: asked again, about the same change; and their answer puts the entry back as it was.
    tap("hinted", "retry");
    await waitFor(() => expect(says("hinted")).toMatch(/^not-following asking:\d+$/));
    tap("hinted", "use");

    await waitFor(() => expect(says("hinted")).toBe("following"));
    expect(newestOn(w, NOS)?.tags[HINTED_AT]).toEqual(["p", HINTED, "wss://relay.example.test", "petname-10"]);
    expect(newestOn(w, NOS)?.tags).toEqual(OLD.tags);
  });

  it("makes again the follow that failed when Try again asked", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));
    addOn.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    tap("stranger", "use");
    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-approved"));

    // Try again is a press like any other: it reads afresh, and they are asked.
    tap("stranger", "retry");
    await waitFor(() => expect(says("stranger")).toBe(`not-following asking:${OLD_AT}`));
    tap("stranger", "use");

    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(newestOn(w, NOS)?.tags).toEqual([...OLD.tags, ["p", ABSENT]]);
  });

  it("makes again the unfollow that failed when Try again asked, whatever the button would do by now", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toContain("asking"));
    addOn.signEvent.mockRejectedValueOnce(new Error("The person said no"));
    tap("friend", "use");
    await waitFor(() => expect(says("friend")).toBe("following trouble:not-approved"));

    tap("friend", "retry");
    await waitFor(() => expect(says("friend")).toBe(`following asking:${OLD_AT}`));
    tap("friend", "use");

    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    expect(newestOn(w, NOS)?.tags).toEqual(OLD.tags.filter((_, at) => at !== FRIEND_AT));
  });

  it("does nothing for someone they were not asked about, and nothing twice", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    // Not for the friend, who was not asked about.
    tap("friend", "use");
    await settle();
    expect(says("friend")).toBe("following");
    expect(addOn.signEvent).not.toHaveBeenCalled();

    const asked = asksFirst(addOn, SECRET);
    tap("stranger", "use");
    tap("stranger", "use");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));
    await asked.yes();
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    await settle();
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) expect(w.relays[url]!.writer.published).toHaveLength(1);
  });
});

describe("one asking at a time", () => {
  it("is replaced by a second press elsewhere that asks: the first person is asked nothing any more, and their answer does nothing", async () => {
    const w = ownOut();
    const { addOn } = await opened(w, { stranger: ABSENT, friend: FRIEND, other: pubkeyAt(20_002) });
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    tap("friend", "unfollow");
    // Still asked about the first while the second is being read for.
    expect(says("stranger")).toContain("asking");
    await waitFor(() => expect(says("friend")).toBe(`following asking:${OLD_AT}`));

    expect(says("stranger")).toBe("not-following");
    tap("stranger", "use");
    await settle();
    expect(says("stranger")).toBe("not-following");
    expect(addOn.signEvent).not.toHaveBeenCalled();

    // The answer is for the second, and makes that change.
    tap("friend", "use");
    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    expect(newestOn(w, NOS)?.tags).toEqual(OLD.tags.filter((_, at) => at !== FRIEND_AT));
  });

  it("goes when the person goes to another page, as the other lines do, and is not there when they come back", async () => {
    const addOn = signedInAs(SECRET);
    const w = ownOut();
    const page = await openInShell(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    await page.goTo("/elsewhere");
    expect(says("stranger")).toBe("not-following");
    tap("stranger", "use");
    await settle();
    await page.goTo("/");

    expect(says("stranger")).toBe("not-following");
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
  });

  it("goes with the session: after sign-out nothing is asked, and the answer does nothing for whoever signs in next", async () => {
    const w = ownOut();
    const { addOn } = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    tapSession("sign out");
    await waitFor(() => expect(signedInNow()).toBe("nobody"));
    expect(says("stranger")).toBe("unknown");
    tap("stranger", "use");
    tapSession("sign in");
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    tap("stranger", "use");
    await settle();

    expect(says("stranger")).toBe("not-following");
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
  });

  it("goes once the list held has the person as the change would leave them: there is nothing left to ask, and the button offers no such change", async () => {
    const w = ownOut();
    const page = await opened(w);
    // A newer list, which no longer names the friend, is on every one of the app's relays by the time of the press.
    const since = finalizeEvent({ kind: 3, created_at: OLD_AT + 500, content: OLD.content, tags: OLD.tags.filter((_, at) => at !== FRIEND_AT) }, SECRET);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.push(since);
    tap("friend", "unfollow");
    // Asked about that list; the buttons are still drawn from the copy the page read, which names them.
    await waitFor(() => expect(says("friend")).toBe(`following asking:${since.created_at}`));

    // The page reads again, and holds the very list they were asked about: it has no friend to unfollow.
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });

    await waitFor(() => expect(says("friend")).toBe("not-following"));
    tap("friend", "use");
    await settle();
    expect(says("friend")).toBe("not-following");
    expect(page.addOn.signEvent).not.toHaveBeenCalled();
  });

  it("goes when a read finds a relay of their own answering: the page's own read, once it is made again", async () => {
    const w = ownOut();
    const page = await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    w.relays[OWN]!.down = false;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, friend: FRIEND, another: ALSO_ABSENT });

    await waitFor(() => expect(says("another")).toBe("following"));
    expect(says("stranger")).toBe("not-following");
  });

  it("goes when a change elsewhere on the page is made on a read to trust: their relay answers again", async () => {
    const w = ownOut();
    await opened(w);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));

    w.relays[OWN]!.down = false;
    tap("friend", "unfollow");

    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    expect(says("stranger")).toBe("not-following");
  });
});

describe("for the rest of the visit, after a change made by their say", () => {
  /** The page once the stranger has been followed on the copy, by the person's say: `saved` is the list that left. */
  async function followedBySay(people: Record<string, string> = { stranger: ABSENT, friend: FRIEND, other: pubkeyAt(20_002) }) {
    const w = ownOut();
    const page = await opened(w, people);
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));
    tap("stranger", "use");
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    return { ...page, w, saved: newestOn(w, NOS)! };
  }

  it("makes the next change with no second asking, while the newest list is the very list Regulars saved; and the one after that, on the list that one saved", async () => {
    const { w, addOn, saved } = await followedBySay();

    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    const next = newestOn(w, NOS)!;
    expect(next.tags).toEqual(saved.tags.filter((_, at) => at !== FRIEND_AT));
    // Kept first, as every change made by their say is.
    expect((await keptCopies(ME)).map((copy) => copy.list.id)).toEqual([saved.id, OLD.id]);

    tap("other", "follow");
    await waitFor(() => expect(says("other")).toBe("following just"));
    expect(newestOn(w, NOS)?.tags).toEqual([...next.tags, ["p", pubkeyAt(20_002)]]);
    expect(addOn.signEvent).toHaveBeenCalledTimes(3);
  });

  it("builds nothing on the list Regulars saved once a press has been asked about a newer one: the relays send the saved list again, and this tab was just shown a newer", async () => {
    const { w, addOn, saved } = await followedBySay();
    const since = finalizeEvent({ kind: 3, created_at: saved.created_at + 500, content: saved.content, tags: saved.tags.slice(0, 40) }, SECRET);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.push(since);
    tap("other", "follow");
    await waitFor(() => expect(says("other")).toBe(`not-following asking:${since.created_at}`));
    tap("other", "not now");

    // The newer list is on no relay that answers now: the saved one is the newest found, on three.
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.splice(w.relays[url]!.held.indexOf(since), 1);
    tap("other", "follow");

    await waitFor(() => expect(says("other")).toBe("not-following trouble:not-loaded"));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    expect((await keptCopies(ME)).map((copy) => copy.list.id)).toEqual([OLD.id]);
  });

  it("asks again when another list is the newest by then", async () => {
    const { w, addOn, saved } = await followedBySay();
    const since = finalizeEvent({ kind: 3, created_at: saved.created_at + 500, content: saved.content, tags: saved.tags.slice(0, 40) }, SECRET);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.push(since);

    tap("other", "follow");

    await waitFor(() => expect(says("other")).toBe(`not-following asking:${since.created_at}`));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("lasts when a page is left: a change on the next page needs no second asking", async () => {
    const addOn = signedInAs(SECRET);
    const w = ownOut();
    const page = await openInShell(w, { stranger: ABSENT, other: pubkeyAt(20_002) });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));
    tap("stranger", "use");
    await waitFor(() => expect(says("stranger")).toBe("following just"));

    await page.goTo("/elsewhere");
    tap("other", "follow");

    await waitFor(() => expect(says("other")).toBe("following just"));
    expect(addOn.signEvent).toHaveBeenCalledTimes(2);
  });

  it("is forgotten at sign-out: the same person, signed in again, is asked again", async () => {
    const { addOn } = await followedBySay();

    tapSession("sign out");
    tapSession("sign in");
    await waitFor(() => expect(says("other")).toBe("not-following"));
    tap("other", "follow");

    await waitFor(() => expect(says("other")).toContain("asking"));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("is forgotten for the next person, with no sign-out between: it was the first person's", async () => {
    const { w } = await followedBySay();
    // The next person's list is held as the first's was: on the app's three, with their own relay out.
    const theirList = finalizeEvent({ kind: 3, created_at: OLD_AT, content: "", tags: [["p", FRIEND]] }, OTHER_SECRET);
    const theirRelays = shapedEvent({ kind: 10002, pubkey: getPublicKey(OTHER_SECRET), tags: [["r", OWN, "write"]] });
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.push(theirList);
    w.relays[DIRECTORY]!.held.push(theirRelays);
    const addOn = installAddOn(OTHER_SECRET);

    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(getPublicKey(OTHER_SECRET)));
    await waitFor(() => expect(says("friend")).toBe("following"));
    tap("other", "follow");

    await waitFor(() => expect(says("other")).toBe(`not-following asking:${OLD_AT}`));
    expect(addOn.signEvent).not.toHaveBeenCalled();
  });

  it("is not begun by a change that was saved and could not be checked: a relay said it holds a newer list, and the next change asks again", async () => {
    // A fourth of the app's relays holds the copy too, and refuses the changed list as older than one it holds.
    const FOURTH = "wss://fourth.example.test";
    config.followListRelays = [...FOLLOW_RELAYS, FOURTH];
    const w = ownOut();
    w.relays[FOURTH] = relay([OLD], { writes: { refuse: "replaced: have newer event" } });
    const { addOn } = await opened(w, { stranger: ABSENT, other: pubkeyAt(20_002) });
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toContain("asking"));
    tap("stranger", "use");
    await waitFor(() => expect(says("stranger")).toBe("following trouble:unconfirmed just"));
    const saved = newestOn(w, NOS)!;

    // The list Regulars saved is the newest three relays hold: but this tab was told it is not the newest everywhere.
    tap("other", "follow");

    await waitFor(() => expect(says("other")).toBe(`not-following asking:${saved.created_at}`));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("is not begun by a change made on a read to trust: with their relay out after it, the next change asks", async () => {
    const w = ownOut();
    w.relays[OWN]!.down = false;
    const { addOn } = await opened(w, { stranger: ABSENT, other: pubkeyAt(20_002) });
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    const saved = newestOn(w, NOS)!;
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);

    // The very list Regulars saved is the newest on the app's relays: but nobody was asked about anything yet.
    w.relays[OWN]!.down = true;
    tap("other", "follow");

    await waitFor(() => expect(says("other")).toBe(`not-following asking:${saved.created_at}`));
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
  });
});

describe("with Follow off", () => {
  it("holds nothing, asks nothing, and the answers do nothing", async () => {
    config.features.follow = false;
    const addOn = signedInAs(SECRET);
    const w = ownOut();
    await openSignedIn(w, { stranger: ABSENT });
    await settle();

    for (const what of ["follow", "use", "not now"] as const) tap("stranger", what);
    await after(FOLLOW_REREAD_MS);

    expect(says("stranger")).toBe("unknown");
    expect(w.asked()).toEqual([]);
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(sentAnywhere(w)).toEqual([]);
  });
});
