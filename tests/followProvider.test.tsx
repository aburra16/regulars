import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NostrEvent } from "@nostrify/nostrify";
import { cleanup, render, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config";
import { FOLLOW_SETTLE_MS, forgetFollowFloor } from "../src/follow/change";
import { keptCopies } from "../src/follow/kept";
import { FOLLOW_READ_MS } from "../src/follow/read";
import { FOLLOW_REREAD_MS, sameVisit, UNDO_MS } from "../src/follow/FollowProvider";
import { TOWNS_WAIT_MS } from "../src/places/store";
import {
  ABSENT,
  buildFollowList,
  DUPLICATE_AGAIN_AT,
  DUPLICATE_AT,
  DUPLICATED,
  FOLLOW_LIST_TIME,
  FOLLOWED_IN_LIST,
  pubkeyAt,
  UPPER_CASE_KEY,
  UPPER_CASED,
} from "./fixtures/follow-list";
import { shapedEvent } from "./support/events";
import {
  asksForList,
  asksForRelayList,
  BIG,
  DIRECTORY,
  everywhere,
  FOLLOW_RELAYS,
  NOS,
  OWN,
  relay,
  setUpRelays,
  strangers,
  type World,
  world,
} from "./support/followWorld";
import {
  after,
  asksFirst,
  Followed,
  followedNow,
  ownedNow,
  forgetFollowedSeen,
  gate,
  goTo,
  installAddOn,
  open,
  openInShell,
  openSignedIn,
  Person,
  says,
  settle,
  signedInAs,
  signedInNow,
  tap,
  tapSession,
} from "./support/followPage";

/*
 * The session's own follow list, for the buttons: `FollowProvider`, and the hooks `useFollow` and
 * `useOwnFollowed`. It reads the list of the person signed in once a page shows it, and never writes
 * one: a tap goes through `changeFollow` (tests/followChange.test.ts holds that to its safeguards).
 * These hold the provider to what a button is told (nothing until the list is read, and never
 * another person's), to one change of a person at a time, to what a change leaves to say being the
 * person's for the page's visit, to Undo putting back what its unfollow took out, and to when a
 * change is given up: at sign-out, when someone else signs in, and when the app goes away, and at no
 * other time. Relays are held in memory, the keys are thrown away, and nothing opens a socket.
 * (tests/followProviderOutcomes.test.tsx plays the change itself, for the ends these relays cannot
 * bring about.)
 */

const SECRET = generateSecretKey();
const ME = getPublicKey(SECRET);
const OTHER_SECRET = generateSecretKey();
const SOMEONE_ELSE = getPublicKey(OTHER_SECRET);

/** The person's list, of 1,200 entries; one it names, at `FRIEND_AT`, with nothing after the key; and a second person it does not name. */
const LIST = buildFollowList(SECRET);
const FRIEND_AT = 8;
const FRIEND = pubkeyAt(FRIEND_AT);
/** One the list names with a relay hint and a petname, at `HINTED_AT`. */
const HINTED_AT = 10;
const HINTED = pubkeyAt(HINTED_AT);
const ALSO_ABSENT = pubkeyAt(20_001);

// ---------------------------------------------------------------------------------------------
// Relays, held in memory.
// ---------------------------------------------------------------------------------------------

/** How many times each follow-list relay was asked for a follow list, in their order. */
const listReads = (w: World) => FOLLOW_RELAYS.map((url) => w.relays[url]!.asked.filter(asksForList).length);

/** `event` as a relay sends it: its seven fields, without the mark nostr-tools leaves on an event it signed. */
const asSent = ({ id, pubkey, created_at, kind, tags, content, sig }: NostrEvent): NostrEvent => ({ id, pubkey, created_at, kind, tags, content, sig });

/** The newest follow list the relay at `url` holds. */
const newestOn = (w: World, url: string) =>
  w.relays[url]!.held.filter((event) => event.kind === 3).sort((a, b) => b.created_at - a.created_at)[0];

/** Makes every follow-list relay hold `events`, and nothing else. */
function nowHolding(w: World, events: NostrEvent[]): void {
  for (const url of FOLLOW_RELAYS) w.relays[url]!.held.splice(0, Number.POSITIVE_INFINITY, ...events);
}

/**
 * Makes every follow-list relay unable to send a follow list, or able again. Each still answers what
 * else it is asked, the person's relay list among it (the directory is one of them): so the read of
 * the list is made, from all three, and cannot tell. (A directory that is out altogether is another
 * case: the list is then not asked for at all. The tests of a read that cannot be trusted have it.)
 */
function setDown(w: World, down: boolean): void {
  for (const url of FOLLOW_RELAYS) w.relays[url]!.listsDown = down;
}

/** Holds each follow-list relay's next answer to a request for a follow list, until the gate it gives is opened. */
function holdListReads(w: World) {
  const held = gate();
  for (const url of FOLLOW_RELAYS) w.relays[url]!.holds = held.closed;
  return held;
}

/** What the app warns of or reports as an error: nothing here may be, as a list and its relays are the person's. */
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  // The clocks too. How long a list that could not be read is left unread is told by the one that
  // only goes forward (`performance.now()`), which the timers here move; the date is the device's to
  // set, and a test sets it to show that nothing is told by it.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  setUpRelays(config);
  // The scores store reads nothing of its own here: every read these see is the follow list's.
  config.houseTrustRelays = [];
  strangers.length = 0;
  forgetFollowedSeen();
  // Each test starts as a tab just opened: no list seen yet.
  forgetFollowFloor();
  logs = (["warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(async () => {
  try {
    // The app goes away: every change and read under way is stopped, and no timer of theirs is left
    // (the shortest of them is seconds long). The places store's own short wait for the towns, which
    // strict mode leaves running, is over by then.
    cleanup();
    await vi.advanceTimersByTimeAsync(TOWNS_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(strangers).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "nostr");
    // Whatever failed above, the next test starts signed out.
    window.sessionStorage.clear();
  }
});

// ---------------------------------------------------------------------------------------------

describe("the person's own list", () => {
  it("says nothing of anyone until it has been read, and then who is followed and who is not", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    const answer = holdListReads(w);

    await openSignedIn(w, { friend: FRIEND, stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    expect(says("friend")).toBe("unknown");
    expect(says("stranger")).toBe("unknown");
    expect(followedNow()).toBeNull();

    await answer.open();
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(says("stranger")).toBe("not-following");
    expect(followedNow()).toEqual(FOLLOWED_IN_LIST);
    // It was read, and nothing written: nothing was signed, and no relay was sent anything.
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is read for a page that only lists who is followed", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);

    await openSignedIn(w, {}, { lists: true });

    await waitFor(() => expect(followedNow()).toEqual(FOLLOWED_IN_LIST));
    expect(listReads(w)).toEqual([1, 1, 1]);
  });

  it("is not read while no page shows it", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);

    const page = await openSignedIn(w, {});
    await settle();
    expect(w.asked()).toEqual([]);

    // A page that shows it is opened: now it is read.
    page.show({ friend: FRIEND });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([1, 1, 1]);
  });

  it("is read from the relays the person's own relay list names, with the follow-list relays, through the readers the scores' provider gives", async () => {
    signedInAs(SECRET);
    const theirRelays = shapedEvent({ kind: 10002, pubkey: ME, tags: [["r", OWN, "write"]] });
    // Only the person's own relay holds their list.
    const w = world({ [NOS]: relay(), [DIRECTORY]: relay([theirRelays]), [BIG]: relay(), [OWN]: relay([LIST]) });

    await openSignedIn(w, { friend: FRIEND, stranger: ABSENT });

    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(says("stranger")).toBe("not-following");
    expect(w.relays[OWN]!.asked.filter(asksForList)).toEqual([{ kinds: [3], authors: [ME], limit: 1 }]);
    // The review relay is asked for the person's relay list, and for no follow list (ruling R12).
    expect(w.reviews.asked.every(asksForRelayList)).toBe(true);
  });

  it("knows a person the list names in upper-case hex, asked for in either case, and nobody for what is no key", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);

    await openSignedIn(w, { lower: UPPER_CASE_KEY, upper: UPPER_CASED, nobody: "not a key" });

    await waitFor(() => expect(says("lower")).toBe("following"));
    expect(says("upper")).toBe("following");
    expect(says("nobody")).toBe("unknown");
    // A tap on what is no key changes nothing, and asks nobody.
    tap("nobody", "follow");
    tap("nobody", "unfollow");
    await settle();
    expect(says("nobody")).toBe("unknown");
    expect(w.published()).toEqual([]);
  });

  it("is read once in React's strict mode, though every effect runs twice, and once however many buttons there are", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    const answer = holdListReads(w);

    const page = await openSignedIn(w, { friend: FRIEND, stranger: ABSENT }, { strict: true, lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    // A button that appears while the list is being read waits for that read.
    page.show({ friend: FRIEND, stranger: ABSENT, another: ALSO_ABSENT });
    await settle();
    await answer.open();

    await waitFor(() => expect(says("another")).toBe("not-following"));
    expect(says("friend")).toBe("following");
    // And one that appears once it is known reads nothing.
    page.show({ friend: FRIEND, stranger: ABSENT, another: ALSO_ABSENT, late: UPPER_CASE_KEY });
    await settle();
    expect(says("late")).toBe("following");
    expect(listReads(w)).toEqual([1, 1, 1]);
    expect(w.relays[DIRECTORY]!.asked.filter(asksForRelayList)).toHaveLength(1);
    expect(w.reviews.asked.filter(asksForRelayList)).toHaveLength(1);
    // Effects that run twice sign nothing and send nothing: the list was read, and no more.
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });
});

describe("signed out", () => {
  it("says nothing of anyone, reads nothing, and a tap does nothing", async () => {
    // The browser has an add-on, and nobody has signed in.
    const addOn = installAddOn(SECRET);
    const w = everywhere([LIST]);

    open(w, { friend: FRIEND }, { lists: true });
    await settle();
    expect(signedInNow()).toBe("nobody");
    expect(says("friend")).toBe("unknown");
    expect(followedNow()).toBeNull();

    tap("friend", "follow");
    tap("friend", "unfollow");
    tap("friend", "undo");
    await settle();
    expect(says("friend")).toBe("unknown");
    expect(w.asked()).toEqual([]);
    expect(addOn.getPublicKey).not.toHaveBeenCalled();
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("says nothing where there is no provider, and a tap does nothing", () => {
    render(
      <>
        <Person name="friend" who={FRIEND} />
        <Followed />
      </>,
    );

    expect(says("friend")).toBe("unknown");
    expect(followedNow()).toBeNull();
    tap("friend", "follow");
    tap("friend", "unfollow");
    tap("friend", "undo");
    expect(says("friend")).toBe("unknown");
  });
});

describe("a follow", () => {
  it("is saving from the tap until it has ended, and then following, just followed, with one entry more in the list", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT, friend: FRIEND }, { lists: true });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    const asked = asksFirst(addOn, SECRET);

    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));
    expect(says("stranger")).toBe("saving");
    // A button for someone else is as it was.
    expect(says("friend")).toBe("following");

    await asked.yes();
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(says("friend")).toBe("following");
    // The list every relay holds now is the old one and the one entry, and so is who is followed.
    for (const url of FOLLOW_RELAYS) {
      expect(w.relays[url]!.writer.published).toHaveLength(1);
      expect(newestOn(w, url)?.tags).toEqual([...LIST.tags, ["p", ABSENT]]);
      expect(newestOn(w, url)?.content).toBe(LIST.content);
    }
    expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ABSENT]);
  });

  it("has the list it is built on kept in the browser before the add-on is asked, as the relays sent it, with what the tap was for and when", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT, friend: FRIEND });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    expect(await keptCopies(ME)).toEqual([]);
    const asked = asksFirst(addOn, SECRET);
    const tapped = Math.floor(Date.now() / 1000);

    tap("stranger", "follow");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    // Kept already, while the person has yet to approve the change: the list as the relays hold it, byte for byte.
    const copies = await keptCopies(ME);
    expect(copies.map((copy) => [copy.list, copy.for])).toEqual([[asSent(LIST), { did: "follow", who: ABSENT }]]);
    expect(JSON.stringify(copies[0]!.list)).toBe(JSON.stringify(asSent(LIST)));
    expect(copies[0]!.at).toBeGreaterThanOrEqual(tapped);
    expect(copies[0]!.at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    await asked.yes();
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    // An unfollow keeps the list the follow saved, over it: the newest first.
    const followed = newestOn(w, NOS)!;
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toContain("not-following"));
    expect((await keptCopies(ME)).map((copy) => [copy.list.id, copy.for])).toEqual([
      [followed.id, { did: "unfollow", who: FRIEND }],
      [LIST.id, { did: "follow", who: ABSENT }],
    ]);
    // And Undo keeps the one the unfollow left.
    const unfollowed = newestOn(w, NOS)!;
    tap("friend", "undo");
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect((await keptCopies(ME)).map((copy) => [copy.list.id, copy.for])).toEqual([
      [unfollowed.id, { did: "undo", who: FRIEND }],
      [followed.id, { did: "unfollow", who: FRIEND }],
      [LIST.id, { did: "follow", who: ABSENT }],
    ]);
    // Nobody else's copies are there, nor any under another person's key.
    expect(await keptCopies(SOMEONE_ELSE)).toEqual([]);
  });

  it("is not started again by a tap while it is saving", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    const asked = asksFirst(addOn, SECRET);

    tap("stranger", "follow");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));
    tap("stranger", "follow");
    tap("stranger", "unfollow");
    tap("stranger", "undo");
    expect(says("stranger")).toBe("saving");

    await asked.yes();
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    await settle();
    // One change: the add-on was asked once, and each relay sent one list.
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    for (const url of FOLLOW_RELAYS) expect(w.relays[url]!.writer.published).toHaveLength(1);
    expect(says("stranger")).toBe("following just");
  });

  it("of a second person waits its turn behind the first, and both are in the list at the end", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { one: ABSENT, two: ALSO_ABSENT });
    await waitFor(() => expect(says("one")).toBe("not-following"));
    const asked = asksFirst(addOn, SECRET);

    tap("one", "follow");
    tap("two", "follow");
    expect(says("one")).toBe("saving");
    expect(says("two")).toBe("saving");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    await asked.yes();
    await waitFor(() => expect(says("two")).toBe("following just"));
    expect(says("one")).toBe("following just");
    // The second was built on the list the first saved: neither undid the other.
    expect(newestOn(w, NOS)?.tags).toEqual([...LIST.tags, ["p", ABSENT], ["p", ALSO_ABSENT]]);
  });

  it("shows on every button for that person on the page", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { onTheReview: ABSENT, inTheRail: ABSENT });
    await waitFor(() => expect(says("inTheRail")).toBe("not-following"));
    const asked = asksFirst(addOn, SECRET);

    tap("onTheReview", "follow");
    expect(says("inTheRail")).toBe("saving");
    // The other button's tap is a tap on the same change.
    tap("inTheRail", "follow");

    await asked.yes();
    await waitFor(() => expect(says("inTheRail")).toBe("following just"));
    expect(says("onTheReview")).toBe("following just");
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
  });

  it("can be made before the list has been read, and its end says who is followed", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    setDown(w, true);
    await openSignedIn(w, { stranger: ABSENT, friend: FRIEND }, { lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    expect(says("stranger")).toBe("unknown");

    // The relays are back, and no button has appeared since: the tap reads the list itself.
    setDown(w, false);
    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");

    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(says("friend")).toBe("following");
    expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ABSENT]);
  });

  it("keeps the list it saved when the first read of the list ends after it, with the older one", async () => {
    signedInAs(SECRET);
    // The relays take the changed list, and go on sending the old one.
    const w = everywhere([LIST], { lags: true });
    const answer = holdListReads(w);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));

    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("following trouble:unconfirmed just"));

    await answer.open();
    await settle();
    expect(says("stranger")).toBe("following trouble:unconfirmed just");
  });
});

describe("how a change ended, for the line under the button", () => {
  it("says the list could not be loaded, and nothing was signed", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    setDown(w, true);

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-loaded"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("says it was not approved when the add-on says no, and nothing was sent", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    addOn.signEvent.mockRejectedValueOnce(new Error("User rejected"));

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-approved"));
    expect(w.published()).toEqual([]);
  });

  it("says it was not saved when no relay takes the list", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST], { writes: { refuse: "blocked: not here" } });
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-saved"));
  });

  it("says it could not be checked when it was saved and not read back, and shows the new state", async () => {
    signedInAs(SECRET);
    // The relays take the changed list, and go on sending the old one.
    const w = everywhere([LIST], { lags: true });
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("following trouble:unconfirmed just"));
    for (const url of FOLLOW_RELAYS) expect(w.relays[url]!.writer.published).toHaveLength(1);
  });

  it("says the same of an unfollow that could not be checked, which can be undone all the same", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST], { lags: true });
    await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(says("friend")).toBe("following"));

    tap("friend", "unfollow");

    await waitFor(() => expect(says("friend")).toBe("not-following trouble:unconfirmed undo"));
  });

  it("says nothing when the person was followed already: nothing is signed, and the button is Following", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    // Another app has followed them since the list was read.
    const since = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME + 50, tags: [...LIST.tags, ["p", ABSENT]], content: LIST.content }, SECRET);
    nowHolding(w, [since]);

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
    expect(followedNow()).toEqual([...FOLLOWED_IN_LIST, ABSENT]);
  });

  it("is cleared by the next tap", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    addOn.signEvent.mockRejectedValueOnce(new Error("User rejected"));
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-approved"));
    const asked = asksFirst(addOn, SECRET);

    tap("stranger", "follow");
    expect(says("stranger")).toBe("saving");

    await asked.yes();
    await waitFor(() => expect(says("stranger")).toBe("following just"));
  });
});

describe("an unfollow, and Undo", () => {
  it("takes the person out at once, and can be undone for ten seconds", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { friend: FRIEND }, { lists: true });
    await waitFor(() => expect(says("friend")).toBe("following"));

    tap("friend", "unfollow");
    expect(says("friend")).toBe("saving");

    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    // Every other entry is as it was, in its place.
    expect(newestOn(w, NOS)?.tags).toEqual(LIST.tags.filter((_, place) => place !== FRIEND_AT));
    expect(followedNow()).toEqual(FOLLOWED_IN_LIST.filter((key) => key !== FRIEND));

    // Half of its time on, it is still offered. This clock moves with the machine's own too, so the
    // check is made with five seconds to spare, not one.
    await after(UNDO_MS / 2);
    expect(says("friend")).toBe("not-following undo");
    await after(UNDO_MS / 2);
    expect(says("friend")).toBe("not-following");
    // Too late: Undo does nothing now.
    tap("friend", "undo");
    await settle();
    expect(says("friend")).toBe("not-following");
    expect(addOn.signEvent).toHaveBeenCalledTimes(1);
    expect(UNDO_MS).toBe(10_000);
  });

  it("puts the person back when Undo is tapped in time, by the same safe change", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { friend: FRIEND }, { lists: true });
    await waitFor(() => expect(says("friend")).toBe("following"));
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe("not-following undo"));
    const asked = asksFirst(addOn, SECRET);

    tap("friend", "undo");
    // Nothing more to undo, from the tap on.
    expect(says("friend")).toBe("saving");

    await asked.yes();
    // Following again, and not just followed: nothing has changed for their circle (ruling R23).
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(addOn.signEvent).toHaveBeenCalledTimes(2);
    // Back in the list, where they were: every entry is as it was before the unfollow.
    expect(newestOn(w, NOS)?.tags).toEqual(LIST.tags);
    expect(followedNow()).toEqual(FOLLOWED_IN_LIST);
    // The ten seconds of the unfollow are over with it: nothing comes back later.
    await after(UNDO_MS);
    expect(says("friend")).toBe("following");
    tap("friend", "undo");
    await settle();
    expect(addOn.signEvent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the entry of a person the list wrote with a relay hint and a petname, with both", HINTED, [HINTED_AT]],
    ["both entries of a person the list names twice, the second with its hint and petname", DUPLICATED, [DUPLICATE_AT, DUPLICATE_AGAIN_AT]],
  ])("puts back %s, each where it was: the list is as before the unfollow, byte for byte (ruling R20)", async (_, who, places) => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { them: who }, { lists: true });
    await waitFor(() => expect(says("them")).toBe("following"));
    tap("them", "unfollow");
    await waitFor(() => expect(says("them")).toBe("not-following undo"));
    const left = newestOn(w, NOS)!;
    expect(left.tags).toEqual(LIST.tags.filter((_, place) => !places.includes(place)));

    tap("them", "undo");

    await waitFor(() => expect(says("them")).toBe("following"));
    for (const url of FOLLOW_RELAYS) {
      const back = newestOn(w, url)!;
      // The same tags in the same order, hint and petname among them, and the same content: only its time is later.
      expect(JSON.stringify(back.tags)).toBe(JSON.stringify(LIST.tags));
      expect(back.content).toBe(LIST.content);
      expect(back.created_at).toBeGreaterThan(left.created_at);
      expect(w.relays[url]!.writer.published).toEqual([left, back]);
    }
    // The add-on was asked for exactly that list, and for nothing else.
    expect(addOn.signEvent).toHaveBeenCalledTimes(2);
    expect(addOn.signEvent.mock.calls[1]![0]).toMatchObject({ kind: 3, content: LIST.content, tags: LIST.tags });
    expect(followedNow()).toEqual(FOLLOWED_IN_LIST);
  });

  it("puts the entry back at the end, as the list wrote it, when another app has changed the list since the unfollow", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { them: HINTED });
    await waitFor(() => expect(says("them")).toBe("following"));
    tap("them", "unfollow");
    await waitFor(() => expect(says("them")).toBe("not-following undo"));
    // Another app has taken out the list's first entry since: every place after it has moved.
    const left = newestOn(w, NOS)!;
    const since = finalizeEvent({ kind: 3, created_at: left.created_at + 1, tags: left.tags.slice(1), content: left.content }, SECRET);
    nowHolding(w, [since]);

    tap("them", "undo");

    await waitFor(() => expect(says("them")).toBe("following"));
    expect(newestOn(w, NOS)?.tags).toEqual([...since.tags, LIST.tags[HINTED_AT]]);
  });

  it("puts the entry back as it was at a tap of Follow in those ten seconds too: it is the same as Undo, and not a plain follow (ruling R28)", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { them: HINTED });
    await waitFor(() => expect(says("them")).toBe("following"));
    tap("them", "unfollow");
    await waitFor(() => expect(says("them")).toBe("not-following undo"));

    tap("them", "follow");
    expect(says("them")).toBe("saving");

    // Following, and not just followed, as after Undo: the list is as it was before the unfollow,
    // hint and petname in their place, and nothing was added at its end.
    await waitFor(() => expect(says("them")).toBe("following"));
    for (const url of FOLLOW_RELAYS) expect(JSON.stringify(newestOn(w, url)?.tags)).toBe(JSON.stringify(LIST.tags));
    tap("them", "undo");
    await settle();
    expect(says("them")).toBe("following");
    expect(addOn.signEvent).toHaveBeenCalledTimes(2);
  });

  it("follows as anyone is followed once those ten seconds are over: at the list's end, with nothing after the key", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { them: HINTED });
    await waitFor(() => expect(says("them")).toBe("following"));
    tap("them", "unfollow");
    await waitFor(() => expect(says("them")).toBe("not-following undo"));
    await after(UNDO_MS);
    expect(says("them")).toBe("not-following");

    tap("them", "follow");

    await waitFor(() => expect(says("them")).toBe("following just"));
    expect(newestOn(w, NOS)?.tags).toEqual([...LIST.tags.filter((_, place) => place !== HINTED_AT), ["p", HINTED]]);
  });

  it("offers no Undo before an unfollow, nor after one that changed nothing", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));

    tap("stranger", "undo");
    await settle();
    expect(says("stranger")).toBe("not-following");

    // They were not followed: nothing is taken out, so there is nothing to undo.
    tap("stranger", "unfollow");
    await waitFor(() => expect(listReads(w)).toEqual([2, 2, 2]));
    await settle();
    expect(says("stranger")).toBe("not-following");
    expect(addOn.signEvent).not.toHaveBeenCalled();
  });
});

describe("what a change left to say, for the page's visit (ruling R19)", () => {
  const BOTH = { stranger: ABSENT, another: ALSO_ABSENT };

  /**
   * A page where the person has followed the stranger, and a follow of another was not approved: one
   * line of each kind. `people` are its buttons, those of `BOTH` among them; `at` is its address.
   */
  async function oneFollowedAndOneNot(people: Record<string, string> = BOTH, at = "/") {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    const page = await openSignedIn(w, people);
    if (at !== "/") goTo(at);
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    addOn.signEvent.mockRejectedValueOnce(new Error("User rejected"));
    tap("another", "follow");
    await waitFor(() => expect(says("another")).toBe("not-following trouble:not-approved"));
    return { addOn, w, page };
  }

  it("is the same on every button for the person, and on one that appears later in the visit", async () => {
    const twice = { ...BOTH, strangerInTheRail: ABSENT, anotherInTheRail: ALSO_ABSENT };
    const { page } = await oneFollowedAndOneNot(twice);

    expect(says("strangerInTheRail")).toBe("following just");
    expect(says("anotherInTheRail")).toBe("not-following trouble:not-approved");

    // A button that was not there when the change ended: a list that grew, a dialog that opened.
    page.show({ ...twice, strangerLater: ABSENT, anotherLater: ALSO_ABSENT });
    expect(says("strangerLater")).toBe("following just");
    expect(says("anotherLater")).toBe("not-following trouble:not-approved");
    expect(says("stranger")).toBe("following just");
    expect(says("another")).toBe("not-following trouble:not-approved");
  });

  it("is kept by a button drawn anew on the page: a layout that changes, a row under another key, a button that shows someone else", async () => {
    const { page } = await oneFollowedAndOneNot();

    // The layout changes: every button goes, and is drawn anew.
    page.show({});
    page.show(BOTH);
    expect(says("stranger")).toBe("following just");
    expect(says("another")).toBe("not-following trouble:not-approved");

    // A row under another key.
    page.show({ rekeyed: ABSENT, another: ALSO_ABSENT });
    expect(says("rekeyed")).toBe("following just");

    // Two buttons that go on to show each other's person: the lines are the person's, not the button's.
    page.show({ rekeyed: ALSO_ABSENT, another: ABSENT });
    expect(says("rekeyed")).toBe("not-following trouble:not-approved");
    expect(says("another")).toBe("following just");
  });

  it("is ended by going to another page: the buttons are as the list has them, there and back", async () => {
    await oneFollowedAndOneNot();

    goTo("/elsewhere");
    expect(says("stranger")).toBe("following");
    expect(says("another")).toBe("not-following");

    goTo("/");
    expect(says("stranger")).toBe("following");
    expect(says("another")).toBe("not-following");
  });

  it("is kept while only what follows the address's path changes: it is the same page", async () => {
    await oneFollowedAndOneNot();

    goTo("/?sort=newest");
    goTo("/?sort=newest#reviews");

    expect(says("stranger")).toBe("following just");
    expect(says("another")).toBe("not-following trouble:not-approved");
  });

  it("is kept when the form that reviews a place opens over the place's page, and when it closes: they are one page (ruling R21)", async () => {
    await oneFollowedAndOneNot(BOTH, "/place/one");

    goTo("/place/one/review");
    expect(says("stranger")).toBe("following just");
    expect(says("another")).toBe("not-following trouble:not-approved");

    goTo("/place/one");
    expect(says("stranger")).toBe("following just");
    expect(says("another")).toBe("not-following trouble:not-approved");
  });

  it.each([
    ["from a place's page to another place's", "/place/one", "/place/two"],
    ["from the form that reviews a place to another place's page", "/place/one/review", "/place/two"],
    ["from the form that reviews a place to the form that reviews another", "/place/one/review", "/place/two/review"],
    ["from a place's page to the form that reviews another", "/place/one", "/place/two/review"],
    ["from the form that reviews a place to a page that is no place's", "/place/one/review", "/"],
  ])("is ended by going %s", async (_, from, to) => {
    await oneFollowedAndOneNot(BOTH, from);

    goTo(to);

    expect(says("stranger")).toBe("following");
    expect(says("another")).toBe("not-following");
  });

  it("is ended for a person by the next tap for them, on every button, and for nobody else", async () => {
    const { addOn } = await oneFollowedAndOneNot({ ...BOTH, anotherInTheRail: ALSO_ABSENT });
    const asked = asksFirst(addOn, SECRET);

    // What went wrong, by a tap on either button.
    tap("anotherInTheRail", "follow");
    expect(says("another")).toBe("saving");
    expect(says("anotherInTheRail")).toBe("saving");
    expect(says("stranger")).toBe("following just");
    await asked.yes();
    await waitFor(() => expect(says("another")).toBe("following just"));

    // And that a follow was just made: an unfollow that is not approved leaves them followed, and not just now.
    addOn.signEvent.mockRejectedValueOnce(new Error("User rejected"));
    tap("stranger", "unfollow");
    await waitFor(() => expect(says("stranger")).toBe("following trouble:not-approved"));
    expect(says("another")).toBe("following just");
  });

  it("is told on the page the person is on when a change ends, though it was asked for on another, until they leave that one", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    const asked = asksFirst(addOn, SECRET);
    tap("stranger", "follow");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    // Going to another page does not stop the change.
    goTo("/elsewhere");
    expect(says("stranger")).toBe("saving");

    await asked.yes();
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(newestOn(w, NOS)?.tags).toEqual([...LIST.tags, ["p", ABSENT]]);

    goTo("/");
    expect(says("stranger")).toBe("following");
  });

  it("does not end Undo, which has its ten seconds wherever the person goes", async () => {
    signedInAs(SECRET);
    // The relays take the changed list, and go on sending the old one: the unfollow could not be checked.
    const w = everywhere([LIST], { lags: true });
    await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(says("friend")).toBe("following"));
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toBe("not-following trouble:unconfirmed undo"));

    goTo("/elsewhere");

    expect(says("friend")).toBe("not-following undo");
    await after(UNDO_MS);
    expect(says("friend")).toBe("not-following");
  });

  it("goes with the session: the person who signs in after is told of their own changes only", async () => {
    await oneFollowedAndOneNot();

    tapSession("sign out");
    tapSession("sign in");
    // The list is read again, and has the stranger in it now.
    await waitFor(() => expect(says("stranger")).toBe("following"));
    expect(says("another")).toBe("not-following");

    tap("another", "follow");

    await waitFor(() => expect(says("another")).toBe("following just"));
    expect(says("stranger")).toBe("following");
  });

  it("is ended by the app's own shell, which tells the provider of each new page", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    const page = await openInShell(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("following just"));

    await page.goTo("/elsewhere");

    expect(says("stranger")).toBe("following");
  });
});

describe("what is one page for what a change left to say (ruling R21)", () => {
  it.each([
    ["a page and itself", "/", "/"],
    ["a place's page and itself", "/place/one", "/place/one"],
    ["a place's page and the form that reviews it", "/place/one", "/place/one/review"],
    ["the form that reviews a place and the place's page", "/place/one/review", "/place/one"],
    ["the same of a place whose name in the address is the form's", "/place/review", "/place/review/review"],
    ["the same of a place whose name is written with a code in it", "/place/caf%C3%A9%20one", "/place/caf%C3%A9%20one/review"],
  ])("takes %s for one page", (_, from, to) => {
    expect(sameVisit(from, to)).toBe(true);
  });

  it.each([
    ["two places' pages", "/place/one", "/place/two"],
    ["a place's page and the form that reviews another", "/place/one", "/place/two/review"],
    ["the forms that review two places", "/place/one/review", "/place/two/review"],
    ["the form that reviews a place and another place's page", "/place/one/review", "/place/two"],
    ["a place's page and Explore", "/place/one", "/"],
    ["Explore and a page under it that ends as the form does", "/", "/review"],
    ["a page that is no place's and one under it that ends as the form does", "/chain/one", "/chain/one/review"],
    ["a person's page and one under it that ends as the form does", "/person/one", "/person/one/review"],
    ["a place's page and a page under it that is not the form", "/place/one", "/place/one/reviews"],
    ["a place's page and a page two under it", "/place/one", "/place/one/review/review"],
    ["the form that reviews a place and a page under the form", "/place/one/review", "/place/one/review/review"],
    ["the places' address with no place and the form's under it", "/place/", "/place//review"],
    ["a place's page and the form's address written with a stroke after it", "/place/one", "/place/one/review/"],
  ])("takes %s for two pages", (_, from, to) => {
    expect(sameVisit(from, to)).toBe(false);
    expect(sameVisit(to, from)).toBe(false);
  });
});

describe("the relays still being sent a saved list", () => {
  /** The three follow-list relays, each holding the list, the last of them slow to take a changed one: until the gate is opened. */
  function withOneSlow() {
    const slow = gate();
    const w = world({
      [NOS]: relay([LIST]),
      [DIRECTORY]: relay([LIST]),
      [BIG]: relay([LIST], { writes: { until: slow.closed } }),
    });
    return { w, slow, sendToSlow: () => w.relays[BIG]!.writer.signals[0]! };
  }

  /** Follows the stranger, to the point where the change has ended and the slow relay has still not answered. */
  async function followedWithOneStillSending(w: World) {
    const page = await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    tap("stranger", "follow");
    await waitFor(() => expect(w.relays[BIG]!.writer.signals).toHaveLength(1));
    expect(says("stranger")).toBe("saving");
    await after(FOLLOW_SETTLE_MS);
    await waitFor(() => expect(says("stranger")).toBe("following just"));
    return page;
  }

  it("are not stopped when the change ends well, nor when the button goes: the slow one takes the list in its own time", async () => {
    signedInAs(SECRET);
    const { w, slow, sendToSlow } = withOneSlow();

    const page = await followedWithOneStillSending(w);
    expect(sendToSlow().aborted).toBe(false);

    page.show({});
    await settle();
    expect(sendToSlow().aborted).toBe(false);

    await slow.open();
    await settle();
    expect(sendToSlow().aborted).toBe(false);
    expect(newestOn(w, BIG)?.tags).toEqual([...LIST.tags, ["p", ABSENT]]);
  });

  it("are stopped when the person signs out", async () => {
    signedInAs(SECRET);
    const { w, sendToSlow } = withOneSlow();
    await followedWithOneStillSending(w);

    tapSession("sign out");

    expect(sendToSlow().aborted).toBe(true);
  });

  it("are stopped when the app goes away", async () => {
    signedInAs(SECRET);
    const { w, sendToSlow } = withOneSlow();
    const page = await followedWithOneStillSending(w);

    page.unmount();

    expect(sendToSlow().aborted).toBe(true);
  });
});

describe("signing out, and signing in as someone else", () => {
  it("forgets the list at sign-out, and gives up a change under way: what the add-on signs after is sent nowhere", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { friend: FRIEND, stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(says("friend")).toBe("following"));
    const asked = asksFirst(addOn, SECRET);
    tap("stranger", "follow");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    tapSession("sign out");

    expect(signedInNow()).toBe("nobody");
    expect(says("friend")).toBe("unknown");
    expect(says("stranger")).toBe("unknown");
    expect(followedNow()).toBeNull();

    await asked.yes();
    await settle();
    expect(w.published()).toEqual([]);
    expect(says("stranger")).toBe("unknown");
  });

  it("reads the list again for the person who signs in after", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(says("friend")).toBe("following"));

    tapSession("sign out");
    expect(says("friend")).toBe("unknown");
    tapSession("sign in");

    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([2, 2, 2]);
  });

  it("keeps the list of a person who signs in anew without signing out: it is theirs still, and is not read again", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { friend: FRIEND, stranger: ABSENT });
    await waitFor(() => expect(says("friend")).toBe("following"));

    tapSession("sign in");
    await waitFor(() => expect(addOn.getPublicKey).toHaveBeenCalledTimes(1));
    await settle();

    expect(says("friend")).toBe("following");
    expect(listReads(w)).toEqual([1, 1, 1]);
    // And their next change is made as any other.
    tap("stranger", "follow");
    await waitFor(() => expect(says("stranger")).toBe("following just"));
  });

  it("forgets one person's list for the next, with no sign-out between, and gives up the first's change", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    await openSignedIn(w, { friend: FRIEND, stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(says("friend")).toBe("following"));
    const asked = asksFirst(addOn, SECRET);
    tap("stranger", "follow");
    await waitFor(() => expect(addOn.signEvent).toHaveBeenCalledTimes(1));

    // The add-on is someone else's now, who signs in: they follow nobody, as every follow-list relay says.
    const theirs = installAddOn(OTHER_SECRET);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(SOMEONE_ELSE));

    await waitFor(() => expect(says("friend")).toBe("not-following"));
    expect(says("stranger")).toBe("not-following");
    expect(followedNow()).toEqual([]);
    expect(w.relays[NOS]!.asked.filter(asksForList).map((filter) => filter.authors)).toEqual([[ME], [ME], [SOMEONE_ELSE]]);

    // The first person's add-on answers after all: their change was given up, and nothing is sent.
    await asked.yes();
    await settle();
    expect(w.published()).toEqual([]);
    expect(theirs.signEvent).not.toHaveBeenCalled();
    expect(says("stranger")).toBe("not-following");
  });
});

describe("whose list it is (`useOwnFollowed`)", () => {
  it("gives the list with the person it is of: the same list the buttons have, and none while it is not read or nobody is signed in", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    const held = holdListReads(w);
    await openSignedIn(w, { friend: FRIEND }, { lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    expect(ownedNow()).toBeNull();

    await held.open();

    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(ownedNow()).toEqual({ owner: ME, followed: FOLLOWED_IN_LIST });
    // One object for as long as it is that list, and frozen: no page can change what another reads.
    expect(Object.isFrozen(ownedNow())).toBe(true);
    expect(Object.isFrozen(ownedNow()!.followed)).toBe(true);
    const before = ownedNow();
    tap("friend", "unfollow");
    await waitFor(() => expect(says("friend")).toContain("not-following"));
    expect(ownedNow()).not.toBe(before);
    expect(ownedNow()).toEqual({ owner: ME, followed: FOLLOWED_IN_LIST.filter((key) => key !== FRIEND) });

    tapSession("sign out");
    expect(ownedNow()).toBeNull();
  });

  it("is the next person's once theirs is read, with no sign-out between: never the list of the person before under the next person's name", async () => {
    signedInAs(SECRET);
    const theirList = buildFollowList(OTHER_SECRET);
    const w = everywhere([LIST, theirList]);
    await openSignedIn(w, { friend: FRIEND }, { lists: true });
    await waitFor(() => expect(ownedNow()?.owner).toBe(ME));

    installAddOn(OTHER_SECRET);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(SOMEONE_ELSE));

    await waitFor(() => expect(ownedNow()?.owner).toBe(SOMEONE_ELSE));
    expect(ownedNow()!.followed).toEqual(FOLLOWED_IN_LIST);
  });
});

describe("the list a change is built on", () => {
  const newer = () => buildFollowList(SECRET, FOLLOW_LIST_TIME + 100);

  it("is never older than the one on screen: a change that finds only an older one is not made (ruling R18)", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([newer()]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    // The relays that hold the list on screen are gone, and what answers has the one before it.
    nowHolding(w, [LIST]);

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("not-following trouble:not-loaded"));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is held to nothing a person saw before they signed out: the next to sign in starts as in a tab just opened", async () => {
    signedInAs(SECRET);
    const w = everywhere([newer()]);
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));

    tapSession("sign out");
    nowHolding(w, [LIST]);
    tapSession("sign in");
    await waitFor(() => expect(says("stranger")).toBe("not-following"));

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(newestOn(w, NOS)?.tags).toEqual([...LIST.tags, ["p", ABSENT]]);
  });
});

describe("a list that could not be read", () => {
  it("says nothing of anyone, asks again by itself at no time, and is read again when a button next appears", async () => {
    const addOn = signedInAs(SECRET);
    const w = everywhere([LIST]);
    setDown(w, true);
    const page = await openSignedIn(w, { friend: FRIEND }, { lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    expect(says("friend")).toBe("unknown");
    expect(followedNow()).toBeNull();

    setDown(w, false);
    await after(60_000);
    expect(listReads(w)).toEqual([1, 1, 1]);
    expect(says("friend")).toBe("unknown");

    page.show({ friend: FRIEND, stranger: ABSENT });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(says("stranger")).toBe("not-following");
    expect(listReads(w)).toEqual([2, 2, 2]);
    expect(followedNow()).toEqual(FOLLOWED_IN_LIST);
    // Reading it again is a read: nothing was signed, and no relay was sent anything.
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("is not read again for thirty seconds, however many buttons appear, and is by the first to appear after them (rulings R26 and R30)", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    setDown(w, true);
    const page = await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    expect(says("friend")).toBe("unknown");
    expect(FOLLOW_REREAD_MS).toBe(30_000);
    // The relays are back. Nothing has been asked of any of them since the read that failed.
    setDown(w, false);
    const asked = w.asked().length;

    // Buttons drawn anew inside the wait, as a view toggled or folded reviews opened draw them: no relay is asked for anything.
    page.show({ friend: FRIEND, stranger: ABSENT });
    page.show({});
    page.show({ friend: FRIEND, another: ALSO_ABSENT });
    await settle();
    await after(FOLLOW_REREAD_MS - 5_000);
    page.show({ friend: FRIEND, another: ALSO_ABSENT, late: UPPER_CASE_KEY });
    await settle();
    expect(w.asked()).toHaveLength(asked);
    for (const name of ["friend", "another", "late"]) expect(says(name)).toBe("unknown");

    // The wait over, nothing is read by itself: a page that stays open stays as it is.
    await after(5_000);
    await settle();
    expect(w.asked()).toHaveLength(asked);
    expect(says("friend")).toBe("unknown");

    // The next button to appear has the list read.
    page.show({ friend: FRIEND, another: ALSO_ABSENT, late: UPPER_CASE_KEY, last: ABSENT });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(says("last")).toBe("not-following");
    expect(listReads(w)).toEqual([2, 2, 2]);
  });

  it.each([
    ["back", -3_600_000],
    ["forward", 3_600_000],
  ])("counts the thirty seconds as they pass, not by what the device says the time is: a clock set %s an hour neither holds the list back nor has it read early", async (_, by) => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    setDown(w, true);
    const page = await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    setDown(w, false);

    // The device's clock is put right, or the person has travelled: the time it says jumps.
    vi.setSystemTime(Date.now() + by);
    // Inside the wait, as it passes: a button that appears has nothing read.
    await after(FOLLOW_REREAD_MS - 5_000);
    page.show({ friend: FRIEND, stranger: ABSENT });
    await settle();
    expect(listReads(w)).toEqual([1, 1, 1]);
    expect(says("friend")).toBe("unknown");

    // The wait over: the next to appear has the list read.
    await after(5_000);
    page.show({ friend: FRIEND, stranger: ABSENT, another: ALSO_ABSENT });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([2, 2, 2]);
  });

  it("is left unread again, for as long, after a second read that could not tell", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    setDown(w, true);
    const page = await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();

    await after(FOLLOW_REREAD_MS);
    page.show({ friend: FRIEND, stranger: ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual([2, 2, 2]));
    await settle();
    expect(says("friend")).toBe("unknown");

    // The wait is counted from the read that has just ended, not from the first.
    setDown(w, false);
    page.show({ friend: FRIEND, stranger: ABSENT, another: ALSO_ABSENT });
    await settle();
    expect(listReads(w)).toEqual([2, 2, 2]);
    await after(FOLLOW_REREAD_MS);
    page.show({ friend: FRIEND, stranger: ABSENT, another: ALSO_ABSENT, late: UPPER_CASE_KEY });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([3, 3, 3]);
  });

  it("is read at once for a new session, whoever it is for: the wait was the session's before", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    setDown(w, true);
    await openSignedIn(w, { friend: FRIEND });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    expect(says("friend")).toBe("unknown");
    setDown(w, false);

    // The same person, signed out and in again.
    tapSession("sign out");
    tapSession("sign in");
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([2, 2, 2]);

    // And someone else, whose own first read could not tell either, then signs out and in.
    setDown(w, true);
    installAddOn(OTHER_SECRET);
    tapSession("sign in");
    await waitFor(() => expect(signedInNow()).toBe(SOMEONE_ELSE));
    await waitFor(() => expect(listReads(w)).toEqual([3, 3, 3]));
    await settle();
    expect(says("friend")).toBe("unknown");
    setDown(w, false);
    tapSession("sign out");
    tapSession("sign in");
    await waitFor(() => expect(says("friend")).toBe("not-following"));
    expect(listReads(w)).toEqual([4, 4, 4]);
  });

  it("does not hold up a tap: a follow asked for inside the wait reads the list itself", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    setDown(w, true);
    await openSignedIn(w, { stranger: ABSENT, friend: FRIEND });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    setDown(w, false);

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe("following just"));
    expect(says("friend")).toBe("following");
  });

  it("is not taken for an empty one when too few of the follow-list relays answer with nothing", async () => {
    signedInAs(SECRET);
    // One of the three is down: the two that answer have no list, and the one that holds it may be the third.
    const w = everywhere([]);
    w.relays[BIG]!.down = true;

    await openSignedIn(w, { stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();

    expect(says("stranger")).toBe("unknown");
    expect(followedNow()).toBeNull();
  });

  it("is an empty one when enough of them answer with nothing: the person follows nobody", async () => {
    signedInAs(SECRET);
    const w = everywhere([]);

    await openSignedIn(w, { stranger: ABSENT }, { lists: true });

    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    expect(followedNow()).toEqual([]);
  });

  it("is the list one relay sent, though the others are down", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    w.relays[NOS]!.down = true;
    w.relays[BIG]!.down = true;

    await openSignedIn(w, { friend: FRIEND });

    await waitFor(() => expect(says("friend")).toBe("following"));
  });
});

describe("a read of the person's own list that cannot be trusted (rulings R43, R44 and R45)", () => {
  /** The person's list as it was years ago, which names `EARLY` and not the friend; one of the app's relays still holds it. */
  const EARLY = pubkeyAt(1);
  const yearsOld = finalizeEvent({ kind: 3, created_at: FOLLOW_LIST_TIME - 60 * 60 * 24 * 900, content: "", tags: [["p", EARLY], ["p", pubkeyAt(2)]] }, SECRET);
  /** Their relay list: they write to a relay of their own. */
  const theirs = shapedEvent({ kind: 10002, pubkey: ME, tags: [["r", OWN, "write"]] });
  const SIX = [NOS, DIRECTORY, BIG, "wss://fourth.example.test", "wss://fifth.example.test", "wss://sixth.example.test"];
  /** How many times each relay that keeps relay lists was asked for the person's. */
  const relayListReads = (w: World) => [w.reviews, w.relays[DIRECTORY]!].map((each) => each.asked.filter(asksForRelayList).length);
  /** Every request any relay had for a follow list of the person's own. */
  const listAsks = (w: World) => w.asked().filter((filter) => asksForList(filter) && filter["#p"] === undefined);

  /**
   * Scenario A. The person's newest list and their relay list are on the relay they write to and on
   * the directory; one of the app's relays holds the copy years old. The directory is out.
   */
  function directoryOutWithAnOldCopy(): World {
    const w = world({ [NOS]: relay([yearsOld]), [DIRECTORY]: relay([LIST, theirs]), [BIG]: relay(), [OWN]: relay([LIST, theirs]) });
    w.relays[DIRECTORY]!.down = true;
    return w;
  }

  it("leaves the list unknown when the relay list could not be read: the old copy one of the app's relays holds is not shown, and no relay is asked for the list (scenario A)", async () => {
    const addOn = signedInAs(SECRET);
    const w = directoryOutWithAnOldCopy();

    const page = await openSignedIn(w, { friend: FRIEND, early: EARLY, stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(relayListReads(w)).toEqual([1, 1]));
    await settle();

    // Nobody is said to be followed or not: not by the old copy, which names one of them, nor by anything.
    for (const name of ["friend", "early", "stranger"]) expect(says(name)).toBe("unknown");
    expect(followedNow()).toBeNull();
    expect(ownedNow()).toBeNull();
    expect(listAsks(w)).toEqual([]);
    expect(w.relays[OWN]!.asked).toEqual([]);

    // It is a read that could not tell, as any: nothing is asked again for thirty seconds, whatever appears.
    const asked = w.asked().length;
    w.relays[DIRECTORY]!.down = false;
    page.show({ friend: FRIEND, early: EARLY, stranger: ABSENT, another: ALSO_ABSENT });
    await settle();
    await after(FOLLOW_REREAD_MS - 1_000);
    expect(w.asked()).toHaveLength(asked);
    expect(says("another")).toBe("unknown");

    // The wait over, the next button has it read again: the directory answers, and the list is the one on the relay they write to.
    await after(1_000);
    page.show({ friend: FRIEND, early: EARLY, stranger: ABSENT, another: ALSO_ABSENT, late: UPPER_CASE_KEY });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(says("early")).toBe("following");
    expect(says("stranger")).toBe("not-following");
    expect(followedNow()).toEqual(FOLLOWED_IN_LIST);
    // It read, both times: nothing was signed, and no relay was sent anything.
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("does not take a person for one who follows nobody when the relay list could not be read, though enough relays answer with nothing (scenario B)", async () => {
    signedInAs(SECRET);
    config.followListRelays = [...SIX];
    const others = Object.fromEntries(SIX.filter((url) => url !== DIRECTORY).map((url) => [url, relay()]));
    const w = world({ ...others, [DIRECTORY]: relay(), [OWN]: relay([LIST, theirs]) });
    w.relays[DIRECTORY]!.down = true;

    const page = await openSignedIn(w, { stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(relayListReads(w)).toEqual([1, 1]));
    await settle();

    // No button says Follow: a tap on one would start a list of one entry in the person's name.
    expect(says("stranger")).toBe("unknown");
    expect(followedNow()).toBeNull();
    expect(listAsks(w)).toEqual([]);

    // The same five relays' nothing is believed once the directory answers that there is no relay list.
    w.relays[DIRECTORY]!.down = false;
    await after(FOLLOW_REREAD_MS);
    page.show({ stranger: ABSENT, another: ALSO_ABSENT });
    await waitFor(() => expect(says("stranger")).toBe("not-following"));
    expect(followedNow()).toEqual([]);
  });

  it("leaves the list unknown when the relay list is read and the relay it writes to does not answer: what the other relays sent is not shown (scenario C)", async () => {
    signedInAs(SECRET);
    const w = world({ [NOS]: relay([yearsOld]), [DIRECTORY]: relay([theirs]), [BIG]: relay(), [OWN]: relay([LIST]) });
    w.relays[OWN]!.down = true;

    const page = await openSignedIn(w, { friend: FRIEND, early: EARLY, stranger: ABSENT }, { lists: true });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();

    // The app's relays answered, one of them with the old copy: none of it is shown.
    for (const name of ["friend", "early", "stranger"]) expect(says(name)).toBe("unknown");
    expect(followedNow()).toBeNull();

    // Their relay is back: once the wait is over, the next button has the list read from it.
    w.relays[OWN]!.down = false;
    await after(FOLLOW_REREAD_MS);
    page.show({ friend: FRIEND, early: EARLY, stranger: ABSENT, another: ALSO_ABSENT });
    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(followedNow()).toEqual(FOLLOWED_IN_LIST);
  });

  it.each([
    // Too few of the app's relays hold it for the person to be asked about it: nothing is shown.
    ["two of the app's relays hold it, and nothing is shown", [LIST], [], "unknown"],
    // Every one holds it: it is shown, as a copy the person has not agreed to (tests/followProviderAsk.test.tsx).
    ["all three hold it, and the buttons draw from it", [LIST], [LIST], "not-following"],
  ])("takes the list a read found for one this tab has seen, though the read could not be trusted: a change that finds only an older list is not made (%s)", async (_, most, third, shown) => {
    const addOn = signedInAs(SECRET);
    // The relay they write to is out; the app's relays hold a list.
    const w = world({ [NOS]: relay(most), [DIRECTORY]: relay([...most, theirs]), [BIG]: relay(third), [OWN]: relay() });
    w.relays[OWN]!.down = true;
    await openSignedIn(w, { stranger: ABSENT });
    await waitFor(() => expect(listReads(w)).toEqual([1, 1, 1]));
    await settle();
    expect(says("stranger")).toBe(shown);

    // Their relay answers now, and every relay holds an older list than the one the page's read found.
    // The change's own read is one to trust, and has missed a list this tab knows of: it stops.
    const older = buildFollowList(SECRET, FOLLOW_LIST_TIME - 100);
    for (const url of FOLLOW_RELAYS) w.relays[url]!.held.splice(0, Number.POSITIVE_INFINITY, older, theirs);
    w.relays[OWN]!.down = false;
    w.relays[OWN]!.held.push(older);

    tap("stranger", "follow");

    await waitFor(() => expect(says("stranger")).toBe(`${shown} trouble:not-loaded`));
    expect(addOn.signEvent).not.toHaveBeenCalled();
    expect(w.published()).toEqual([]);
  });

  it("shows the list when the relay list is found and one relay it writes to answers, though another is out", async () => {
    signedInAs(SECRET);
    const ALSO_OWN = "wss://also-own.example.test";
    const both = shapedEvent({ kind: 10002, pubkey: ME, tags: [["r", ALSO_OWN, "write"], ["r", OWN, "write"]] });
    const w = world({ [NOS]: relay([yearsOld]), [DIRECTORY]: relay([both]), [BIG]: relay(), [ALSO_OWN]: relay(), [OWN]: relay([LIST]) });
    w.relays[ALSO_OWN]!.down = true;

    await openSignedIn(w, { friend: FRIEND, stranger: ABSENT });

    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(says("stranger")).toBe("not-following");
  });

  it("reads the relay list in the time a change gives it: each relay six seconds, and then the list", async () => {
    signedInAs(SECRET);
    const w = everywhere([LIST]);
    // The review relay never answers for the relay list: the directory answers that there is none.
    w.reviews.reader = {
      async *req() {
        await new Promise<never>(() => {});
      },
    };

    await openSignedIn(w, { friend: FRIEND });
    await settle();
    expect(listReads(w)).toEqual([0, 0, 0]);
    await after(FOLLOW_READ_MS - 1_000);
    expect(listReads(w)).toEqual([0, 0, 0]);
    expect(says("friend")).toBe("unknown");

    await after(1_000);

    await waitFor(() => expect(says("friend")).toBe("following"));
    expect(listReads(w)).toEqual([1, 1, 1]);
  });
});

describe("where the provider is", () => {
  it("is inside the account's provider and the scores' in main.tsx: they give it who is signed in, and the relays", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const at = (text: string) => main.indexOf(text);
    for (const outer of ["ScoresProvider", "AccountProvider"]) {
      expect(at(`<${outer}>`)).toBeGreaterThan(-1);
      expect(at(`<${outer}>`)).toBeLessThan(at("<FollowProvider>"));
      expect(at("</FollowProvider>")).toBeLessThan(at(`</${outer}>`));
    }
  });
});
